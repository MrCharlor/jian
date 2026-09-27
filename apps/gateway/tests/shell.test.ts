import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { Decisions } from '../src/decisions/service.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

async function toolsFor(allowShell: boolean, jev?: () => Response) {
  const services = await testServices();
  const decisions = new Decisions(
    services.store,
    services.gatewayVault,
    async () => jev?.() ?? Response.json({}),
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

  return profileTools({ ...services, decisions, store: services.store }, run);
}

const call = async (tool: unknown, input: unknown) =>
  (tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });

describe('running commands on the machine the gateway runs on', () => {
  it('hands out nothing unless the owner turned it on for this profile', async () => {
    const off = await toolsFor(false);

    expect(off.run_command).toBeUndefined();
    expect(off.read_file).toBeUndefined();
    expect(off.write_file).toBeUndefined();
    expect(off.list_directory).toBeUndefined();

    expect((await toolsFor(true)).run_command).toBeDefined();
  });

  it('reports what a command printed and how it ended', async () => {
    const tools = await toolsFor(true);

    expect(await call(tools.run_command, { command: 'echo oi', timeoutMs: 5000 })).toMatchObject({
      exitCode: 0,
      stdout: 'oi\n',
    });

    // A failure is a result to read, not an error that ends the run.
    expect(await call(tools.run_command, { command: 'exit 3', timeoutMs: 5000 })).toMatchObject({
      exitCode: 3,
    });
  });

  it("keeps the gateway's credentials out of a command's environment", async () => {
    const tools = await toolsFor(true);
    const planted = {
      DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic',
      JIAN_MASTER_KEYS: '{"synthetic":"c3ludGhldGlj"}',
      OPENAI_API_KEY: 'sk-synthetic',
    };
    const before = { ...process.env };

    Object.assign(process.env, planted, { LC_ALL: 'C.UTF-8' });

    try {
      const { stdout } = (await call(tools.run_command, { command: 'env', timeoutMs: 5000 })) as {
        stdout: string;
      };
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

  it('reads, writes and lists real paths', async () => {
    const tools = await toolsFor(true);
    const directory = mkdtempSync(join(tmpdir(), 'jian-shell-'));
    const file = join(directory, 'nota.txt');

    writeFileSync(file, 'primeira linha\n');

    expect(await call(tools.read_file, { path: file, offset: 1, limit: 2000 })).toMatchObject({
      totalLines: 1,
      content: '1\tprimeira linha',
    });

    await call(tools.write_file, { path: file, content: 'segunda' });

    expect(readFileSync(file, 'utf8')).toBe('segunda');
    expect(await call(tools.list_directory, { path: directory })).toMatchObject({
      entries: [{ name: 'nota.txt', kind: 'file' }],
    });
  });

  it('refuses a relative path, which would mean whatever the worker happened to be in', async () => {
    const tools = await toolsFor(true);
    const schema = (
      tools.read_file as { inputSchema: { safeParse(i: unknown): { success: boolean } } }
    ).inputSchema;

    expect(schema.safeParse({ path: 'package.json' }).success).toBe(false);
    expect(schema.safeParse({ path: '/etc/hosts' }).success).toBe(true);
  });
});

describe('working on code', () => {
  const workspace = () => {
    const directory = mkdtempSync(join(tmpdir(), 'jian-code-'));
    const file = join(directory, 'app.ts');

    writeFileSync(file, 'const a = 1;\nconst b = 2;\nconst c = 1;\n');

    return { directory, file };
  };

  const read = (tools: Record<string, unknown>, path: string) =>
    call(tools.read_file, { path, offset: 1, limit: 2000 });

  const edit = (tools: Record<string, unknown>, path: string, edits: unknown[]) =>
    call(tools.edit_file, { path, edits });

  it('changes only the passage named, and refuses one that is missing or ambiguous', async () => {
    const tools = await toolsFor(true);
    const { file } = workspace();

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
    const tools = await toolsFor(true);
    const { file } = workspace();

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
    const tools = await toolsFor(true);
    const { file } = workspace();

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
    const { utimesSync } = await import('node:fs');
    utimesSync(file, later, later);

    await expect(edit(tools, file, [{ oldString: 'const a', newString: 'let a' }])).rejects.toThrow(
      'changed since you read it',
    );
  });

  it('keeps the line endings a file already uses', async () => {
    const tools = await toolsFor(true);
    const { directory } = workspace();
    const file = join(directory, 'windows.txt');

    writeFileSync(file, 'one\r\ntwo\r\n');
    await read(tools, file);
    await edit(tools, file, [{ oldString: 'one\ntwo', newString: 'one\nTWO' }]);

    expect(readFileSync(file, 'utf8')).toBe('one\r\nTWO\r\n');
  });

  it('finds files by name and text across a tree, skipping dependencies', async () => {
    const tools = await toolsFor(true);
    const { directory, file } = workspace();
    const { mkdirSync } = await import('node:fs');

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
    const dir = mkdtempSync(join(tmpdir(), 'jian-guard-'));
    const file = join(dir, 'keep.txt');
    const risky = () => Response.json({ answers: { answer: { type: 'noul', noul: 0.95 } } });
    const tools = await toolsFor(true, risky);

    writeFileSync(file, 'dados');

    expect(await call(tools.run_command, { command: `rm ${file}`, timeoutMs: 5000 })).toMatchObject(
      { held: expect.stringContaining('Held back') },
    );
    expect(readFileSync(file, 'utf8')).toBe('dados');
  });

  it('runs as before when Jev sees no risk, has no key, or does not answer', async () => {
    const safe = () => Response.json({ answers: { answer: { type: 'noul', noul: 0.05 } } });
    const down = () => new Response('overloaded', { status: 529 });

    // Each set of tools is used before the next is built: every test store starts empty.
    for (const jev of [safe, undefined, down]) {
      const tools = await toolsFor(true, jev);

      expect(await call(tools.run_command, { command: 'echo oi', timeoutMs: 5000 })).toMatchObject({
        exitCode: 0,
        stdout: 'oi\n',
      });
    }
  });
});
