import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ACTION_KINDS, actionGuard, guardTools } from '../src/agent/guard.js';
import { profileTools } from '../src/agent/tools.js';
import { sandboxAbi } from '../src/agent/workspace.js';
import { Decisions } from '../src/decisions/service.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

// Every profile of this file works under a throwaway root, never under the real home.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-workspaces-')));
const saved = {
  JIAN_WORKSPACES: process.env.JIAN_WORKSPACES,
  JIAN_SANDBOX: process.env.JIAN_SANDBOX,
};

process.env.JIAN_WORKSPACES = root;

/**
 * The helper the image ships, built from its source when a compiler is here. Without one, or on
 * a kernel without Landlock, the tests that need the kernel's confinement are skipped and say so.
 */
function buildHelper(): string {
  const binary = join(root, 'jian-sandbox');

  if (process.platform !== 'linux') return join(root, 'no-linux-sandbox');

  try {
    execFileSync('cc', [
      '-O2',
      '-o',
      binary,
      fileURLToPath(new URL('../native/jian-sandbox.c', import.meta.url)),
    ]);
  } catch {
    return join(root, 'no-compiler');
  }

  return binary;
}

process.env.JIAN_SANDBOX = buildHelper();

const kernelConfines = (await sandboxAbi()) > 0;

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

/** A synthetic Jev that gives every question it is asked the same probability of yes. */
const everyNoul =
  (risk: number, asked = 0) =>
  (init?: RequestInit) => {
    const { questions } = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> };

    return Response.json({
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [
          id,
          { type: 'noul', noul: id === 'asked' ? asked : risk },
        ]),
      ),
    });
  };

async function toolsFor(allowShell: boolean, jev?: (init?: RequestInit) => Response) {
  const services = await testServices();
  const decisions = new Decisions(
    services.store,
    services.gatewayVault,
    async (_input, init) => jev?.(init) ?? Response.json({}),
    () => {},
  );

  if (jev) {
    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });
  }

  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
    allowShell,
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Shell' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Oi',
    requestKey: 'one',
  });

  const tools = profileTools({ ...services, decisions, store: services.store }, run);

  // As the runtime does once the whole set is known.
  guardTools(tools, actionGuard(decisions.judge, run), (name) => ACTION_KINDS[name]);

  return { tools, home: join(root, profile.id) };
}

const call = async (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });

const sh = async (tool: unknown, command: string) =>
  (await call(tool, { command, timeoutMs: 10_000 })) as {
    exitCode: number | string;
    stdout: string;
    stderr: string;
  };

