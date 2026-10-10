import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type CloudDesigner, claudeRoutine, readPoll } from '../src/prototypes/cloud.js';
import { Prototypes } from '../src/prototypes/service.js';
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
});
