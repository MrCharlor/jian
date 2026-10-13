import { describe, expect, it } from 'vitest';
import type { BoardCard, MoveInput, WorkBoard } from '../src/priorities/work-board.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

const BOARD = 'board-entrada';
const PRIORIZADO = 'status-priorizado';
const APROVADO = 'status-aprovado';

const proposal = {
  workspaceId: 'ws',
  boardId: BOARD,
  statusId: PRIORIZADO,
  sourceStatusId: APROVADO,
  summary: 'Loja parada primeiro.',
  cards: [
    { workId: 'c', reason: 'Loja parada.' },
    { workId: 'd', reason: 'Suporte urgente.', raise: true },
    { workId: 'a', reason: 'Depende do épico de cores.' },
  ],
};

const finding = {
  kind: 'regra_sensivel' as const,
  text: 'Tira do topo um card que o Moabe fixou.',
  source: 'priorização #1',
};

/** A board held in memory, as the real one moves cards: next to both neighbours. */
function memoryBoard(columns: Record<string, string[]>) {
  const cards = new Map<string, BoardCard>();
  const state: Record<string, string[]> = {};
  const moves: Array<{ id: string } & MoveInput> = [];

  for (const [status, ids] of Object.entries(columns)) {
    state[status] = [...ids];
    for (const id of ids) cards.set(id, { id, title: `Card ${id}`, version: 1, boardId: BOARD });
  }

  const board: WorkBoard = {
    async column(status) {
      return (state[status] ?? []).map((id) => ({ ...(cards.get(id) as BoardCard) }));
    },
    async move(card, input) {
      moves.push({ id: card.id, ...input });
      for (const status of Object.keys(state)) {
        state[status] = (state[status] ?? []).filter((id) => id !== card.id);
      }
      const target = state[input.statusId] ?? [];
      const at = input.aboveId ? target.indexOf(input.aboveId) + 1 : 0;
      if (target[at] !== input.belowId) throw new Error('not adjacent');
      target.splice(at, 0, card.id);
      state[input.statusId] = target;
      const moved = { ...(cards.get(card.id) as BoardCard), version: card.version + 1 };
      cards.set(card.id, moved);
      return moved;
    },
  };

  return { board, state, moves };
}

async function fixture(options: { reviewer?: boolean; automatic?: boolean } = {}) {
  const services = await testServices();
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
  const session = await services.sessions.createSession(otto.id, { title: 'Priorização' });
  const memory = memoryBoard({ [PRIORIZADO]: ['a', 'b', 'c'], [APROVADO]: ['d'] });
  const told: Array<{ profileId: string; text: string }> = [];
  const owner: string[] = [];

  services.priorities.useBoards(async () => memory.board);
  services.plans.useAgents(async (profileId, _session, said) =>
    told.push({ profileId, text: said }),
  );
  services.plans.useOwner(async (said) => owner.push(said));

  if (options.reviewer !== false) {
    await services.plans.updateSettings('priority', {
      reviewerProfileId: reviewer.id,
      automatic: options.automatic ?? false,
    });
  }

  const by = { profileId: otto.id, sessionId: session.id, name: 'Otto' };

  return { services, otto, reviewer, session, memory, told, owner, by };
}

