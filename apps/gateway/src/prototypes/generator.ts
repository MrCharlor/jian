import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** What turns a prepared folder into `prototipo.html`, or says why it could not. */
export type Generator = (
  folder: string,
  prompt: string,
  signal: AbortSignal,
) => Promise<{ ok: true } | { ok: false; error: string }>;

/** Long enough for a full screen with a few rounds of self-correction; a stuck run ends. */
const LIMIT_MS = 15 * 60_000;

/** Only what the Claude Code CLI needs; the gateway's database and keys never reach it. */
function environment(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? homedir(),
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
  };
}

/**
 * Runs the Claude Code CLI once, headless, in the prototype's folder, signed in with the
 * account the owner logged in on this machine (`/login`, kept under the home volume). It may
 * read, write and edit files and nothing else: no shell, no web.
 */
export const claudeCode: Generator = (folder, prompt, signal) =>
  new Promise((resolve) => {
    const binary = process.env.JIAN_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
    const child = spawn(
      binary,
      [
        '-p',
        prompt,
        '--allowedTools',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        '--permission-mode',
        'acceptEdits',
        '--output-format',
        'text',
      ],
      { cwd: folder, env: environment(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-4000);
    };
    const timer = setTimeout(() => child.kill('SIGTERM'), LIMIT_MS);
    const abort = () => child.kill('SIGTERM');

    signal.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Claude Code could not start: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);

      if (code === 0) resolve({ ok: true });
      else
        resolve({
          ok: false,
          error: `Claude Code ended with ${code ?? 'a signal'}: ${output.trim().slice(-600) || 'no output'}`,
        });
    });
  });
