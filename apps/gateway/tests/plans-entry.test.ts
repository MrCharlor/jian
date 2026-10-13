import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { EntrySync } from '../src/entry/service.js';
import { type EntryTarget, SIGMA_ENTRY } from '../src/epics/target.js';
import type { WorkClient } from '../src/priorities/work-board.js';
import { plans as plansTable, validations } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

const NOW = Date.parse('2026-10-13T12:00:00Z');
const DAY = 86_400_000;

const E = {
  prioritized: '04b3c3f8-0000-4000-8000-000000000001',
  running: 'da8fb4d4-0000-4000-8000-000000000002',
  blocked: '90d65b0e-0000-4000-8000-000000000003',
  done: '22a4b02e-0000-4000-8000-000000000004',
  novo: 'ba9c276f-0000-4000-8000-000000000005',
};
const W = {
  todo: 'w-todo',
  blocked: 'w-blocked',
  doing: 'w-doing',
  review: 'w-review',
  accepted: 'w-accepted',
};

const target: EntryTarget = {
  ...SIGMA_ENTRY,
  webUrl: 'https://work.example',
  workspaceId: 'ws',
  entryBoardId: 'entrada',
  epicsBoardId: 'epics',
  tasksBoardId: 'tasks',
  todoStatusId: W.todo,
};

type Card = {
  id: string;
  title: string;
  board_id: string;
  parent_id: string | null;
  version: number;
  created_at: string;
};

/**
 * The tracker in memory: each card has its column on each board it is on (a mirror has its
 * own), relations, history, and every call is logged. A move with a stale version fails.
 */
function memoryWork() {
  const cards = new Map<string, Card>();
  const place = new Map<string, Map<string, string>>([
    ['entrada', new Map()],
    ['epics', new Map()],
    ['tasks', new Map()],
  ]);
  const relations = new Map<string, Array<Record<string, unknown>>>();
  const history = new Map<string, Array<Record<string, unknown>>>();
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];

  const add = (
    id: string,
    home: string,
    status: string,
    options: { parent?: string; on?: Array<[string, string]>; title?: string } = {},
  ) => {
    cards.set(id, {
      id,
      title: options.title ?? `Card ${id}`,
      board_id: home,
      parent_id: options.parent ?? null,
      version: 1,
      created_at: new Date(NOW - 30 * DAY).toISOString(),
    });
    if (place.has(home)) place.get(home)?.set(id, status);
    for (const [board, column] of options.on ?? []) place.get(board)?.set(id, column);
  };

  const view = (card: Card, board: string) => ({
    ...card,
    status_id: place.get(board)?.get(card.id) ?? '',
  });

  const statuses = (board: string) =>
    board === 'entrada'
      ? [
          { id: E.novo, name: 'Novo' },
          { id: E.prioritized, name: 'Priorizado' },
          { id: E.running, name: 'Em execução' },
          { id: E.blocked, name: 'Bloqueado' },
          { id: E.done, name: 'Concluído' },
        ]
      : [
          { id: W.todo, name: 'A fazer' },
          { id: W.blocked, name: 'Bloqueado' },
          { id: W.doing, name: 'Em andamento' },
          { id: W.review, name: 'Em revisão' },
          { id: W.accepted, name: 'Aceito' },
        ];

  const client: WorkClient = {
    async call(method, path, body) {
      calls.push({ method, path, ...(body ? { body: body as Record<string, unknown> } : {}) });
      const url = new URL(path, 'https://x');
      const parts = url.pathname.split('/').filter(Boolean);

      if (method === 'GET') {
        if (parts[0] === 'boards' && parts[2] === 'statuses') {
          return { statuses: statuses(parts[1] as string) };
        }
        if (parts[0] === 'boards' && parts[2] === 'activities') {
          const board = parts[1] as string;
          const here = [...(place.get(board)?.keys() ?? [])].map((id) =>
            view(cards.get(id) as Card, board),
          );

          if (parts[3] === 'column') {
            const items = here.filter(
              (card) => card.status_id === url.searchParams.get('status_id'),
            );
            return { items, next_cursor: '', total: items.length };
          }
          return here;
        }
        if (parts[0] === 'activities' && parts[2] === 'relationships') {
          return { relationships: relations.get(parts[1] as string) ?? [] };
        }
        if (parts[0] === 'activities' && parts[2] === 'history') {
          return history.get(parts[1] as string) ?? [];
        }
        if (parts[0] === 'activities' && parts.length === 2) {
          const card = cards.get(parts[1] as string) as Card;
          return view(card, card.board_id);
        }
        throw new Error(`unexpected GET ${path}`);
      }

      const id = parts[1] as string;
      const card = cards.get(id) as Card;
      const board = parts[2] === 'boards' ? (parts[3] as string) : card.board_id;
      const input = body as { status_id: string; expected_version: number };

      if (input.expected_version !== card.version) throw new Error('409 version');
      if (!place.get(board)?.has(id)) throw new Error('404 not on board');

      place.get(board)?.set(id, input.status_id);
      card.version += 1;

      return view(card, board);
    },
  };

  const writes = () => calls.filter((call) => call.method !== 'GET');

  return { client, cards, place, relations, history, calls, add, writes };
}

