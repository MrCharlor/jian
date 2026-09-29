import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { fileTools } from './files.js';
import { confine, confined, workspaceOf } from './workspace.js';

/**
 * Running commands on the machine the gateway runs on, with the file tools beside them.
 *
 * What bounds them first is the profile switch that hands them out at all — everything here is
 * off unless `allowShell` is on for that profile. Anyone who can make this agent act, including
 * an approved contact on a chat channel, can make it run a command. The runtime puts a guard in
 * front of each action that changes the machine (see guard.ts); it is a second opinion, not a
 * boundary.
 *
 * The boundary is the profile's workspace (see workspace.ts): a command starts there, with it as
 * `HOME` and `TMPDIR`, confined by Landlock to it and to the system's tools. It also starts
 * without the gateway's environment, which holds the database DSN, the keyring and the host
 * token: a test run from a project would otherwise pick them up — a database test aimed at the
 * gateway's own PostgreSQL. The two cover each other: Landlock keeps the gateway's files and
 * /proc closed, and the allow-list keeps its secrets out of the command, even where Landlock is
 * missing.
 */

/** Long enough for a build, short enough that a run does not die waiting on a hung command. */
const TIMEOUT_MS = 120_000;
/** Output past this is cut; a command that prints a megabyte would cost the run its context. */
const MAX_OUTPUT = 60_000;

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), 'Use an absolute path');

/** What a shell needs to find its tools and its locale — no credential among them. */
const PASSED = new Set([
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'HOSTNAME',
  // The flag the machine-tools skill checks to know it is in the Jian image.
  'JIAN_TOOLBOX',
]);

/**
 * The environment a command starts with: an allow-list, so a variable added to the gateway later
 * stays out by default, with the home, temporary directory and per-user install paths moved
 * into the profile's workspace. `NODE_ENV` is left out on purpose — the gateway's `production`
 * would make a project's install skip its dev dependencies.
 */
export function commandEnvironment(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (PASSED.has(name) || name.startsWith('LC_'))) {
      env[name] = value;
    }
  }

  // The image puts the gateway's own per-user bin folders on PATH; the profile's replace them.
  const gatewayHome = source.HOME;
  const system = (source.PATH ?? '/usr/local/bin:/usr/bin:/bin')
    .split(':')
    .filter((entry) => entry && !(gatewayHome && entry.startsWith(gatewayHome)));

  return {
    ...env,
    HOME: home,
    TMPDIR: join(home, 'tmp'),
    GOPATH: join(home, 'go'),
    NPM_CONFIG_PREFIX: join(home, '.local'),
    PATH: [join(home, '.local', 'bin'), join(home, 'go', 'bin'), ...system].join(':'),
  };
}

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… ${text.length - limit} caracteres omitidos`
    : text;
}

export function shellTools(
  profileId: string,
  workerId?: string,
  gitAccess: { readOnly: string[]; writable: string[] } = { readOnly: [], writable: [] },
): ToolSet {
  return {
    run_command: tool({
      description:
        'Run a command on the machine this gateway runs on and read what it printed. It starts in your workspace, which is also $HOME, and can write only there. Prefer a single command over a shell pipeline you cannot inspect. Anything destructive needs the owner to have asked for it in this conversation.',
      inputSchema: z.object({
        command: z.string().trim().min(1).max(4000),
        cwd: absolute.optional(),
        timeoutMs: z.number().int().min(1000).max(TIMEOUT_MS).default(30_000),
      }),
      execute: async ({ command, cwd, timeoutMs }) => {
        const home = await workspaceOf(profileId, workerId);
        const directory = cwd ? await confine(profileId, cwd, 'read', workerId) : home;
        const shell = await confined(home, '/bin/sh', ['-c', command], gitAccess);

        return new Promise((resolvePromise) => {
          execFile(
            shell.file,
            shell.args,
            {
              cwd: directory,
              env: commandEnvironment(home),
              timeout: timeoutMs,
              maxBuffer: MAX_OUTPUT * 4,
              encoding: 'utf8',
            },
            (error, stdout, stderr) => {
              const status = (error as { code?: unknown } | null)?.code;

              resolvePromise({
                // Zero is success; a string here is a signal, such as a command that timed out.
                exitCode: typeof status === 'number' ? status : status ? String(status) : 0,
                stdout: clip(stdout, MAX_OUTPUT),
                stderr: clip(stderr, MAX_OUTPUT),
              });
            },
          );
        });
      },
    }),

    ...fileTools(profileId, workerId),
  };
}
