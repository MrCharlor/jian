import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { fileTools } from './files.js';
import type { Guard } from './guard.js';

/**
 * Running commands on the machine the gateway runs on, with the file tools beside them.
 *
 * There is no sandbox and no allow-list of directories: the owner asked for the whole machine,
 * and these tools run with the privileges of whoever started the gateway. What bounds them is
 * the profile switch that hands them out at all — everything here is off unless `allowShell`
 * is on for that profile.
 *
 * Read this as what it is: anyone who can make this agent act — including an approved contact
 * on a chat channel — can make it run a command. The limits below are about keeping a run
 * alive and its results readable, not about containment. A `guard`, when given, is asked before
 * each action that changes the machine; it is a second opinion, not a boundary.
 *
 * One thing is kept from a command: the gateway's own environment. It holds the database DSN,
 * the keyring and the host token, and a test or a script run from a project would otherwise
 * pick them up — a database test aimed at the gateway's own PostgreSQL. So a command starts
 * with the variables `commandEnvironment` passes and nothing else. That prevents accidents; it
 * is not containment, since the command runs as the same user as the gateway.
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

/** What a shell needs to find its tools, its home and its locale — no credential among them. */
const PASSED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'TMPDIR',
  'HOSTNAME',
  'SSH_AUTH_SOCK',
  // Where the image puts per-user installs, and the flag the machine-tools skill checks.
  'GOPATH',
  'NPM_CONFIG_PREFIX',
  'JIAN_TOOLBOX',
]);

/**
 * The environment a command starts with: an allow-list, so a variable added to the gateway later
 * stays out by default. `NODE_ENV` is left out on purpose — the gateway's `production` would
 * make a project's install skip its dev dependencies.
 */
export function commandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && (PASSED.has(name) || name.startsWith('LC_'))) {
      env[name] = value;
    }
  }

  return env;
}

function clip(text: string, limit: number): string {
  return text.length > limit
    ? `${text.slice(0, limit)}\n… ${text.length - limit} caracteres omitidos`
    : text;
}

/** The tools whose action changes the machine, and so pass the guard first. */
const GUARDED = ['run_command', 'write_file', 'edit_file'];

export function shellTools(guard?: Guard): ToolSet {
  const tools: ToolSet = {
    run_command: tool({
      description:
        'Run a command on the machine this gateway runs on and read what it printed. Prefer a single command over a shell pipeline you cannot inspect. Anything destructive needs the owner to have asked for it in this conversation.',
      inputSchema: z.object({
        command: z.string().trim().min(1).max(4000),
        cwd: absolute.optional(),
        timeoutMs: z.number().int().min(1000).max(TIMEOUT_MS).default(30_000),
      }),
      execute: async ({ command, cwd, timeoutMs }) =>
        new Promise((resolvePromise) => {
          execFile(
            '/bin/sh',
            ['-c', command],
            {
              cwd,
              env: commandEnvironment(),
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
        }),
    }),

    ...fileTools(),
  };

  if (!guard) {
    return tools;
  }

  for (const name of GUARDED) {
    const original = tools[name];
    const execute = original?.execute;

    if (original && execute) {
      tools[name] = {
        ...original,
        execute: async (input, options) => {
          const held = await guard(name, input);

          return held ? { held } : execute(input, options);
        },
      };
    }
  }

  return tools;
}