const dependsOn = (id: string, board = 'epics') => ({
  activity_id: id,
  board_id: board,
  relation_type: 'depends_on',
  direction: 'out',
});

/** The Sigma boards on a working day: what each rule has to act on, and what it must not. */
function sigmaBoards() {
  const work = memoryWork();

  // An epic whose task started: to Em andamento.
  work.add('e-start', 'epics', W.todo, { title: 'Cores' });
  work.add('t-start', 'epics', W.todo, { parent: 'e-start', on: [['tasks', W.doing]] });
  work.add('t-wait', 'epics', W.todo, { parent: 'e-start' });
  // Every task accepted: to Em revisão.
  work.add('e-ready', 'epics', W.doing, { title: 'Filtro' });
  work.add('t-ready', 'epics', W.todo, { parent: 'e-ready', on: [['tasks', W.accepted]] });
  // Blocked by the owner: stays, whatever its tasks say.
  work.add('e-blocked', 'epics', W.blocked, { title: 'App Gestores' });
  work.add('t-blocked', 'epics', W.todo, { parent: 'e-blocked', on: [['tasks', W.accepted]] });
  // Already in review, every task accepted: stays (never to Aceito).
  work.add('e-review', 'epics', W.review, { title: 'Hardware' });
  work.add('t-review', 'epics', W.todo, { parent: 'e-review', on: [['tasks', W.accepted]] });
  // Nothing started: stays.
  work.add('e-idle', 'epics', W.todo, { title: 'Parado' });
  work.add('t-idle', 'epics', W.todo, { parent: 'e-idle', on: [['tasks', W.todo]] });

  // A support card mirrored on the Entrada, whose epic starts in this same plan.
  work.add('p-start', 'geral', 'geral-dev', { on: [['entrada', E.prioritized]], title: 'Loja' });
  work.relations.set('p-start', [dependsOn('e-start')]);
  work.add('p-blocked', 'entrada', E.prioritized, { title: 'Gestores' });
  work.relations.set('p-blocked', [dependsOn('e-blocked')]);
  work.add('p-done', 'entrada', E.running, { title: 'Hardware loja' });
  work.relations.set('p-done', [dependsOn('e-review')]);
  work.add('p-ready', 'entrada', E.prioritized, { title: 'Filtro loja' });
  work.relations.set('p-ready', [dependsOn('e-ready')]);
  work.add('p-idle', 'entrada', E.running, { title: 'Parado loja' });
  work.relations.set('p-idle', [dependsOn('e-idle')]);
  // No epic for ten days: the owner hears of it.
  work.add('p-old', 'entrada', E.prioritized, { title: 'Sem épico' });
  work.history.set('p-old', [
    {
      event_type: 'activity.moved',
      created_at: new Date(NOW - 10 * DAY).toISOString(),
      after_data: { status_id: E.prioritized },
    },
  ]);
  // No epic for three days: not yet.
  work.add('p-new', 'entrada', E.prioritized, { title: 'Recente' });
  work.history.set('p-new', [
    {
      event_type: 'activity.moved',
      created_at: new Date(NOW - 3 * DAY).toISOString(),
      after_data: { status_id: E.prioritized },
    },
  ]);
  // Depends on another squad's epic: not the Sigma's, never moved.
  work.add('p-rocket', 'entrada', E.prioritized, { title: 'Rocket' });
  work.relations.set('p-rocket', [dependsOn('rocket-epic', 'rocket-epics')]);
  work.history.set('p-rocket', [
    {
      event_type: 'activity.moved',
      created_at: new Date(NOW - 2 * DAY).toISOString(),
      after_data: { status_id: E.prioritized },
    },
  ]);
  // Approved by the owner but still in Novo: the sync does not read Novo.
  work.add('p-novo', 'entrada', E.novo, { title: 'Novo' });
  work.relations.set('p-novo', [dependsOn('e-start')]);

  return work;
}

