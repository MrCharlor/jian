import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CloudDesigner,
  claudeRoutine,
  readPoll,
  routineBody,
} from '../src/prototypes/cloud.js';
import { PrintsRepository, printFileName } from '../src/prototypes/prints-repo.js';
import { Prototypes } from '../src/prototypes/service.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { testServices } from './helpers/services.js';

const CANVAS = 'https://claude.ai/artifact/PyqcscVZZHysNHDXPfTsPq';

describe('a prototype drawn in Claude Design', () => {
  it('sends the request to the cloud, keeps the canvas link, and redraws the same canvas', async () => {
    const services = await testServices();
    await services.applications.create({
      slug: 'erp',
      name: 'VXCASE ERP',
      designUrl: 'https://claude.ai/artifact/8e9cc99a-3fe8-4b82-aeea-aa3ec251f8e2',
    });
    await services.applications.put('erp', [
      { path: 'project/README.md', data: Buffer.from('# ERP', 'utf8') },
    ]);
    const prompts: string[] = [];
    const designer: CloudDesigner = async ({ prompt }) => {
      prompts.push(prompt);
      return { ok: true, url: CANVAS, summary: 'Listagem com filtro.' };
    };
    const prototypes = new Prototypes(
      services.store,
      services.applications,
      services.quality,
      async () => ({ ok: false, error: 'the local generator must not run' }),
      await mkdtemp(join(tmpdir(), 'jian-cloud-')),
    );
    prototypes.useDesigner(designer);

    const created = await prototypes.create(
      { application: 'erp', title: 'Cores de Aparelhos', brief: 'Listagem das cores.' },
      { kind: 'owner' },
    );
    await prototypes.drain();

    expect(await prototypes.get(created.id)).toMatchObject({
      designUrl: CANVAS,
      versions: [{ number: 1, status: 'ready' }],
    });
    expect(prompts[0]).toContain('8e9cc99a-3fe8-4b82-aeea-aa3ec251f8e2');
    expect(prompts[0]).toContain('Crie um artefato privado do tipo Design');

    await prototypes.redo(created.id, { comments: 'Tire a coluna Código.' });
    await prototypes.drain();

    expect(prompts[1]).toContain(`Atualize o artefato Design ${CANVAS}`);
    expect(prompts[1]).toContain('Tire a coluna Código.');
  });

  it('sends the prints through the repository, and draws from the text when they cannot go', async () => {
    const services = await testServices();
    await services.applications.create({
      slug: 'erp',
      name: 'VXCASE ERP',
      designUrl: 'https://claude.ai/artifact/8e9cc99a-3fe8-4b82-aeea-aa3ec251f8e2',
    });
    await services.applications.put('erp', [
      { path: 'project/README.md', data: Buffer.from('# ERP', 'utf8') },
    ]);
    const jobs: { prompt: string; source?: string }[] = [];
    const prototypes = new Prototypes(
      services.store,
      services.applications,
      services.quality,
      async () => ({ ok: false, error: 'the local generator must not run' }),
      await mkdtemp(join(tmpdir(), 'jian-cloud-')),
    );
    prototypes.useDesigner(async ({ prompt, source }) => {
      jobs.push({ prompt, ...(source ? { source } : {}) });
      return { ok: true, url: CANVAS, summary: '' };
    });
    const pushed: string[] = [];
    let reachable = true;
    prototypes.usePrints({
      push: async (folder, prints) => {
        if (!reachable) throw new Error('GitHub answered 401');
        const paths = prints.map((print) => `${folder}/${print.name}`);
        pushed.push(...paths);
        return paths;
      },
      source: async () => 'https://github.com/MrCharlor/atena-prints',
    });

    const created = await prototypes.create(
      {
        application: 'erp',
        title: 'Cores de Aparelhos',
        brief: 'Listagem das cores.',
        prints: [{ name: 'hoje.png', contentType: 'image/png', data: 'iVBORw0KGgo=' }],
      },
      { kind: 'owner' },
    );
    await prototypes.drain();

    expect(pushed).toEqual([`${created.id}/v1/hoje.png`]);
    expect(jobs[0]?.source).toBe('https://github.com/MrCharlor/atena-prints');
    expect(jobs[0]?.prompt).toContain(`- ${created.id}/v1/hoje.png`);
    expect(jobs[0]?.prompt).toContain('abra com Read cada print');

    reachable = false;
    await prototypes.redo(created.id, { comments: 'Tire a coluna Código.' });
    await prototypes.drain();

    expect(jobs[1]?.source).toBeUndefined();
    expect(jobs[1]?.prompt).toContain('que não chegam a esta sessão');
    expect((await prototypes.get(created.id)).versions[1]).toMatchObject({ status: 'ready' });
  });
});

