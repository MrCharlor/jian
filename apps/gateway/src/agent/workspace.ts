import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, readlink, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Each profile with the shell switch on works in a directory of its own, and nowhere else.
 *
 * The directory is the profile's `HOME`: its repositories, Git and `gh` logins, SSH keys and
 * per-user installs live there, and its `TMPDIR` too. Two mechanisms hold the line:
 *
 * - A command runs under `jian-sandbox`, which asks the kernel (Landlock) to allow writes in
 *   that directory only, reads of the system's tools besides, and nothing else — not another
 *   profile's directory, not the gateway's files, not the gateway's process in /proc. Landlock
 *   needs no privilege, so it works where user namespaces and a second container do not:
 *   Kubernetes, PaaS hosts, a container with no-new-privileges.
 * - The file tools, `send_file` and `save_file` run inside the gateway, not in a command, so
 *   the same line is checked here: the real path, symlinks resolved, and for a file actually
 *   opened, the path of the open descriptor.
 *
 * A kernel without Landlock (before 5.13, or with it left out of the LSM list) still gets the
 * separate directory and the checks on the file tools, but its commands are not confined; the
 * gateway says so in its log once. The network is not confined either way.
 */

/** A profile id names a directory, so it must be nothing but an id. */
const PROFILE_ID = /^[0-9a-f-]{36}$/;

export function workerWorkspacePath(profileId: string, workerId: string): string {
  if (!PROFILE_ID.test(profileId) || !PROFILE_ID.test(workerId)) {
    throw new Error('Invalid worker workspace id');
  }
  return join(workspacesRoot(), '_workers', profileId, workerId);
}

/** The system a profile may read: its programs, libraries and configuration. */
const SYSTEM = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/etc',
  '/opt',
  // macOS resolves /etc through /private; the file tools check the resolved path.
  ...(process.platform === 'darwin' ? ['/private/etc'] : []),
];

/**
 * A command also reads /proc and /sys, which runtimes ask for their CPU count and their own
 * state. Landlock refuses a sandboxed process the private files of any process outside its
 * sandbox (`environ`, `mem`, `fd`), so the gateway's stay closed.
 */
const COMMAND_READS = [...SYSTEM, '/proc', '/sys', '/dev'];

/** The devices a shell writes to. /dev/shm is left out: it would be shared between profiles. */
const DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/tty',
  '/dev/ptmx',
  '/dev/pts',
];

/** Where the workspaces live; a volume should be mounted over it (or over the home above). */
export function workspacesRoot(): string {
  return resolve(process.env.JIAN_WORKSPACES || join(homedir(), 'workspaces'));
}

/** The profile's directory, created on first use and readable by this user alone. */
export async function workspaceOf(profileId: string, workerId?: string): Promise<string> {
  if (!PROFILE_ID.test(profileId)) {
    throw new Error('Invalid profile id');
  }

  const home = join(workspacesRoot(), profileId);

  await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });

  if (!workerId) return realpath(home);
  if (!PROFILE_ID.test(workerId)) throw new Error('Invalid worker id');

  const workers = join(workspacesRoot(), '_workers');
  await mkdir(workers, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(workers)).isDirectory()) throw new Error('Invalid worker workspace root');

  const owner = join(workers, profileId);
  await mkdir(owner, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(owner)).isDirectory()) throw new Error('Invalid worker workspace owner');

  const worker = workerWorkspacePath(profileId, workerId);
  await mkdir(worker, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(worker)).isDirectory()) throw new Error('Invalid worker workspace');
  const temporary = join(worker, 'tmp');
  await mkdir(temporary, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (!(await lstat(temporary)).isDirectory())
    throw new Error('Invalid worker temporary directory');

  return realpath(worker);
}

const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);

/** The real path of something that may not exist yet: symlinks of the part that exists, resolved. */
async function realOf(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);

  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      const parent = dirname(current);

      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) {
        throw error;
      }

      missing.push(basename(current));
      current = parent;
    }
  }
}

export type Access = 'read' | 'write';

