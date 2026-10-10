import { describe, expect, it } from 'vitest';
import type { BoardCard, MoveInput, WorkBoard } from '../src/priorities/work-board.js';
import { workBoardOpener, workClientOpener } from '../src/priorities/work-board.js';
import { testServices } from './helpers/services.js';

const agent = {
  name: 'Otto',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const BOARD = 'board-entrada';
const PRIORIZADO = 'status-priorizado';
const APROVADO = 'status-aprovado';
const where = { workspaceId: 'ws', boardId: BOARD, statusId: PRIORIZADO };

/** A board held in memory: columns in order, and every move it was asked for. */
function memoryBoard(columns: Record<string, string[]>) {
  const cards = new Map<string, BoardCard>();
  const state: Record<string, string[]> = {};
  const moves: Array<{ id: string } & MoveInput> = [];
  let failOn: string | undefined;

  for (const [status, ids] of Object.entries(columns)) {
    state[status] = [...ids];
    for (const id of ids) cards.set(id, { id, title: `Card ${id}`, version: 1, boardId: BOARD });
  }

  const board: WorkBoard = {
    async column(status) {
      return (state[status] ?? []).map((id) => ({ ...(cards.get(id) as BoardCard) }));
    },
    async move(card, input) {
      if (card.id === failOn) throw new Error('board down');
      moves.push({ id: card.id, ...input });
      for (const status of Object.keys(state)) {
        state[status] = (state[status] ?? []).filter((id) => id !== card.id);
      }
      const target = state[input.statusId] ?? [];
      const at = input.aboveId ? target.indexOf(input.aboveId) + 1 : 0;
      // The real board refuses neighbours that are not next to each other.
      if (target[at] !== input.belowId) throw new Error('not adjacent');
      target.splice(at, 0, card.id);
      state[input.statusId] = target;
      const moved = { ...(cards.get(card.id) as BoardCard), version: card.version + 1 };
      cards.set(card.id, moved);
      return moved;
    },
  };

  return {
    board,
    state,
    moves,
    fail: (id: string) => {
      failOn = id;
    },
  };
}

async function fixture(columns: Record<string, string[]>) {
  const services = await testServices();
  const profile = await services.profiles.createProfile(agent);
  const session = await services.sessions.createSession(profile.id, { title: 'Priorização' });
  const memory = memoryBoard(columns);
  services.priorities.useBoards(async () => memory.board);
  const by = { profileId: profile.id, sessionId: session.id, name: 'Otto' };

  return { services, profile, memory, by };
}

describe('a proposed order', () => {
  it('names the cards, raises the approved ones and keeps a forgotten card last', async () => {
    const { services, by } = await fixture({ [PRIORIZADO]: ['a', 'b', 'c'], [APROVADO]: ['d'] });

    const proposal = await services.priorities.propose(
      {
        ...where,
        sourceStatusId: APROVADO,
        summary: 'Loja parada primeiro.',
        cards: [
          { workId: 'c', reason: 'Loja parada.' },
          { workId: 'd', reason: 'Suporte urgente.', raise: true },
          { workId: 'a', reason: 'Depende do épico de cores.' },
        ],
      },
      by,
    );

    expect(proposal).toMatchObject({ number: 1, state: 'proposta', proposedBy: 'Otto' });
    expect(proposal.current.map((card) => card.workId)).toEqual(['a', 'b', 'c']);
    expect(proposal.cards).toEqual([
      { workId: 'c', title: 'Card c', reason: 'Loja parada.', raise: false },
      { workId: 'd', title: 'Card d', reason: 'Suporte urgente.', raise: true },
      { workId: 'a', title: 'Card a', reason: 'Depende do épico de cores.', raise: false },
      { workId: 'b', title: 'Card b', raise: false },
    ]);

    const next = await services.priorities.propose(
      { ...where, summary: 'De novo.', cards: [{ workId: 'a', reason: 'x' }] },
      by,
    );
    const [latest, first] = await services.priorities.list();

    expect(latest?.number).toBe(next.number);
    expect(first).toMatchObject({ number: 1, state: 'descartada' });
  });

  it('refuses a card that is in neither column', async () => {
    const { services, by } = await fixture({ [PRIORIZADO]: ['a'] });

    await expect(
      services.priorities.propose(
        { ...where, summary: 's', cards: [{ workId: 'zz', reason: 'r' }] },
        by,
      ),
    ).rejects.toThrow('not in the column');
  });
});

describe('applying an order', () => {
  it('moves only the cards out of place and counts a clean round', async () => {
    const { services, profile, memory, by } = await fixture({ [PRIORIZADO]: ['a', 'b', 'c'] });
    const proposal = await services.priorities.propose(
      {
        ...where,
        summary: 's',
        cards: [
          { workId: 'a', reason: '1' },
          { workId: 'c', reason: '2' },
          { workId: 'b', reason: '3' },
        ],
      },
      by,
    );

    const applied = await services.priorities.apply({ id: proposal.id }, {}, 'panel');

    expect(memory.state[PRIORIZADO]).toEqual(['a', 'c', 'b']);
    expect(memory.moves).toEqual([{ id: 'c', statusId: PRIORIZADO, aboveId: 'a', belowId: 'b' }]);
    expect(applied).toMatchObject({ state: 'aplicada', adjusted: false, decidedVia: 'panel' });
    expect(await services.quality.report(profile.id)).toContainEqual(
      expect.objectContaining({ automation: 'priorizacao', rounds: 1, corrections: 0 }),
    );
  });

  it('applies the owner’s order, raises the approved card, and learns from the adjustment', async () => {
    const { services, profile, memory, by } = await fixture({
      [PRIORIZADO]: ['a', 'b'],
      [APROVADO]: ['d', 'e'],
    });
    const proposal = await services.priorities.propose(
      {
        ...where,
        sourceStatusId: APROVADO,
        summary: 's',
        cards: [
          { workId: 'e', reason: 'urgente', raise: true },
          { workId: 'a', reason: '1' },
          { workId: 'b', reason: '2' },
        ],
      },
      by,
    );

    const applied = await services.priorities.apply(
      { id: proposal.id },
      { order: ['a', 'e', 'b'] },
      'panel',
    );

    expect(memory.state[PRIORIZADO]).toEqual(['a', 'e', 'b']);
    expect(memory.state[APROVADO]).toEqual(['d']);
    expect(applied.adjusted).toBe(true);

    const [row] = (await services.quality.report(profile.id)).filter(
      (item) => item.automation === 'priorizacao',
    );
    expect(row).toMatchObject({ rounds: 1, corrections: 1, clean: 0 });
    expect(row?.lastCorrection).toMatchObject({
      kind: 'edited',
      original: '1. Card e\n2. Card a\n3. Card b',
      corrected: '1. Card a\n2. Card e\n3. Card b',
    });
    expect((await services.memories.memories(profile.id)).map((item) => item.key)).toContain(
      'priorizacao-1',
    );
  });

  it('stops before any move when a card left the columns, and keeps a failed move retryable', async () => {
    const { services, memory, by } = await fixture({ [PRIORIZADO]: ['a', 'b'] });
    const proposal = await services.priorities.propose(
      {
        ...where,
        summary: 's',
        cards: [
          { workId: 'b', reason: '1' },
          { workId: 'a', reason: '2' },
        ],
      },
      by,
    );

    memory.state[PRIORIZADO] = ['a'];
    await expect(services.priorities.apply({ id: proposal.id }, {}, 'panel')).rejects.toThrow(
      'saiu das colunas',
    );
    expect(memory.moves).toEqual([]);

    memory.state[PRIORIZADO] = ['a', 'b'];
    memory.fail('b');
    await expect(services.priorities.apply({ id: proposal.id }, {}, 'panel')).rejects.toThrow(
      'board down',
    );
    expect(await services.priorities.get({ id: proposal.id })).toMatchObject({
      state: 'proposta',
      error: 'board down',
    });
  });

  it('counts a discarded order as a refusal', async () => {
    const { services, profile, by } = await fixture({ [PRIORIZADO]: ['a'] });
    const proposal = await services.priorities.propose(
      { ...where, summary: 's', cards: [{ workId: 'a', reason: 'r' }] },
      by,
    );

    await services.priorities.discard(proposal.id, { note: 'Esperar a reunião.' }, 'panel');

    expect(
      (await services.quality.report(profile.id)).find((item) => item.automation === 'priorizacao'),
    ).toMatchObject({ rounds: 1, corrections: 1, lastCorrection: { kind: 'rejected' } });
  });
});

describe('the board client', () => {
  it('reaches the board with the key of the connected server', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      ...agent,
      mcpServers: [
        {
          name: 'work',
          transport: 'http',
          url: 'https://work.example/v1/mcp',
          auth: 'headers',
          headers: [{ name: 'Authorization', value: 'Bearer secret-key' }],
        },
      ],
    });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(
          init.method === 'GET'
            ? { items: [{ id: 'a', title: 'A', version: 3, board_id: BOARD }], next_cursor: '' }
            : { id: 'a', title: 'A', version: 4, board_id: BOARD },
        ),
      );
    }) as unknown as typeof fetch;

    const board = await workBoardOpener(
      workClientOpener(services.profiles, services.vault, fetcher),
    )(profile.id, { workspaceId: 'ws', boardId: BOARD });
    const [card] = await board.column(PRIORIZADO);
    await board.move(card as BoardCard, { statusId: PRIORIZADO, aboveId: 'b' });

    expect(calls[0]?.url).toBe(
      `https://work.example/v1/workspaces/ws/boards/${BOARD}/activities/column?status_id=${PRIORIZADO}&limit=100`,
    );
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer secret-key');
    expect(calls[1]?.url).toBe('https://work.example/v1/workspaces/ws/activities/a/move');
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      status_id: PRIORIZADO,
      expected_version: 3,
      before_activity_id: 'b',
      after_activity_id: null,
    });
  });
});