describe('the prints repository', () => {
  it('writes each print under the version folder, replacing one already there', async () => {
    const services = await testServices();
    const calls: { method: string; url: string; body?: { content: string; sha?: string } }[] = [];
    const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
    const repo = new PrintsRepository(
      services.store,
      new GatewayVault(services.store, box),
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          method: init?.method ?? 'GET',
          url,
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        if ((init?.method ?? 'GET') === 'GET') {
          return url.endsWith('velha.png')
            ? Response.json({ sha: 'abc' })
            : new Response('{}', { status: 404 });
        }
        return Response.json({ content: {} }, { status: 201 });
      }) as typeof fetch,
    );

    expect(await repo.push('p/v1', [{ name: 'a.png', content: 'AA==' }])).toBeUndefined();
    expect(await repo.status()).toMatchObject({ configured: false });

    repo.useRepository('MrCharlor/atena-prints');
    await repo.configure({ token: 'github_pat_test' });

    expect(await repo.status()).toMatchObject({
      repository: 'MrCharlor/atena-prints',
      configured: true,
    });
    expect(await repo.source()).toBe('https://github.com/MrCharlor/atena-prints');
    expect(
      await repo.push('p/v1', [
        { name: 'tela de hoje.png', content: 'AA==' },
        { name: 'velha.png', content: 'BB==' },
      ]),
    ).toEqual(['p/v1/tela-de-hoje.png', 'p/v1/velha.png']);

    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts.map((call) => call.url)).toEqual([
      'https://api.github.com/repos/MrCharlor/atena-prints/contents/p/v1/tela-de-hoje.png',
      'https://api.github.com/repos/MrCharlor/atena-prints/contents/p/v1/velha.png',
    ]);
    expect(puts[0]?.body).toMatchObject({ content: 'AA==' });
    expect(puts[0]?.body?.sha).toBeUndefined();
    expect(puts[1]?.body).toMatchObject({ content: 'BB==', sha: 'abc' });
    expect(printFileName('../x y.png')).toBe('x-y.png');
  });
});

describe('the routine that draws', () => {
  it('reads the canvas link, a failure, or that it is still drawing', () => {
    expect(readPoll(`ATENA_RESULT ${CANVAS} tela pronta`)).toEqual({
      state: 'done',
      url: CANVAS,
      summary: 'tela pronta',
    });
    expect(readPoll('ATENA_ERRO sem permissão')).toEqual({
      state: 'failed',
      error: 'sem permissão',
    });
    expect(readPoll('PENDENTE')).toEqual({ state: 'pending' });
    expect(readPoll('rate limited, try again')).toEqual({ state: 'pending' });
  });

  it('fills the routine, fires it and waits for the result', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'jian-routine-'));
    const answers = ['SESSION cse_01abc', 'PENDENTE', `ATENA_RESULT ${CANVAS}`];
    const asked: string[][] = [];
    const draw = claudeRoutine({
      routineId: 'trig_01x',
      environmentId: 'env_01y',
      run: async (_prompt, _folder, tools) => {
        asked.push(tools);
        return { code: 0, output: answers.shift() ?? '' };
      },
      pause: async () => {},
    });

    const outcome = await draw({
      prompt: 'Desenhe a tela.',
      folder,
      signal: new AbortController().signal,
    });
    const body = JSON.parse(await readFile(join(folder, 'rotina.json'), 'utf8'));

    expect(outcome).toEqual({ ok: true, url: CANVAS, summary: '' });
    expect(body.job_config.ccr).toMatchObject({
      environment_id: 'env_01y',
      events: [{ data: { message: { role: 'user', content: 'Desenhe a tela.' } } }],
    });
    expect(asked[0]).toEqual(['Read', 'RemoteTrigger', 'ToolSearch']);
  });

  it('opens the prints repository only when there is one', () => {
    expect(routineBody('x', 'env_01y', 'm').job_config.ccr.session_context.sources).toEqual([]);
    expect(
      routineBody('x', 'env_01y', 'm', 'https://github.com/MrCharlor/atena-prints').job_config.ccr
        .session_context.sources,
    ).toEqual([{ git_repository: { url: 'https://github.com/MrCharlor/atena-prints' } }]);
  });
});