describe('running commands on the machine the gateway runs on', () => {
  it('hands out nothing unless the owner turned it on for this profile', async () => {
    const { tools: off } = await toolsFor(false);

    expect(off.run_command).toBeUndefined();
    expect(off.read_file).toBeUndefined();
    expect(off.write_file).toBeUndefined();
    expect(off.list_directory).toBeUndefined();

    expect((await toolsFor(true)).tools.run_command).toBeDefined();
  });

  it('reports what a command printed and how it ended', async () => {
    const { tools } = await toolsFor(true);

    expect(await sh(tools.run_command, 'echo oi')).toMatchObject({ exitCode: 0, stdout: 'oi\n' });

    // A failure is a result to read, not an error that ends the run.
    expect(await sh(tools.run_command, 'exit 3')).toMatchObject({ exitCode: 3 });
  });

  it('starts in the profile workspace, which is its home and holds its temporary files', async () => {
    const { tools, home } = await toolsFor(true);

    expect(await sh(tools.run_command, 'pwd; echo "$HOME"; echo "$TMPDIR"')).toMatchObject({
      exitCode: 0,
      stdout: `${home}\n${home}\n${join(home, 'tmp')}\n`,
    });
  });

  it("keeps the gateway's credentials out of a command's environment", async () => {
    const { tools } = await toolsFor(true);
    const planted = {
      DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
      JIAN_MASTER_KEYS: '{"synthetic":"c3ludGhldGlj"}',
      OPENAI_API_KEY: 'sk-synthetic',
    };
    const before = { ...process.env };

    Object.assign(process.env, planted, { LC_ALL: 'C.UTF-8' });

    try {
      const { stdout } = await sh(tools.run_command, 'env');
      const names = stdout.split('\n').map((line) => line.split('=')[0]);

      for (const name of Object.keys(planted)) {
        expect(names).not.toContain(name);
      }
      // The runtime's mode stays out too, and a shell still finds its tools and its locale.
      expect(names).not.toContain('NODE_ENV');
      expect(names).toContain('PATH');
      expect(names).toContain('LC_ALL');
    } finally {
      for (const name of [...Object.keys(planted), 'LC_ALL']) {
        if (before[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = before[name];
        }
      }
    }
  });

  it.skipIf(!kernelConfines)(
    "keeps a command out of another profile's workspace and the gateway's process",
    async () => {
      const mine = await toolsFor(true);
      const theirs = await toolsFor(true);
      const secret = join(theirs.home, 'id_ed25519');

      await sh(theirs.tools.run_command, 'echo private > id_ed25519');
      expect(readFileSync(secret, 'utf8')).toBe('private\n');

      // Its own workspace is open to it.
      expect(await sh(mine.tools.run_command, 'echo mine > notes && cat notes')).toMatchObject({
        exitCode: 0,
        stdout: 'mine\n',
      });

      // Another profile's is not, neither to read nor to write, and not through a link.
      expect((await sh(mine.tools.run_command, `cat ${secret}`)).exitCode).not.toBe(0);
      expect(
        (await sh(mine.tools.run_command, `echo x > ${theirs.home}/planted`)).exitCode,
      ).not.toBe(0);
      expect(
        (await sh(mine.tools.run_command, `ln -s ${secret} link && cat link`)).stdout,
      ).not.toContain('private');

      // Nor the gateway: its environment in /proc, and files beside the workspaces.
      expect(
        (await sh(mine.tools.run_command, `cat /proc/${process.pid}/environ`)).exitCode,
      ).not.toBe(0);
      writeFileSync(join(root, 'gateway-file'), 'gateway');
      expect(
        (await sh(mine.tools.run_command, `cat ${join(root, 'gateway-file')}`)).exitCode,
      ).not.toBe(0);

      // The system's tools still run.
      expect(await sh(mine.tools.run_command, 'ls /usr/bin >/dev/null && echo ok')).toMatchObject({
        exitCode: 0,
        stdout: 'ok\n',
      });
    },
  );

  it('reads, writes and lists paths in the workspace', async () => {
    const { tools, home } = await toolsFor(true);
    const file = join(home, 'nota.txt');

    await call(tools.write_file, { path: file, content: 'primeira linha\n' });

    expect(await call(tools.read_file, { path: file, offset: 1, limit: 2000 })).toMatchObject({
      totalLines: 1,
      content: '1\tprimeira linha',
    });

    await call(tools.write_file, { path: file, content: 'segunda' });

    expect(readFileSync(file, 'utf8')).toBe('segunda');
    expect(await call(tools.list_directory, { path: home })).toMatchObject({
      entries: expect.arrayContaining([{ name: 'nota.txt', kind: 'file' }]),
    });
  });

  it("keeps the file tools in the workspace, links included, while the system's files stay readable", async () => {
    const mine = await toolsFor(true);
    const theirs = await toolsFor(true);
    const secret = join(theirs.home, 'secret.txt');

    // A workspace is made on first use; neither profile has used one yet.
    mkdirSync(mine.home, { recursive: true });
    mkdirSync(theirs.home, { recursive: true });
    writeFileSync(secret, 'private');
    symlinkSync(secret, join(mine.home, 'link.txt'));

    const read = (path: string) => call(mine.tools.read_file, { path, offset: 1, limit: 10 });

    await expect(read(secret)).rejects.toThrow('outside your workspace');
    await expect(read(join(mine.home, 'link.txt'))).rejects.toThrow('outside your workspace');
    await expect(read('/proc/self/environ')).rejects.toThrow('outside your workspace');
    await expect(
      call(mine.tools.write_file, { path: join(theirs.home, 'planted.txt'), content: 'x' }),
    ).rejects.toThrow('outside your workspace');
    await expect(call(mine.tools.list_directory, { path: theirs.home })).rejects.toThrow(
      'outside your workspace',
    );
    await expect(read('/etc/hosts')).resolves.toMatchObject({ path: realpathSync('/etc/hosts') });
  });

  it('refuses a relative path, which would mean whatever the worker happened to be in', async () => {
    const { tools } = await toolsFor(true);
    const schema = (
      tools.read_file as { inputSchema: { safeParse(i: unknown): { success: boolean } } }
    ).inputSchema;

    expect(schema.safeParse({ path: 'package.json' }).success).toBe(false);
    expect(schema.safeParse({ path: '/etc/hosts' }).success).toBe(true);
  });
});

describe('working on code', () => {
  const workspace = async () => {
    const { tools, home } = await toolsFor(true);
    const directory = join(home, 'project');
    const file = join(directory, 'app.ts');

    mkdirSync(directory, { recursive: true });
    writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 1;\n');

    return { tools, directory, file };
  };

  const read = (tools: Record<string, unknown>, path: string) =>
    call(tools.read_file, { path, offset: 1, limit: 2000 });

  const edit = (tools: Record<string, unknown>, path: string, edits: unknown[]) =>
    call(tools.edit_file, { path, edits });

  it('changes only the passage named, and refuses one that is missing or ambiguous', async () => {
    const { tools, file } = await workspace();

    await read(tools, file);
    await edit(tools, file, [{ oldString: 'const b = 2;', newString: 'const b = 3;' }]);

    expect(readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 3;\nconst c = 1;\n');

    await expect(edit(tools, file, [{ oldString: '= 1;', newString: '= 9;' }])).rejects.toThrow(
      'appears 2 times',
    );
    await expect(
      edit(tools, file, [{ oldString: 'const z', newString: 'const y' }]),
    ).rejects.toThrow('not in the file');

    await edit(tools, file, [{ oldString: '= 1;', newString: '= 9;', replaceAll: true }]);

    expect(readFileSync(file, 'utf8')).toBe('const a = 9;\nconst b = 3;\nconst c = 9;\n');
  });

  it('applies a batch of edits all or nothing', async () => {
    const { tools, file } = await workspace();

    await read(tools, file);
    await expect(
      edit(tools, file, [
        { oldString: 'const a', newString: 'let a' },
        { oldString: 'missing', newString: 'x' },
      ]),
    ).rejects.toThrow('Edit 2');

    expect(readFileSync(file, 'utf8')).toBe('const a = 1;\nconst b = 2;\nconst c = 1;\n');
  });

  it('changes a file only as this run read it', async () => {
    const { tools, file } = await workspace();

    await expect(edit(tools, file, [{ oldString: 'const a', newString: 'let a' }])).rejects.toThrow(
      'Read the file',
    );
    await expect(call(tools.write_file, { path: file, content: 'x' })).rejects.toThrow(
      'Read the file',
    );

    await read(tools, file);
    // Someone else writes it in the meantime: the edit would be computed against old text.
    writeFileSync(file, 'const a = 5;\n');
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);

    await expect(edit(tools, file, [{ oldString: 'const a', newString: 'let a' }])).rejects.toThrow(
      'changed since you read it',
    );
  });

  it('keeps the line endings a file already uses', async () => {
    const { tools, directory } = await workspace();
    const file = join(directory, 'windows.txt');

    writeFileSync(file, 'one\r\ntwo\r\n');
    await read(tools, file);
    await edit(tools, file, [{ oldString: 'one\ntwo', newString: 'one\nTWO' }]);

    expect(readFileSync(file, 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('finds files by name and text across a tree, skipping dependencies', async () => {
    const { tools, directory, file } = await workspace();

    mkdirSync(join(directory, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(directory, 'node_modules', 'dep', 'index.ts'), 'const b = 2;\n');
    await call(tools.write_file, {
      path: join(directory, 'src', 'deep.ts'),
      content: 'export {};\n',
    });

    const found = (await call(tools.find_files, {
      pattern: '**/*.ts',
      path: directory,
      limit: 50,
    })) as { files: string[] };

    expect(found.files.sort()).toEqual([file, join(directory, 'src', 'deep.ts')].sort());

    expect(
      await call(tools.search_files, {
        pattern: 'const b',
        path: directory,
        ignoreCase: false,
        contextLines: 0,
        output: 'content',
        limit: 50,
      }),
    ).toEqual({ matches: `${file}:2:const b = 2;` });
  });

  it('holds back an action Jev judges destructive, and runs nothing', async () => {
    const { tools, home } = await toolsFor(true, everyNoul(0.95));
    const file = join(home, 'keep.txt');

    mkdirSync(home, { recursive: true });
    writeFileSync(file, 'dados');

    expect(await sh(tools.run_command, `rm ${file}`)).toMatchObject({
      held: expect.stringContaining('Held back'),
    });
    expect(readFileSync(file, 'utf8')).toBe('dados');
  });

  it('runs when Jev sees no risk, has no key, does not answer, or the request asked for it', async () => {
    const safe = everyNoul(0.05);
    const down = () => new Response('overloaded', { status: 529 });

    // Each set of tools is used before the next is built: every test store starts empty.
    for (const jev of [safe, undefined, down, everyNoul(0.95, 0.95)]) {
      const { tools } = await toolsFor(true, jev);

      expect(await sh(tools.run_command, 'echo oi')).toMatchObject({
        exitCode: 0,
        stdout: 'oi\n',
      });
    }
  });
});