function assertWithin(real: string, home: string, access: Access, asked: string) {
  const allowed = access === 'write' ? [home] : [home, ...SYSTEM];

  if (!allowed.some((root) => inside(real, root))) {
    throw new Error(
      access === 'write'
        ? `${asked} is outside your workspace. Write only under ${home}`
        : `${asked} is outside your workspace. Read only under ${home}, or the system directories (${SYSTEM.join(', ')})`,
    );
  }
}

/** The real path, refused when it leads out of what the profile may reach. */
export async function confine(
  profileId: string,
  path: string,
  access: Access,
  workerId?: string,
): Promise<string> {
  const home = await workspaceOf(profileId, workerId);
  const real = await realOf(path);

  assertWithin(real, home, access, path);

  return real;
}

/**
 * Checked again on the descriptor: a symlink swapped in after `confine` would otherwise send the
 * gateway to a file the profile may not touch. Where /proc is missing (a development machine
 * that is not Linux) the path check is all there is.
 */
async function assertOpened(
  handle: FileHandle,
  profileId: string,
  access: Access,
  path: string,
  workerId?: string,
) {
  const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined);

  if (opened !== undefined) {
    assertWithin(opened, await workspaceOf(profileId, workerId), access, path);
  }
}

/** Opens a file to read, only when it is within reach. The caller closes it. */
export async function openToRead(
  profileId: string,
  path: string,
  workerId?: string,
): Promise<FileHandle> {
  const real = await confine(profileId, path, 'read', workerId);
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    await assertOpened(handle, profileId, 'read', path, workerId);
  } catch (error) {
    await handle.close();
    throw error;
  }

  return handle;
}

/**
 * Writes a whole file inside the workspace, creating its folders. `exclusive` refuses a file
 * that already exists. The file is truncated only after the descriptor is known to be inside.
 */
export async function writeInWorkspace(
  profileId: string,
  path: string,
  data: string | Uint8Array,
  { exclusive = false, workerId }: { exclusive?: boolean; workerId?: string } = {},
): Promise<string> {
  const real = await confine(profileId, path, 'write', workerId);

  await mkdir(dirname(real), { recursive: true });

  const handle = await open(
    real,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      (exclusive ? constants.O_EXCL : 0),
    0o644,
  );

  try {
    await assertOpened(handle, profileId, 'write', path, workerId);
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }

  return real;
}

/** Where the confinement helper is; the image builds it into this path. */
const helper = () => process.env.JIAN_SANDBOX || '/usr/local/bin/jian-sandbox';

const probes = new Map<string, Promise<number>>();

/** The Landlock ABI commands are confined with, or 0 when they cannot be. Asked once per helper. */
export function sandboxAbi(): Promise<number> {
  const path = helper();
  let probe = probes.get(path);

  if (!probe) {
    probe = new Promise<number>((done) => {
      execFile(path, ['--abi'], { timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
        const abi = error ? 0 : Number.parseInt(stdout.trim(), 10) || 0;

        if (abi < 1) {
          console.warn(
            `Shell commands run without Landlock confinement: ${error ? `${path} is not available` : 'this kernel does not offer it'}. Each profile keeps its own directory, but a command can read what the gateway's user can.`,
          );
        }

        done(abi);
      });
    });
    probes.set(path, probe);
  }

  return probe;
}

/**
 * The program and arguments that run `program` confined to `home`, or unchanged when this
 * kernel offers no confinement.
 */
export async function confined(
  home: string,
  program: string,
  args: string[],
  extra: { readOnly?: string[]; writable?: string[] } = {},
): Promise<{ file: string; args: string[] }> {
  if ((await sandboxAbi()) < 1) {
    return { file: program, args };
  }

  return {
    file: helper(),
    args: [
      ...[...COMMAND_READS, ...(extra.readOnly ?? [])].flatMap((path) => ['--ro', path]),
      ...[home, ...DEVICES, ...(extra.writable ?? [])].flatMap((path) => ['--rw', path]),
      '--',
      program,
      ...args,
    ],
  };
}
