import { describe, expect, it } from 'vitest';
import type { EntryTarget } from '../src/epics/target.js';
import { PipelineChain } from '../src/pipeline/service.js';
import type { WorkClient } from '../src/priorities/work-board.js';
import { testServices } from './helpers/services.js';

const target: EntryTarget = {
  webUrl: 'https://work.example',
  workspaceId: 'ws',
  entryBoardId: 'entrada',
  epicsBoardId: 'epics',
  tasksBoardId: 'tasks',
  entryColumns: {
    prioritized: 'Priorizado',
    running: 'Em execução',
    blocked: 'Bloqueado',
    done: 'Concluído',
  },
  entryColumnIds: {},
  workColumns: {
    todo: 'A fazer',
    blocked: 'Bloqueado',
    doing: 'Em andamento',
    review: 'Em revisão',
    accepted: 'Aceito',
  },
  staleDays: 7,
};

const statuses = (names: string[]) => ({
  statuses: names.map((name) => ({ id: `s-${name}`, name })),
});

/** The Entrada in memory: whatever cards are in Priorizado right now. */
function board(cards: Array<{ id: string; title: string }>) {
  const client: WorkClient = {
    async call(_method, path) {
      if (path === '/boards/entrada/statuses')
        return statuses(['Priorizado', 'Em execução', 'Bloqueado', 'Concluído']);
      if (path.endsWith('/statuses'))
        return statuses(['A fazer', 'Bloqueado', 'Em andamento', 'Em revisão', 'Aceito']);
      if (path.startsWith('/boards/entrada/activities/column?status_id=s-Priorizado'))
        return {
          items: cards.map((card) => ({ ...card, status_id: 's-Priorizado', board_id: 'entrada' })),
        };
      return { items: [] };
    },
  };

  return client;
}

async function fixture() {
  const services = await testServices();
  const cards = [{ id: 'old-1', title: 'Pedido antigo' }];
  const asked: Array<{ text: string; key: string }> = [];
  const told: string[] = [];
  const created: unknown[] = [];
  const pauta = await services.pautas.create({
    title: 'Cores de aparelhos',
    application: undefined,
  });
  const chain = new PipelineChain(
    services.store,
    async () => board(cards),
    async () => 'work-profile',
    target,
    { profiles: async () => [{ id: 'subaru', name: 'Subaru' }] as never },
    services.pautas,
    {
      list: async () => [],
      create: async (input) => {
        created.push(input);
        return { id: '00000000-0000-4000-8000-000000000001' } as never;
      },
    },
    services.epics,
  );

  chain.useAgents({
    submit: async (_profileId, _sessionId, text, key) => {
      asked.push({ text, key });
    },
    session: async () => ({ id: 'session' }),
  });
  chain.useOwner(async (text) => told.push(text));

  return { chain, cards, asked, told, created, pauta, services };
}