async function fixture(
  options: { reviewer?: boolean; automatic?: boolean; work?: ReturnType<typeof memoryWork> } = {},
) {
  let now = NOW;
  const services = await testServices(() => now);
  const otto = await services.profiles.createProfile({
    name: 'Otto',
    instructions: 'Help.',
    model,
  });
  const reviewer = await services.profiles.createProfile({
    name: 'Revisor',
    instructions: 'Review.',
    model,
  });
  const work = options.work ?? sigmaBoards();
  const told: Array<{ profileId: string; text: string }> = [];
  const owner: string[] = [];
  const entry = new EntrySync(
    services.store,
    async () => work.client,
    async () => otto.id,
    target,
    () => now,
  );

  entry.usePlanner(services.plans);
  services.plans.useEntrySync(entry);
  services.plans.useAgents(async (profileId, _session, said) =>
    told.push({ profileId, text: said }),
  );
  services.plans.useOwner(async (said) => owner.push(said));

  if (options.reviewer !== false) {
    await services.plans.updateSettings('entry_sync', {
      reviewerProfileId: reviewer.id,
      automatic: options.automatic ?? false,
    });
  } else if (options.automatic) {
    await services.plans.updateSettings('entry_sync', { automatic: true });
  }

  const approve = async (epicWorkId: string) =>
    services.store.db.insert(validations).values({
      id: randomUUID(),
      number: 7,
      epicWorkId,
      epicTitle: 'Hardware',
      items: [{ text: 'ok', result: 'passou' }],
      tasks: [],
      notes: [],
      state: 'aprovada',
      returns: [],
      decidedAt: new Date(NOW - DAY),
    });

  return {
    services,
    entry,
    work,
    otto,
    reviewer,
    told,
    owner,
    approve,
    later: (ms: number) => {
      now += ms;
    },
  };
}

const lines = (moves: Array<{ workId: string; from: string; to: string }>) =>
  moves.map((move) => `${move.workId}: ${move.from} -> ${move.to}`).sort();