describe('plans before a prioritization', () => {
  it('keeps the old flow when no Reviewer is set for prioritization', async () => {
    const { services, memory, by } = await fixture({ reviewer: false });
    const proposed = await services.priorities.propose(proposal, by);

    expect(proposed.planNumber).toBeUndefined();
    expect(await services.plans.list()).toEqual([]);

    await services.priorities.apply({ number: proposed.number }, {}, 'agent');
    expect(memory.state[PRIORIZADO]).toEqual(['c', 'd', 'a', 'b']);
  });

  it('turns a proposed order into a plan the agent cannot apply past', async () => {
    const { services, otto, reviewer, memory, told, by } = await fixture();
    const proposed = await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();

    expect(plan).toMatchObject({
      action: 'priority',
      state: 'em_revisao',
      authorProfileId: otto.id,
      title: `Priorização #${proposed.number}`,
      priority: {
        number: proposed.number,
        cards: [
          { workId: 'c', reason: 'Loja parada.', raise: false },
          { workId: 'd', raise: true },
          { workId: 'a' },
          { workId: 'b', raise: false },
        ],
      },
    });
    expect(proposed.planNumber).toBe(plan?.number);
    expect(plan?.original).toContain('1. Card c: Loja parada.');
    expect(plan?.original).toContain('2. Card d (sobe do Aprovado): Suporte urgente.');
    expect(told.at(-1)).toMatchObject({
      profileId: reviewer.id,
      text: expect.stringContaining('muda a posição de um card que o Moabe já fixou'),
    });

    await expect(
      services.priorities.apply({ number: proposed.number }, {}, 'agent'),
    ).rejects.toThrow(`waits for plan #${plan?.number}`);
    await expect(
      services.plans.write(plan?.id ?? '', { text: 'x' }, { profileId: otto.id }),
    ).rejects.toThrow('propose_priorities');
    expect(memory.moves).toEqual([]);
  });

  it('applies the order on the board once the owner approves the plan', async () => {
    const { services, reviewer, memory, owner, by } = await fixture();
    const proposed = await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();
    const id = plan?.id ?? expect.fail('no plan');

    const reviewed = await services.plans.review(
      id,
      { revised: 'Ordem pelos critérios.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    expect(reviewed.state).toBe('aguardando_po');
    expect(owner).toEqual([
      expect.stringContaining(`Plano #${plan?.number} esperando você: Priorização #`),
    ]);
    expect(memory.moves).toEqual([]);

    const done = await services.plans.approve({ id }, 'panel');

    expect(done).toMatchObject({ state: 'executado', approvedBy: 'owner', decidedVia: 'panel' });
    expect(memory.state[PRIORIZADO]).toEqual(['c', 'd', 'a', 'b']);
    expect(memory.state[APROVADO]).toEqual([]);
    expect(await services.priorities.get({ number: proposed.number })).toMatchObject({
      state: 'aplicada',
      decidedVia: 'panel',
    });
  });

  it('applies the order without the owner when the action is automatic', async () => {
    const { services, otto, reviewer, memory, owner, told, by } = await fixture({
      automatic: true,
    });
    await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();

    const reviewed = await services.plans.review(
      plan?.id ?? '',
      { revised: 'Ordem pelos critérios.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    expect(reviewed).toMatchObject({ state: 'executado', approvedBy: 'automatico' });
    expect(owner).toEqual([]);
    expect(memory.state[PRIORIZADO]).toEqual(['c', 'd', 'a', 'b']);
    expect(told.at(-1)).toMatchObject({
      profileId: otto.id,
      text: expect.stringContaining('aplicada no Work'),
    });
  });

  it('takes a new proposal into the plan sent back, and keeps the owner’s correction', async () => {
    const { services, otto, reviewer, told, by } = await fixture();
    await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();
    const id = plan?.id ?? expect.fail('no plan');

    const back = await services.plans.review(
      id,
      { revised: 'Ordem.', findings: [finding], approved: false },
      { profileId: reviewer.id },
    );

    expect(back).toMatchObject({ state: 'devolvido', rounds: 1 });
    expect(told.at(-1)).toMatchObject({
      profileId: otto.id,
      text: expect.stringContaining('propose_priorities'),
    });

    const again = await services.priorities.propose(
      { ...proposal, cards: [{ workId: 'a', reason: 'Fixado pelo Moabe.' }] },
      by,
    );

    expect(again.planNumber).toBe(plan?.number);
    expect(await services.plans.list()).toHaveLength(1);
    expect(await services.plans.get(id)).toMatchObject({
      state: 'em_revisao',
      rounds: 1,
      priority: { number: again.number },
    });

    await services.plans.review(
      id,
      { revised: 'Ordem.', findings: [], approved: true },
      { profileId: reviewer.id },
    );
    await services.plans.giveBack({ id }, { reason: 'Troca vem antes de Auditoria' }, 'panel');

    expect((await services.quality.corrections(otto.id))[0]).toMatchObject({
      automation: 'priorizacao',
      note: 'Troca vem antes de Auditoria',
    });

    await services.priorities.propose(proposal, by);
    expect(told.at(-1)).toMatchObject({
      profileId: reviewer.id,
      text: expect.stringContaining('Troca vem antes de Auditoria'),
    });
  });

  it('discards the proposal when the owner refuses the plan', async () => {
    const { services, memory, by } = await fixture();
    const proposed = await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();

    await services.plans.reject({ id: plan?.id ?? '' }, { reason: 'Não agora.' }, 'panel');

    expect(await services.priorities.get({ number: proposed.number })).toMatchObject({
      state: 'descartada',
      note: expect.stringContaining('Não agora.'),
    });
    expect(memory.moves).toEqual([]);
  });

  it('ends the plan when the owner applies the held proposal from its own page', async () => {
    const { services, memory, by } = await fixture();
    const proposed = await services.priorities.propose(proposal, by);
    const [plan] = await services.plans.list();

    await services.priorities.apply({ id: proposed.id }, { order: ['a', 'c'] }, 'panel');

    expect(memory.state[PRIORIZADO]).toEqual(['a', 'c', 'b']);
    expect(await services.plans.get(plan?.id ?? '')).toMatchObject({
      state: 'executado',
      approvedBy: 'owner',
    });
  });

  it('keeps the settings of each action apart', async () => {
    const { services, reviewer } = await fixture();

    expect(await services.plans.settings('priority')).toMatchObject({
      action: 'priority',
      reviewerProfileId: reviewer.id,
      automatic: false,
      maxRounds: 2,
    });
    expect(await services.plans.settings('prototype')).toEqual({
      action: 'prototype',
      automatic: false,
      maxRounds: 2,
    });
    expect((await services.plans.routines()).actions.map((item) => item.action)).toEqual([
      'prototype',
      'priority',
      'entry_sync',
    ]);
  });
});
