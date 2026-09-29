import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Run } from '@jian/contracts';
import { commandEnvironment } from './shell.js';
import { confined, workspaceOf } from './workspace.js';

const execute = promisify(execFile);
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
const directory = async (path: string) => {
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(path)).isDirectory()) throw new Error('Worker repository directory is invalid');
};

/** Prepare committed source trees without giving a worker write access to another worktree. */
export async function prepareWorkerWorkspace(run: Run): Promise<{
  readOnly: string[];
  writable: string[];
}> {
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
  const gitAccess = { readOnly: [] as string[], writable: [] as string[] };

  for (const [index, asked] of (run.subagent.repositories ?? []).entries()) {
    const source = await realpath(asked);
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
    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
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