describe('the Entrada follows the epic', () => {
  it('plans each missing move with its reason, and nothing more', async () => {
    const { entry, approve, services, otto, reviewer, told, work } = await fixture();

    await approve('e-review');

    const result = await entry.run({}, { profileId: otto.id });
    const plan = result.plan;

    expect(result).toMatchObject({ moves: 6, stale: 1, unchanged: false });
    expect(lines(plan?.entrySync?.moves ?? [])).toEqual([
      'e-ready: Em andamento -> Em revisão',
      'e-start: A fazer -> Em andamento',
      'p-blocked: Priorizado -> Bloqueado',
      'p-done: Em execução -> Concluído',
      'p-ready: Priorizado -> Em execução',
      'p-start: Priorizado -> Em execução',
    ]);
    expect(plan?.entrySync?.stale).toEqual([
      expect.objectContaining({ workId: 'p-old', days: 10 }),
    ]);
    expect(plan).toMatchObject({
      action: 'entry_sync',
      state: 'em_revisao',
      authorProfileId: otto.id,
      reviewerProfileId: reviewer.id,
      title: 'Entrada e épicos (6 movimento(s))',
    });
    expect(plan?.original).toContain(
      'Épico "Cores": A fazer → Em andamento, 1 de 2 task(s) saíram de A fazer',
    );
    expect(plan?.original).toContain(
      'Pedido na Entrada "Loja": Priorizado → Em execução, épico "Cores" em Em andamento (movido neste plano)',
    );
    expect(plan?.original).toContain('aprovado na validação #7 do Moabe');
    expect(plan?.original).toContain('"Sem épico": há 10 dias');
    expect(told.at(-1)).toMatchObject({
      profileId: reviewer.id,
      text: expect.stringContaining('épico nunca vai para Aceito nem sai de Bloqueado'),
    });
    // Reading moves nothing.
    expect(work.writes()).toEqual([]);
    expect(await services.plans.list()).toHaveLength(1);
  });

  it('keeps the hard rules: no Aceito, no way out of Bloqueado, no task, no request without epic, only the Sigma', async () => {
    const { entry, otto, approve } = await fixture();

    await approve('e-review');

    const { plan } = await entry.run({}, { profileId: otto.id });
    const moves = plan?.entrySync?.moves ?? [];
    const ids = moves.map((move) => move.workId);

    expect(moves.some((move) => move.toStatusId === W.accepted)).toBe(false);
    expect(moves.some((move) => move.fromStatusId === W.blocked)).toBe(false);
    expect(ids).not.toContain('e-blocked');
    expect(ids).not.toContain('e-review');
    expect(ids.some((id) => id.startsWith('t-'))).toBe(false);
    expect(ids).not.toContain('p-old');
    expect(ids).not.toContain('p-new');
    expect(ids).not.toContain('p-rocket');
    expect(ids).not.toContain('p-novo');
    expect(ids).not.toContain('p-idle');
  });

  it('moves on the owner OK, each card with the version read just before', async () => {
    const { entry, otto, work, services, approve } = await fixture();

    await approve('e-review');

    const { plan } = await entry.run({}, { profileId: otto.id });

    // Someone edits a card after the plan was made: its version moves on.
    (work.cards.get('p-start') as Card).version = 9;

    const done = await services.plans.approve({ id: plan?.id ?? '' }, 'panel');

    expect(done.state).toBe('executado');
    expect(done.entrySync?.moves.every((move) => move.result === 'feito')).toBe(true);
    expect(work.place.get('epics')?.get('e-start')).toBe(W.doing);
    expect(work.place.get('epics')?.get('e-ready')).toBe(W.review);
    expect(work.place.get('entrada')?.get('p-start')).toBe(E.running);
    expect(work.place.get('entrada')?.get('p-blocked')).toBe(E.blocked);
    expect(work.place.get('entrada')?.get('p-done')).toBe(E.done);
    expect(work.place.get('entrada')?.get('p-ready')).toBe(E.running);

    // The mirror moves on the Entrada, never on its home board.
    expect(work.writes().map((call) => call.path)).toContain(
      '/activities/p-start/boards/entrada/move',
    );
    // Every move follows a read of the same card, and sends that version.
    for (const [index, call] of work.calls.entries()) {
      if (call.method === 'GET') continue;
      const id = call.path.split('/')[2] as string;
      const read = work.calls
        .slice(0, index)
        .reverse()
        .find((earlier) => earlier.path === `/activities/${id}`);
      expect(read).toBeDefined();
    }
    expect(
      work.writes().find((call) => call.path.startsWith('/activities/p-start/'))?.body,
    ).toMatchObject({ expected_version: 9, status_id: E.running });
    // Nothing is ever written to the tasks board, nor to a task.
    expect(
      work.writes().some((call) => call.path.includes('/tasks') || /\/t-/.test(call.path)),
    ).toBe(false);
  });

  it('leaves alone a card that moved meanwhile, and says why', async () => {
    const { entry, otto, work, services } = await fixture();
    const { plan } = await entry.run({}, { profileId: otto.id });

    work.place.get('epics')?.set('e-start', W.blocked);
    work.relations.set('p-ready', []);

    const done = await services.plans.approve({ id: plan?.id ?? '' }, 'panel');
    const result = (id: string) => done.entrySync?.moves.find((move) => move.workId === id);

    expect(done.state).toBe('executado');
    expect(result('e-start')).toMatchObject({ result: 'pulado' });
    expect(result('e-start')?.resultNote).toContain('já não está em A fazer');
    expect(result('p-ready')).toMatchObject({
      result: 'pulado',
      resultNote: 'regra: o pedido não depende mais de um épico da Sigma',
    });
    expect(work.place.get('epics')?.get('e-start')).toBe(W.blocked);
  });

  it('refuses at the move a plan changed to break a rule', async () => {
    const { entry, otto, work, services } = await fixture();
    const { plan } = await entry.run({}, { profileId: otto.id });
    const [row] = await services.store.db
      .select()
      .from(plansTable)
      .where(eq(plansTable.id, plan?.id ?? ''));
    const sync = row?.entrySync;

    if (!sync) throw new Error('no sync');

    const epic = sync.moves.find((move) => move.workId === 'e-ready');
    if (epic) epic.toStatusId = W.accepted;
    sync.moves.push({
      ...(epic as NonNullable<typeof epic>),
      workId: 't-start',
      fromStatusId: W.todo,
      toStatusId: W.doing,
    });
    sync.moves.push({
      ...(epic as NonNullable<typeof epic>),
      workId: 'e-blocked',
      fromStatusId: W.blocked,
      toStatusId: W.doing,
    });
    await services.store.db
      .update(plansTable)
      .set({ entrySync: sync })
      .where(eq(plansTable.id, plan?.id ?? ''));

    const done = await services.plans.approve({ id: plan?.id ?? '' }, 'panel');
    const result = (id: string) => done.entrySync?.moves.find((move) => move.workId === id);

    expect(result('e-ready')?.resultNote).toContain('regra: um épico só vai para');
    expect(result('t-start')?.resultNote).toBe('não é um épico do board Epics da Sigma');
    expect(result('e-blocked')?.resultNote).toBe('regra: um épico em Bloqueado não sai de lá');
    expect(work.place.get('epics')?.get('e-ready')).toBe(W.doing);
    expect(work.place.get('tasks')?.get('t-start')).toBe(W.doing);
    expect(work.place.get('epics')?.get('e-blocked')).toBe(W.blocked);
  });

  it('makes no plan when the boards are already right', async () => {
    const work = memoryWork();
    work.add('e-1', 'epics', W.doing);
    work.add('t-1', 'epics', W.todo, { parent: 'e-1', on: [['tasks', W.review]] });
    work.add('p-1', 'entrada', E.running);
    work.relations.set('p-1', [dependsOn('e-1')]);
    work.add('p-2', 'entrada', E.prioritized);
    work.history.set('p-2', [
      {
        event_type: 'activity.moved',
        created_at: new Date(NOW - DAY).toISOString(),
        after_data: { status_id: E.prioritized },
      },
    ]);

    const { entry, otto, services } = await fixture({ work });
    const result = await entry.run({}, { profileId: otto.id });

    expect(result).toMatchObject({ moves: 0, stale: 0, unchanged: false });
    expect(result.plan).toBeUndefined();
    expect(await services.plans.list()).toEqual([]);
  });

  it('keeps the open plan when a new read says the same', async () => {
    const { entry, otto, services, told } = await fixture();
    const first = await entry.run({}, { profileId: otto.id });
    const asked = told.length;
    const second = await entry.run({}, { profileId: otto.id });

    expect(second).toMatchObject({ unchanged: true });
    expect(second.plan?.id).toBe(first.plan?.id);
    expect(await services.plans.list()).toHaveLength(1);
    expect(told).toHaveLength(asked);
  });

  it('runs without the owner once the Reviewer approves and the action is automatic', async () => {
    const { entry, otto, reviewer, services, work, owner, told } = await fixture({
      automatic: true,
    });
    const { plan } = await entry.run({}, { profileId: otto.id });
    const done = await services.plans.review(
      plan?.id ?? '',
      { revised: 'Mover 5 cards.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    expect(done).toMatchObject({ state: 'executado', approvedBy: 'automatico' });
    expect(work.place.get('epics')?.get('e-start')).toBe(W.doing);
    expect(owner).toEqual([]);
    expect(told.at(-1)).toMatchObject({
      profileId: otto.id,
      text: expect.stringContaining('5 movimento(s) feito(s)'),
    });
  });

  it('waits for the owner when the Reviewer finds something, and moves nothing', async () => {
    const { entry, otto, reviewer, services, work, owner } = await fixture({ automatic: true });
    const { plan } = await entry.run({}, { profileId: otto.id });

    await services.plans.updateSettings('entry_sync', { maxRounds: 0 });
    const waiting = await services.plans.review(
      plan?.id ?? '',
      {
        revised: 'x',
        findings: [{ kind: 'regra_sensivel', text: 'Avisa o suporte cedo.', source: 'B20' }],
        approved: true,
      },
      { profileId: reviewer.id },
    );

    expect(waiting.state).toBe('aguardando_po');
    expect(work.writes()).toEqual([]);
    expect(owner.at(-1)).toContain(`ok plano ${plan?.number}`);
  });

  it('without a Reviewer, still makes the plan and sends it straight to the owner, never automatic', async () => {
    const { entry, otto, services, work, owner } = await fixture({
      reviewer: false,
      automatic: true,
    });
    const { plan } = await entry.run({}, { profileId: otto.id });

    expect(plan).toMatchObject({ state: 'aguardando_po' });
    expect(plan?.reviewerProfileId).toBeUndefined();
    expect(owner.at(-1)).toContain('sem Revisor configurado');
    expect(owner.at(-1)).toContain('Pedido na Entrada "Loja": Priorizado → Em execução');
    expect(work.writes()).toEqual([]);

    const done = await services.plans.fromChat({ number: plan?.number ?? 0, approve: true });
    expect(done.state).toBe('executado');
    expect(work.place.get('entrada')?.get('p-start')).toBe(E.running);
  });

  it('takes the author skips, and leaves out what the owner refused', async () => {
    const { entry, otto, services } = await fixture();
    const first = await entry.run({}, { profileId: otto.id });

    await services.plans.reject({ id: first.plan?.id ?? '' }, { reason: 'Ainda não.' }, 'panel');

    const again = await entry.run(
      { skip: [{ workId: 'p-blocked', reason: 'o Moabe ainda vai comentar o motivo' }] },
      { profileId: otto.id },
    );

    // Everything was refused or skipped and the owner already heard of the old request.
    expect(again.plan).toBeUndefined();
    expect(again.message).toContain('Nada a mover');
    expect(again).toMatchObject({ moves: 0, stale: 0, skipped: 5 });
  });

  it('takes a plan given back with the new read and skips', async () => {
    const { entry, otto, reviewer, services, told } = await fixture();
    const first = await entry.run({}, { profileId: otto.id });

    await services.plans.review(
      first.plan?.id ?? '',
      {
        revised: 'x',
        findings: [{ kind: 'divergencia', text: 'Gestores foi pausado sem motivo.', source: 'x' }],
        approved: false,
      },
      { profileId: reviewer.id },
    );
    expect(told.at(-1)).toMatchObject({
      profileId: otto.id,
      text: expect.stringContaining('propose_entry_sync'),
    });

    const again = await entry.run(
      { skip: [{ workId: 'p-blocked', reason: 'esperar o comentário do Moabe' }] },
      { profileId: otto.id },
    );

    expect(again.plan?.id).toBe(first.plan?.id);
    expect(again.plan).toMatchObject({ state: 'em_revisao', rounds: 1 });
    expect(again.plan?.entrySync?.moves.map((move) => move.workId)).not.toContain('p-blocked');
    expect(again.plan?.entrySync?.skipped).toEqual([
      expect.objectContaining({ workId: 'p-blocked', reason: 'esperar o comentário do Moabe' }),
    ]);
    await expect(
      services.plans.write(first.plan?.id ?? '', { text: 'x' }, { profileId: otto.id }),
    ).rejects.toThrow('propose_entry_sync');
  });

  it('stops when an Entrada column is not the one recorded', async () => {
    const { services, otto } = await fixture();
    const changed = new EntrySync(
      services.store,
      async () => memoryWork().client,
      async () => otto.id,
      { ...target, entryColumnIds: { ...target.entryColumnIds, prioritized: 'ffffffff' } },
    );

    await expect(changed.read()).rejects.toThrow('not the one recorded');
  });
});
