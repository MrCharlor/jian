import { parseRoadmapNote, parseRoadmapReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { GatewayError } from '../src/core/errors.js';
import type { EntryTarget } from '../src/epics/target.js';
import type { WorkClient } from '../src/priorities/work-board.js';
import { normalized, Roadmap } from '../src/roadmap/service.js';
import { roadmapTools } from '../src/roadmap/tools.js';
import { testServices } from './helpers/services.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 86_400_000;
const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
const token = 'synthetic-admin-token-with-32-characters';
const admin = { authorization: `Bearer ${token}` };

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

/** The tracker in memory: the Entrada with one request running and one prioritized. */
function memoryWork(): WorkClient {
  const statuses = [
    { id: 's-pri', name: 'Priorizado' },
    { id: 's-run', name: 'Em execução' },
    { id: 's-blo', name: 'Bloqueado' },
    { id: 's-done', name: 'Concluído' },
    { id: 's-todo', name: 'A fazer' },
    { id: 's-doing', name: 'Em andamento' },
    { id: 's-rev', name: 'Em revisão' },
    { id: 's-acc', name: 'Aceito' },
  ];

  return {
    async call(_method, path) {
      if (path.endsWith('/statuses')) return { statuses };
      if (path.includes('status_id=s-run')) {
        return { items: [{ id: 'req-1', title: 'Encomendas no App' }] };
      }
      if (path.includes('status_id=s-pri')) {
        return { items: [{ id: 'req-2', title: 'Filtro de lojas' }] };
      }
      if (path.includes('/activities/column')) return { items: [] };
      if (path.endsWith('/relationships')) {
        return path.includes('req-1')
          ? {
              relationships: [
                {
                  activity_id: 'epic-9',
                  board_id: 'epics',
                  relation_type: 'depends_on',
                  direction: 'out',
                },
              ],
            }
          : { relationships: [] };
      }
      throw new GatewayError(502, `The board answered 404: ${path}`);
    },
  };
}

async function fixture() {
  let now = NOW;
  const services = await testServices(() => now);
  const strategist = await services.profiles.createProfile({
    name: 'Estrategista',
    instructions: 'Keep the roadmap.',
    model,
  });
  const other = await services.profiles.createProfile({
    name: 'Otto',
    instructions: 'Operate the board.',
    model,
  });
  await services.applications.create({ slug: 'erp', name: 'ERP' });
  await services.applications.create({ slug: 'app-gestores', name: 'App Gestores' });

  const told: Array<{ text: string; short?: string }> = [];
  const corrections: Array<Record<string, unknown>> = [];
  const lessons: Array<Record<string, unknown>> = [];
  const memories: Array<{ key: string; content: string }> = [];
  const submitted: Array<{ profileId: string; session: string; text: string }> = [];
  const roadmap = new Roadmap(
    services.store,
    services.profiles,
    services.applications,
    async () => memoryWork(),
    async () => 'key-profile',
    target,
    {
      record: async (_db, _profileId, entry) => {
        corrections.push(entry);
        return {} as never;
      },
    },
    () => now,
  );

  roadmap.useAgents({
    submit: async (profileId, session, text) => {
      submitted.push({ profileId, session, text });
    },
    session: async (_profileId, title) => ({ id: title }),
    remember: async (_profileId, key, content) => {
      memories.push({ key, content });
    },
  });
  roadmap.useOwner(async (text, short) => told.push({ text, ...(short ? { short } : {}) }));
  roadmap.useLearner(async (lesson) => lessons.push(lesson));
  await roadmap.updateSettings({ strategistProfileId: strategist.id });

  const by = { profileId: strategist.id };
  const suggestion = (title: string, extra: Record<string, unknown> = {}) => ({
    kind: 'incluir' as const,
    item: { application: 'App Gestores', title, summary: 'Para o gestor ver a meta do dia.' },
    reason: 'Os gestores pedem isso nas validações.',
    counterpoint: 'Pode competir com o filtro de lojas.',
    evidence: ['Validação #4'],
    ...extra,
  });

  return {
    services,
    roadmap,
    strategist,
    other,
    by,
    told,
    corrections,
    lessons,
    memories,
    submitted,
    suggestion,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('the owner’s commands', () => {
  it('reads OKs, ranges, lists, refusals and adjustments', () => {
    expect(parseRoadmapReply('ok roadmap 4')).toEqual({ numbers: [4], action: 'ok' });
    expect(parseRoadmapReply('ok roadmap #4.')).toEqual({ numbers: [4], action: 'ok' });
    expect(parseRoadmapReply('roadmap 4: ok')).toEqual({ numbers: [4], action: 'ok' });
    expect(parseRoadmapReply('ok roadmap 1-4')).toEqual({ numbers: [1, 2, 3, 4], action: 'ok' });
    expect(parseRoadmapReply('ok roadmap 3, 5, 7')).toEqual({ numbers: [3, 5, 7], action: 'ok' });
    expect(parseRoadmapReply('ok roadmap 3, 5 e 7')).toEqual({ numbers: [3, 5, 7], action: 'ok' });
    expect(parseRoadmapReply('ok roadmap 1-2, 5')).toEqual({ numbers: [1, 2, 5], action: 'ok' });
    expect(parseRoadmapReply('recusa roadmap 4: não é agora')).toEqual({
      numbers: [4],
      action: 'refuse',
      text: 'não é agora',
    });
    expect(parseRoadmapReply('recusa roadmap 4')).toEqual({ numbers: [4], action: 'refuse' });
    expect(parseRoadmapReply('roadmap 4: Meta do dia por loja')).toEqual({
      numbers: [4],
      action: 'edit',
      text: 'Meta do dia por loja',
    });
    expect(parseRoadmapReply('ok roadmap 5-1')).toBeUndefined();
    expect(parseRoadmapReply('ok roadmap 1-500')).toBeUndefined();
    expect(parseRoadmapReply('roadmap: meta do dia')).toBeUndefined();
    expect(parseRoadmapReply('ok regra 4')).toBeUndefined();
  });

  it('reads the owner’s note, with the product when it ends with one', () => {
    expect(parseRoadmapNote('roadmap: meta do dia no App Gestores')).toEqual({
      text: 'meta do dia no App Gestores',
      title: 'meta do dia',
      product: 'App Gestores',
    });
    expect(parseRoadmapNote('roadmap: filtro no cabeçalho na erp')).toMatchObject({
      title: 'filtro no cabeçalho',
      product: 'erp',
    });
    expect(parseRoadmapNote('roadmap: exportar em lote')).toMatchObject({
      title: 'exportar',
      product: 'lote',
    });
    expect(parseRoadmapNote('Roadmap:   ideia solta')).toEqual({
      text: 'ideia solta',
      title: 'ideia solta',
    });
    expect(parseRoadmapNote('roadmap 3: texto')).toBeUndefined();
    expect(normalized('App-Gestores')).toBe(normalized('app gestores'));
    expect(normalized('Ação Fiscal!')).toBe('acao fiscal');
  });
});

describe('roadmap', () => {
  it('takes proposals only from the Estrategista', async () => {
    const f = await fixture();

    await expect(
      f.roadmap.propose(f.suggestion('Meta do dia'), { profileId: f.other.id }),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(f.roadmap.sync({ entries: [] }, { profileId: f.other.id })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(await f.roadmap.isStrategist(f.strategist.id)).toBe(true);
    expect(await f.roadmap.isStrategist(f.other.id)).toBe(false);

    const proposal = await f.roadmap.propose(f.suggestion('Meta do dia'), f.by);

    expect(proposal).toMatchObject({
      number: 1,
      kind: 'incluir',
      state: 'aguardando_po',
      application: 'app-gestores',
      lane: 'depois',
      proposedBy: 'Estrategista',
      counterpoint: 'Pode competir com o filtro de lojas.',
    });
    expect(await f.roadmap.list()).toEqual([]);
    expect(f.told).toHaveLength(1);
    expect(f.told[0]?.text).toContain('Contraponto: Pode competir');
    expect(f.told[0]?.short).toMatch(/Responda "ok roadmap 1" ou "recusa roadmap 1: motivo"\.$/);
    expect(`${f.told[0]?.text}${f.told[0]?.short}`).not.toMatch(/[—–]/);

    // The agent toolset carries the tools; the service still refuses another profile.
    const tools = roadmapTools(f.roadmap, { profileId: f.other.id } as never);
    expect(Object.keys(tools).sort()).toEqual(['propose_roadmap', 'read_roadmap', 'sync_roadmap']);
  });

  it('refuses again a suggestion the owner refused in the last 60 days', async () => {
    const f = await fixture();
    const first = await f.roadmap.propose(f.suggestion('Meta do dia'), f.by);

    await f.roadmap.decide(
      { number: first.number },
      { action: 'refuse', text: 'já tem no ERP' },
      'panel',
    );
    f.advance(10 * DAY);

    await expect(f.roadmap.propose(f.suggestion('META do Dia!'), f.by)).rejects.toThrow(
      /recusou essa sugestão em 14\/10\/2026.*já tem no ERP.*60 dias/,
    );

    f.advance(51 * DAY);
    expect((await f.roadmap.propose(f.suggestion('Meta do dia'), f.by)).state).toBe(
      'aguardando_po',
    );
  });

  it('keeps the owner’s refusal as a correction, a lesson and the Estrategista’s memory', async () => {
    const f = await fixture();
    await f.roadmap.propose(f.suggestion('Meta do dia'), f.by);

    const refused = await f.roadmap.decide(
      { number: 1 },
      { action: 'refuse', text: 'não agora' },
      'channel',
    );

    expect(refused).toMatchObject({ state: 'recusada', note: 'não agora', decidedVia: 'channel' });
    expect(f.corrections).toEqual([
      expect.objectContaining({ kind: 'rejected', action: 'roadmap', via: 'channel' }),
    ]);
    expect(f.lessons).toEqual([
      expect.objectContaining({ kind: 'roadmap', application: 'App Gestores' }),
    ]);
    expect(f.memories[0]?.key).toBe('roadmap-recusa-1');
    await expect(f.roadmap.decide({ number: 1 }, { action: 'ok' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('applies with the owner’s adjustment, counted as an edit', async () => {
    const f = await fixture();
    await f.roadmap.propose(f.suggestion('Meta do dia'), f.by);

    const applied = await f.roadmap.decide(
      { number: 1 },
      { action: 'edit', text: 'Meta do dia por loja' },
      'panel',
    );
    const [item] = await f.roadmap.list();

    expect(applied).toMatchObject({ state: 'aplicada', appliedBy: 'owner', resultNumber: 1 });
    expect(item).toMatchObject({
      title: 'Meta do dia por loja',
      lane: 'depois',
      origin: 'sugestao',
    });
    expect(f.corrections).toEqual([expect.objectContaining({ kind: 'edited', action: 'roadmap' })]);
  });

  it('moves forward on its own only with the automatic switch on', async () => {
    const f = await fixture();
    const item = await f.roadmap.create({
      application: 'erp',
      title: 'Encomendas',
      lane: 'proximo',
    });

    const off = await f.roadmap.sync(
      {
        entries: [
          { itemId: item.id, lane: 'agora', reason: 'Pedido em Em execução.', evidence: ['req-1'] },
        ],
      },
      f.by,
    );
    expect(off.applied).toEqual([]);
    expect(off.proposed).toMatchObject([{ kind: 'mover', fromLane: 'proximo', lane: 'agora' }]);
    expect((await f.roadmap.get(item.id)).lane).toBe('proximo');

    // The same reading again proposes nothing new.
    const again = await f.roadmap.sync(
      { entries: [{ itemId: item.id, lane: 'agora', reason: 'Pedido em Em execução.' }] },
      f.by,
    );
    expect(again.proposed).toEqual([]);
    expect(again.skipped).toHaveLength(1);

    await f.roadmap.decide({ number: 1 }, { action: 'refuse' });
    await f.roadmap.updateSettings({ automaticMoves: true });
    const on = await f.roadmap.sync(
      { entries: [{ itemId: item.id, lane: 'agora', reason: 'Pedido em Em execução.' }] },
      f.by,
    );

    expect(on.applied).toEqual([
      { itemNumber: item.number, title: 'Encomendas', change: 'movido para Agora' },
    ]);
    expect(on.proposed).toEqual([]);
    expect((await f.roadmap.get(item.id)).lane).toBe('agora');
    expect((await f.roadmap.proposals({ state: 'aplicada' }))[0]).toMatchObject({
      appliedBy: 'automatico',
      decidedVia: 'automatico',
    });

    const done = await f.roadmap.sync(
      { entries: [{ itemId: item.id, state: 'concluido', reason: 'Pedido Concluído.' }] },
      f.by,
    );
    expect(done.applied[0]?.change).toBe('concluído');
    expect(await f.roadmap.get(item.id)).toMatchObject({ state: 'concluido' });
  });

  it('never moves backward, nor discards, on its own', async () => {
    const f = await fixture();
    await f.roadmap.updateSettings({ automaticMoves: true });
    const running = await f.roadmap.create({
      application: 'erp',
      title: 'Encomendas',
      lane: 'agora',
    });
    const next = await f.roadmap.create({ application: 'erp', title: 'Fiscal', lane: 'proximo' });

    const result = await f.roadmap.sync(
      {
        entries: [
          { itemId: running.id, lane: 'proximo', reason: 'Pedido voltou para Priorizado.' },
          { itemId: next.id, state: 'descartado', reason: 'Pedido Recusado.' },
          { itemId: next.id, blocked: true, reason: 'Épico Bloqueado.' },
        ],
      },
      f.by,
    );

    expect(result.proposed.map((proposal) => proposal.kind)).toEqual(['mover', 'descartar']);
    expect(result.applied).toEqual([
      { itemNumber: next.number, title: 'Fiscal', change: 'marcado bloqueado' },
    ]);
    expect(await f.roadmap.get(running.id)).toMatchObject({ lane: 'agora', state: 'ativo' });
    expect(await f.roadmap.get(next.id)).toMatchObject({
      lane: 'proximo',
      state: 'ativo',
      blocked: true,
    });
    expect(f.told.at(-1)?.short).toContain('"ok roadmap 1-2"');
  });

  it('proposes new items from requests, once', async () => {
    const f = await fixture();
    await f.roadmap.updateSettings({ automaticMoves: true });
    const entry = {
      new: {
        application: 'app-gestores',
        title: 'Encomendas',
        origin: 'pedido' as const,
        requestWorkId: 'req-1',
      },
      lane: 'agora' as const,
      reason: 'Pedido em Em execução.',
      evidence: ['req-1'],
    };

    const first = await f.roadmap.sync({ entries: [entry] }, f.by);
    const second = await f.roadmap.sync({ entries: [entry] }, f.by);

    expect(first.proposed).toMatchObject([
      { kind: 'incluir', lane: 'agora', item: { requestWorkId: 'req-1' } },
    ]);
    expect(second.proposed).toEqual([]);
    expect(second.skipped[0]?.why).toContain('proposta #1');
    expect(await f.roadmap.list()).toEqual([]);
  });

  it('applies a batch from the chat, with the owner’s note going straight in Depois', async () => {
    const f = await fixture();
    for (const title of ['Meta do dia', 'Ranking de lojas', 'Encomendas']) {
      await f.roadmap.propose(f.suggestion(title), f.by);
    }

    const batch = await f.roadmap.fromChat({ numbers: [1, 2, 3, 4], action: 'ok' });

    expect(batch.proposals.map((proposal) => proposal.state)).toEqual([
      'aplicada',
      'aplicada',
      'aplicada',
    ]);
    expect(batch.failed).toEqual([{ number: 4, why: 'não existe' }]);
    expect((await f.roadmap.list()).map((item) => [item.title, item.position])).toEqual([
      ['Meta do dia', 0],
      ['Ranking de lojas', 1],
      ['Encomendas', 2],
    ]);
    expect(Roadmap.notice(batch)).toContain('[Roadmap #4] Não aplicada: não existe.');

    const noted = await f.roadmap.note({
      text: 'exportar lotes no ERP',
      title: 'exportar lotes',
      product: 'ERP',
    });
    expect(noted).toMatchObject({
      item: {
        title: 'exportar lotes',
        lane: 'depois',
        origin: 'moabe',
        createdBy: 'owner',
        application: 'erp',
      },
    });
    expect(await f.roadmap.proposals({ state: 'aguardando_po' })).toEqual([]);

    // A product the roadmap does not know is part of the idea; with two products, one line asks.
    const asked = await f.roadmap.note({
      text: 'filtro no cabeçalho',
      title: 'filtro',
      product: 'cabeçalho',
    });
    expect(asked).toEqual({
      question:
        'Em qual produto entra "filtro no cabeçalho": ERP ou App Gestores? Responda "roadmap: filtro no cabeçalho no <produto>".',
    });

    await f.roadmap.updateSettings({ applications: ['erp'] });
    expect(await f.roadmap.note({ text: 'ideia solta', title: 'ideia solta' })).toMatchObject({
      item: { application: 'erp', title: 'ideia solta' },
    });
  });

  it('lets the owner move, reorder, edit, conclude and discard directly', async () => {
    const f = await fixture();
    const a = await f.roadmap.create({ application: 'erp', title: 'A' });
    const b = await f.roadmap.create({ application: 'erp', title: 'B' });
    const c = await f.roadmap.create({ application: 'erp', title: 'C', lane: 'agora' });

    await f.roadmap.update(b.id, { position: 0 });
    expect((await f.roadmap.list({ lane: 'depois' })).map((item) => item.title)).toEqual([
      'B',
      'A',
    ]);

    await f.roadmap.update(a.id, { lane: 'agora', theme: 'Fiscal', title: 'A nova' });
    expect((await f.roadmap.list()).map((item) => [item.lane, item.title])).toEqual([
      ['agora', 'C'],
      ['agora', 'A nova'],
      ['depois', 'B'],
    ]);

    expect(await f.roadmap.update(c.id, { state: 'concluido' })).toMatchObject({
      state: 'concluido',
      concludedAt: expect.any(String),
    });
    expect((await f.roadmap.update(b.id, { state: 'descartado' })).state).toBe('descartado');
    expect(await f.roadmap.list({ state: 'ativo' })).toHaveLength(1);
    expect(await f.roadmap.list({ application: 'App Gestores' })).toEqual([]);
    expect(f.told).toEqual([]);
  });

  it('starts the Estrategista’s reading with the Entrada as it is now', async () => {
    const f = await fixture();
    const result = await f.roadmap.run({ kind: 'leitura' });

    expect(result).toMatchObject({ kind: 'leitura', profileId: f.strategist.id, workRead: true });
    expect(f.submitted[0]).toMatchObject({
      profileId: f.strategist.id,
      session: 'Roadmap · leitura',
    });
    expect(f.submitted[0]?.text).toContain('Em execução (1):');
    expect(f.submitted[0]?.text).toContain('- Encomendas no App (pedido req-1); épicos: epic-9');
    expect(f.submitted[0]?.text).toContain('Automático desligado');

    await f.roadmap.run({ kind: 'sugestoes' });
    expect(f.submitted[1]).toMatchObject({ session: 'Roadmap · sugestões' });
    expect(f.submitted[1]?.text).toContain('até 3');

    await f.roadmap.updateSettings({ strategistProfileId: null });
    await expect(f.roadmap.run({})).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('the roadmap in the chat and the API', () => {
  it('takes "ok roadmap N" and "roadmap: ideia" from the owner in a chat', async () => {
    const services = await testServices();
    const strategist = await services.profiles.createProfile({
      name: 'Estrategista',
      instructions: 'x',
      model,
    });
    const owner = await services.profiles.createProfile({
      name: 'Atena',
      instructions: 'x',
      model,
    });
    await services.applications.create({ slug: 'erp', name: 'ERP' });
    await services.applications.create({ slug: 'app-gestores', name: 'App Gestores' });
    await services.roadmap.updateSettings({ strategistProfileId: strategist.id });
    await services.roadmap.propose(
      {
        kind: 'incluir',
        item: { application: 'erp', title: 'Meta do dia' },
        reason: 'r',
        counterpoint: 'c',
        evidence: ['e'],
      },
      { profileId: strategist.id },
    );
    const session = await services.sessions.createSession(owner.id, { title: 'Moabe' });

    const ok = await services.runs.submit(
      owner.id,
      session.id,
      { text: 'ok roadmap 1', requestKey: 'ok' },
      { ownerMessage: true },
    );
    expect(ok.input).toContain('[Roadmap #1] O Moabe aplicou');
    await services.runs.cancel(owner.id, ok.id);

    const note = await services.runs.submit(
      owner.id,
      session.id,
      { text: 'roadmap: ranking de lojas no app gestores', requestKey: 'note' },
      { ownerMessage: true },
    );
    expect(note.input).toContain('criado em Depois no App Gestores: "ranking de lojas"');
    await services.runs.cancel(owner.id, note.id);

    const asked = await services.runs.submit(
      owner.id,
      session.id,
      { text: 'roadmap: exportar lotes', requestKey: 'ask' },
      { ownerMessage: true },
    );
    expect(asked.input).toContain('Em qual produto entra "exportar lotes": ERP ou App Gestores?');
    await services.runs.cancel(owner.id, asked.id);

    expect((await services.roadmap.list()).map((item) => item.title)).toEqual([
      'Meta do dia',
      'ranking de lojas',
    ]);
  });

  it('serves the roadmap, the proposals and the settings', async () => {
    const services = await testServices();
    await services.applications.create({ slug: 'erp', name: 'ERP' });
    const app = createApp({ ...services, token, logger: false });

    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/roadmap/items',
        headers: admin,
        payload: { application: 'erp', title: 'Encomendas' },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ lane: 'depois', origin: 'moabe', kind: 'ideia' });

      const moved = await app.inject({
        method: 'PATCH',
        url: `/v1/roadmap/items/${created.json().id}`,
        headers: admin,
        payload: { lane: 'agora' },
      });
      expect(moved.json()).toMatchObject({ lane: 'agora', position: 0 });

      const listed = await app.inject({
        method: 'GET',
        url: '/v1/roadmap?application=ERP',
        headers: admin,
      });
      expect(listed.json()).toHaveLength(1);

      const settings = await app.inject({
        method: 'GET',
        url: '/v1/roadmap-settings',
        headers: admin,
      });
      expect(settings.json()).toEqual({
        automaticMoves: false,
        suggestionsPerRound: 3,
        applications: ['erp', 'app-gestores'],
      });

      const proposals = await app.inject({
        method: 'GET',
        url: '/v1/roadmap-proposals',
        headers: admin,
      });
      expect(proposals.json()).toEqual([]);

      const sync = await app.inject({
        method: 'POST',
        url: '/v1/roadmap/sync',
        headers: admin,
        payload: {},
      });
      expect(sync.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
