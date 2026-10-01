import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Run } from '@jian/contracts';
import { commandEnvironment } from './shell.js';
import { confined, workerWorkspacePath, workspaceOf } from './workspace.js';

const execute = promisify(execFile);
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const missing = async (path: string) =>
  lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
const directory = async (path: string) => {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(path)).isDirectory()) throw new Error('Worker repository directory is invalid');
};

export type WorkerGitAccess = {
  readOnly: string[];
  writable: string[];
  sshCommand?: string;
  ghConfigDir?: string;
};

async function sharedSsh(home: string, profileHome: string, access: WorkerGitAccess) {
  const ssh = join(profileHome, '.ssh');
  const entry = await missing(ssh);
  if (!entry) return;
  if (!entry.isDirectory() || !inside(await realpath(ssh), profileHome)) {
    throw new Error('Profile SSH directory must stay inside its workspace');
  }

  const workerSsh = join(home, '.ssh');
  await directory(workerSsh);
  const knownHosts = join(ssh, 'known_hosts');
  if ((await missing(knownHosts))?.isFile() && !(await missing(join(workerSsh, 'known_hosts')))) {
    await copyFile(knownHosts, join(workerSsh, 'known_hosts'));
  }
  const keys: string[] = [];
  for (const entry of await readdir(ssh, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(ssh, entry.name);
    const handle = await open(path, 'r');
    try {
      const header = Buffer.alloc(80);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(header.toString('utf8', 0, bytesRead))) {
        keys.push(path);
      }
    } finally {
      await handle.close();
    }
  }
  access.readOnly.push(ssh);
  const config = join(ssh, 'config');
  access.sshCommand = [
    '/usr/bin/ssh',
    ...((await missing(config))?.isFile() ? ['-F', config] : []),
    '-o',
    `UserKnownHostsFile=${join(workerSsh, 'known_hosts')}`,
    ...keys.flatMap((key) => ['-i', key]),
  ]
    .map(quote)
    .join(' ');
}

/** Prepare committed source trees without giving a worker write access to another worktree. */
export async function prepareWorkerWorkspace(run: Run): Promise<WorkerGitAccess> {
  if (!run.subagent) return { readOnly: [], writable: [] };

  const home = await workspaceOf(run.profileId, run.id);
  const profileHome = await workspaceOf(run.profileId);
  const env = { ...commandEnvironment(home), GIT_OPTIONAL_LOCKS: '0' };
  const git = async (args: string[]) => {
    const command = await confined(home, '/usr/bin/git', args, { readOnly: [profileHome] });
    return (
      await execute(command.file, command.args, {
        cwd: home,
        env,
        timeout: 30_000,
        maxBuffer: 100_000,
      })
    ).stdout.trim();
  };
  const gitAccess: WorkerGitAccess = { readOnly: [], writable: [] };
  const config = join(profileHome, '.config');
  await directory(config);
  gitAccess.ghConfigDir = join(config, 'gh');
  gitAccess.writable.push(config);
  await sharedSsh(home, profileHome, gitAccess);

  for (const [index, asked] of (run.subagent.repositories ?? []).entries()) {
    let source: string;
    try {
      source = await realpath(asked);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error(
          `Repository ${index + 1} cannot be accessed at ${asked}; use a Git root inside this profile's workspace, not /root or another user's directory`,
        );
      }
      if (code === 'ENOENT') {
        throw new Error(`Repository ${index + 1} does not exist at ${asked}`);
      }
      throw error;
    }
    if (!inside(source, profileHome) || !(await stat(source)).isDirectory()) {
      throw new Error(`Repository ${index + 1} must be inside this agent's workspace`);
    }
    if ((await git(['-C', source, 'rev-parse', '--show-toplevel'])) !== source) {
      throw new Error(`Repository ${index + 1} must name its Git root`);
    }
    const common = await realpath(
      await git(['-C', source, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    if (!inside(common, profileHome)) {
      throw new Error(`Repository ${index + 1} has Git metadata outside the workspace`);
    }
    if (await git(['-C', source, 'status', '--porcelain'])) {
      throw new Error(
        `Repository ${index + 1} has uncommitted changes; a worktree would omit them`,
      );
    }

    const repositories = join(home, 'repos');
    await directory(repositories);
    const parent = join(repositories, String(index + 1));
    const target = join(parent, basename(source));
    await directory(parent);
    const existing = await missing(target);
    if (existing) {
      if (
        !existing.isDirectory() ||
        (await git(['-C', target, 'rev-parse', '--show-toplevel'])) !== target ||
        (await realpath(
          await git(['-C', target, 'rev-parse', '--path-format=absolute', '--git-common-dir']),
        )) !== common
      ) {
        throw new Error(`Worker repository ${index + 1} is not its expected worktree`);
      }
    } else {
      const command = await confined(
        home,
        '/usr/bin/git',
        ['-C', source, 'worktree', 'add', '--detach', target, 'HEAD'],
        { readOnly: [source], writable: [common] },
      );
      await execute(command.file, command.args, {
        cwd: home,
        env,
        timeout: 120_000,
        maxBuffer: 100_000,
      });
    }
    const admin = await realpath(
      await git(['-C', target, 'rev-parse', '--path-format=absolute', '--git-dir']),
    );
    if (!inside(admin, join(common, 'worktrees'))) {
      throw new Error(`Worker repository ${index + 1} has unexpected Git metadata`);
    }
    gitAccess.readOnly.push(common);
    gitAccess.writable.push(await realpath(join(common, 'objects')), admin);
  }

  return gitAccess;
}

/** Remove only this run's detached trees after its task and every worker have finished. */
export async function removeWorkerWorkspace(
  profileId: string,
  workerId: string,
  repositories: string[],
): Promise<void> {
  const home = workerWorkspacePath(profileId, workerId);
  const entry = await missing(home);
  if (!entry) return;
  if (!entry.isDirectory()) throw new Error('Worker workspace is not a directory');
  const profileHome = await workspaceOf(profileId);

  for (const [index, asked] of repositories.entries()) {
    const source = await realpath(asked);
    if (!inside(source, profileHome)) throw new Error('Worker repository left its profile');
    const target = join(home, 'repos', String(index + 1), basename(source));
    const tree = await missing(target);
    if (!tree) continue;
    if (!tree.isDirectory()) throw new Error('Worker worktree is not a directory');
    const common = await realpath(
      (
        await execute('/usr/bin/git', [
          '-C',
          source,
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).stdout.trim(),
    );
    const actual = await realpath(
      (
        await execute('/usr/bin/git', [
          '-C',
          target,
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).stdout.trim(),
    );
    if (common !== actual || !inside(common, profileHome)) {
      throw new Error('Worker worktree does not belong to its repository');
    }
    await execute('/usr/bin/git', ['-C', source, 'worktree', 'remove', '--force', target], {
      timeout: 120_000,
    });
  }
  await rm(home, { recursive: true, force: true });
}
