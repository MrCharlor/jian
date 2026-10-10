import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Draws a screen in Claude Design, in the owner's account, and answers with the canvas link.
 * The Claude Code on this machine has no tool that writes there; a Claude Code routine in the
 * cloud has, so this one fills the routine with the request, fires it and reads how it ended.
 */
export type CloudDesigner = (job: {
  prompt: string;
  folder: string;
  signal: AbortSignal;
  /** A GitHub repository the session opens as its source: where the prints are. */
  source?: string;
  /** The application's own model; the routine's default otherwise. */
  model?: string;
}) => Promise<{ ok: true; url: string; summary: string } | { ok: false; error: string }>;

/** The line the cloud session starts its answer with, so the link survives a cut log. */
export const RESULT_MARK = 'ATENA_RESULT';

type Run = (
  prompt: string,
  folder: string,
  tools: string[],
  signal: AbortSignal,
) => Promise<{ code: number | null; output: string }>;

const CALL_MS = 4 * 60_000;

/** The Claude Code CLI once, headless, with only the tools named; its answer is the output. */
const runClaude: Run = (prompt, folder, tools, signal) =>
  new Promise((resolve) => {
    const binary = process.env.JIAN_CLAUDE_BIN || join(homedir(), '.local', 'bin', 'claude');
    const child = spawn(
      binary,
      ['-p', prompt, '--allowedTools', ...tools, '--output-format', 'text'],
      {
        cwd: folder,
        env: {
          HOME: process.env.HOME ?? homedir(),
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const keep = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-20_000);
    };
    const stop = () => child.kill('SIGTERM');
    const timer = setTimeout(stop, CALL_MS);

    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      resolve({ code, output });
    });
  });

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * What a routine run looks like to the cloud: one user message, and the prints repository when
 * there are prints. Without prints there is no repository, so a gateway whose owner never linked
 * GitHub to Claude still draws.
 */
export function routineBody(prompt: string, environmentId: string, model: string, source?: string) {
  return {
    job_config: {
      ccr: {
        environment_id: environmentId,
        session_context: {
          model,
          sources: source ? [{ git_repository: { url: source } }] : [],
          allowed_tools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'ToolSearch',
            'Artifact',
            'ArtifactComments',
          ],
        },
        events: [
          {
            data: {
              uuid: randomUUID(),
              session_id: '',
              type: 'user',
              parent_tool_use_id: null,
              message: { role: 'user', content: prompt },
            },
          },
        ],
      },
    },
  };
}

/** Reads the answer of a poll: the canvas link, still running, or why it failed. */
export function readPoll(
  output: string,
):
  | { state: 'done'; url: string; summary: string }
  | { state: 'pending' }
  | { state: 'failed'; error: string } {
  const done = output.match(
    new RegExp(`${RESULT_MARK}\\s+(https://claude\\.ai/(?:code/)?artifact/[\\w-]+)([^\\n]*)`),
  );

  if (done?.[1]) return { state: 'done', url: done[1], summary: (done[2] ?? '').trim() };

  const failed = output.match(/ATENA_ERRO\s*([\s\S]{0,800})/);

  // Anything else, a hiccup of the look itself included, is read as not finished yet.
  return failed
    ? { state: 'failed', error: (failed[1] ?? '').trim() || 'no answer' }
    : { state: 'pending' };
}

/**
 * The routine named by `routineId` runs the request; the cloud session ends its answer with
 * `ATENA_RESULT <link>`. The first look comes after the shortest drawing seen so far, then
 * every 45 seconds until the limit.
 */
export function claudeRoutine(options: {
  routineId: string;
  environmentId: string;
  model?: string;
  limitMs?: number;
  run?: Run;
  pause?: typeof wait;
}): CloudDesigner {
  const run = options.run ?? runClaude;
  const pause = options.pause ?? wait;
  const limit = options.limitMs ?? 25 * 60_000;

  return async ({ prompt, folder, signal, source, model }) => {
    await writeFile(
      join(folder, 'rotina.json'),
      JSON.stringify(
        routineBody(
          prompt,
          options.environmentId,
          model ?? options.model ?? 'claude-sonnet-5-5',
          source,
        ),
      ),
    );

    const fired = await run(
      `Leia o arquivo rotina.json desta pasta. Chame a ferramenta RemoteTrigger com action "update", trigger_id "${options.routineId}" e body igual ao JSON do arquivo, sem mudar nada. Depois chame RemoteTrigger com action "run" e o mesmo trigger_id. Responda só com uma linha: SESSION seguido do session_id que o run devolveu.`,
      folder,
      ['Read', 'RemoteTrigger', 'ToolSearch'],
      signal,
    );
    const session = fired.output.match(/SESSION\s+(cse_\w+|session_\w+)/)?.[1];

    if (!session) {
      return { ok: false, error: `The routine did not start: ${fired.output.trim().slice(-600)}` };
    }

    const deadline = Date.now() + limit;
    let delay = 120_000;

    while (Date.now() < deadline && !signal.aborted) {
      await pause(delay, signal);
      delay = 45_000;

      const polled = await run(
        `Chame a ferramenta RemoteTrigger com action "get_run_log" e session_id "${session}". Se o log tem uma linha "result:", responda exatamente a linha do resultado que começa com ${RESULT_MARK}; se o resultado não tem ${RESULT_MARK}, responda ATENA_ERRO seguido do texto do resultado. Se ainda não há linha "result:", responda só PENDENTE.`,
        folder,
        ['RemoteTrigger', 'ToolSearch'],
        signal,
      );
      const answer = readPoll(polled.output);

      if (answer.state === 'done') return { ok: true, url: answer.url, summary: answer.summary };
      if (answer.state === 'failed') return { ok: false, error: answer.error };
    }

    return { ok: false, error: `The cloud drawing (${session}) did not finish in time` };
  };
}