describe('the chain from Priorizado to an epic', () => {
  it('does nothing while off, and puts aside what was already in Priorizado when switched on', async () => {
    const f = await fixture();

    await f.chain.tick();
    expect(await f.chain.list()).toEqual([]);

    await f.chain.updateSettings({ enabled: true });
    await f.chain.step();

    expect(await f.chain.list()).toMatchObject([{ requestTitle: 'Pedido antigo', stage: 'fora' }]);
    expect(f.asked).toEqual([]);
    expect(f.told[0]).toContain('ficaram de fora');
  });

  it('walks a new request to the author, once, and lets at most the limit walk at once', async () => {
    const f = await fixture();

    await f.chain.updateSettings({ enabled: true, maxActive: 1 });
    await f.chain.step();
    f.cards.push({ id: 'new-1', title: 'Filtro de cores' }, { id: 'new-2', title: 'Outro' });
    await f.chain.step();
    await f.chain.step();

    const list = await f.chain.list();
    expect(list.find((row) => row.requestWorkId === 'new-1')?.stage).toBe('pauta');
    expect(list.find((row) => row.requestWorkId === 'new-2')?.stage).toBe('fila');
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]?.text).toContain('report_request');
    expect(f.asked[0]?.text).toContain('workId new-1');
  });

  it('opens the prototype from the author’s report, or goes straight to the epic', async () => {
    const f = await fixture();

    await f.chain.updateSettings({ enabled: true });
    await f.chain.step();
    f.cards.push({ id: 'new-1', title: 'Filtro de cores' }, { id: 'new-2', title: 'Regra' });
    await f.chain.step();

    const list = await f.chain.list();
    const drawn = list.find((row) => row.requestWorkId === 'new-1');
    const plain = list.find((row) => row.requestWorkId === 'new-2');
    const by = { profileId: 'subaru', sessionId: 'session' };

    await expect(
      f.chain.report(drawn?.id ?? '', { reason: 'x' }, { profileId: 'otto', sessionId: 's' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    await f.chain.report(
      drawn?.id ?? '',
      {
        pautaId: f.pauta.id,
        needsPrototype: true,
        application: 'erp',
        brief: 'Filtro por cor na listagem.',
        reason: 'Tela muda.',
      },
      by,
    );
    await f.chain.report(
      plain?.id ?? '',
      { pautaId: f.pauta.id, needsPrototype: false, reason: 'Só regra.' },
      by,
    );

    const after = await f.chain.list();
    expect(after.find((row) => row.requestWorkId === 'new-1')).toMatchObject({
      stage: 'prototipo',
      needsPrototype: true,
      pautaTitle: 'Cores de aparelhos',
    });
    expect(f.created).toEqual([
      expect.objectContaining({ application: 'erp', pautaId: f.pauta.id }),
    ]);
    expect(after.find((row) => row.requestWorkId === 'new-2')?.stage).toBe('epico');
    expect(f.asked.at(-1)?.text).toContain('draft_epic');
  });

  it('stops a request whose origin is missing, and one that left Priorizado', async () => {
    const f = await fixture();

    await f.chain.updateSettings({ enabled: true });
    await f.chain.step();
    f.cards.push({ id: 'new-1', title: 'Sem origem' }, { id: 'new-2', title: 'Some' });
    await f.chain.step();

    const first = (await f.chain.list()).find((row) => row.requestWorkId === 'new-1');
    await f.chain.report(
      first?.id ?? '',
      { missing: 'qual tela', reason: 'O card não diz.' },
      { profileId: 'subaru', sessionId: 'session' },
    );

    f.cards.splice(
      f.cards.findIndex((card) => card.id === 'new-2'),
      1,
    );
    await f.chain.step();

    const list = await f.chain.list();
    expect(list.find((row) => row.requestWorkId === 'new-1')?.note).toContain('qual tela');
    expect(list.find((row) => row.requestWorkId === 'new-2')).toMatchObject({
      stage: 'parado',
      note: 'O pedido saiu de Priorizado.',
    });
  });

  it('waits for the owner once the draft is written, and lets an old request in', async () => {
    const f = await fixture();

    await f.chain.updateSettings({ enabled: true });
    await f.chain.step();
    f.cards.push({ id: 'new-1', title: 'Regra' });
    await f.chain.step();

    const row = (await f.chain.list()).find((item) => item.requestWorkId === 'new-1');
    await f.chain.report(
      row?.id ?? '',
      { pautaId: f.pauta.id, needsPrototype: false, reason: 'Só regra.' },
      { profileId: 'subaru', sessionId: 'session' },
    );
    await f.services.epics.draft({
      pautaId: f.pauta.id,
      requestWorkId: 'new-1',
      title: '[EPIC] Regra',
      label: 'feature',
      description: '## Pronto quando\nA regra vale.',
      tasks: [
        { title: 'Aplicar a regra', label: 'feature', description: 'Faz.', criteria: ['Vale.'] },
      ],
    });
    await f.chain.step();

    expect((await f.chain.list()).find((item) => item.requestWorkId === 'new-1')?.stage).toBe(
      'aguardando_epico',
    );

    const old = (await f.chain.list()).find((item) => item.requestWorkId === 'old-1');
    expect((await f.chain.enter(old?.id ?? '')).stage).toBe('fila');
  });
});
