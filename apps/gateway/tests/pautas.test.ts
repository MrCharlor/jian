import { parseDecisionReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const agent = {
  name: 'Subaru',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const decision = {
  question: 'A listagem abre já filtrada por ativos?',
  options: ['Abre em Todos', 'Abre em Ativos'],
  counterpoint: 'Abrir em Ativos esconde cores inativas que o cadastro ainda usa.',
  recommendation: 'Abre em Todos, como as outras listagens do ERP.',
};

async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(agent);
  const session = await services.sessions.createSession(profile.id, { title: 'Pautas' });
  const pauta = await services.pautas.create({
    title: 'Cores de Aparelhos',
    state: 'em-execucao',
    priority: 'alta',
    screens: [{ route: '/hardware/cores', name: 'Listagem de cores' }],
    links: [{ kind: 'pedido', workId: 'abc', column: 'Novo' }],
  });

  return { services, profile, session, pauta };
}

describe('the decision reply', () => {
  it('reads the number, the choice and the reason', () => {
    expect(parseDecisionReply('decisão 4: B, porque é o padrão')).toEqual({
      number: 4,
      choice: 'B',
      reason: 'é o padrão',
    });
    expect(parseDecisionReply('Decisao #12 - Abre em Todos')).toEqual({
      number: 12,
      choice: 'Abre em Todos',
    });
    expect(parseDecisionReply('a decisão 4 foi boa')).toBeUndefined();
  });
});

describe('pautas', () => {
  it('keeps what a card was before a new reading moved it', async () => {
    const { services, pauta } = await fixture();

    const read = await services.pautas.update(pauta.id, {
      links: [{ kind: 'pedido', workId: 'abc', column: 'Aprovado' }],
    });

    expect(read.links[0]).toMatchObject({
      column: 'Aprovado',
      previousColumn: 'Novo',
      readAt: expect.any(String),
    });
  });

  it('numbers a proposal, lets only a pending one be decided, and never changes a decided one', async () => {
    const { services, profile, session, pauta } = await fixture();
    const proposed = await services.pautas.propose(pauta.id, decision, {
      profileId: profile.id,
      sessionId: session.id,
      name: 'Subaru',
    });

    expect(proposed).toMatchObject({ number: 1, state: 'proposta', proposedBy: 'Subaru' });
    await expect(
      services.pautas.propose(pauta.id, { ...decision, options: ['só uma'] }),
    ).rejects.toThrow();

    const decided = await services.pautas.decide(
      { number: 1 },
      { choice: 'Abre em Todos' },
      'panel',
    );

    expect(decided).toMatchObject({
      state: 'decidida',
      choice: 'Abre em Todos',
      decidedVia: 'panel',
    });
    await expect(
      services.pautas.decide({ number: 1 }, { choice: 'Abre em Ativos' }, 'panel'),
    ).rejects.toThrow('already decidida');
    expect((await services.memories.memories(profile.id)).map((memory) => memory.key)).toContain(
      'decisao-1',
    );
  });

  it('lets a new decision replace a decided one', async () => {
    const { services, pauta } = await fixture();
    await services.pautas.propose(pauta.id, decision);
    await services.pautas.decide({ number: 1 }, { choice: 'Abre em Todos' }, 'api');

    await services.pautas.propose(pauta.id, { ...decision, replaces: 1 });
    await services.pautas.decide(
      { number: 2 },
      { choice: 'Abre em Ativos', reason: 'pedido da Auditoria' },
      'api',
    );

    const states = (await services.pautas.get(pauta.id)).decisions.map(
      (item) => `${item.number}:${item.state}`,
    );
    expect(states).toEqual(['1:descartada', '2:decidida']);
  });

  it('takes the owner’s "decisão N" in a chat and hands the agent the decision', async () => {
    const { services, session, profile, pauta } = await fixture();
    await services.pautas.propose(pauta.id, decision, {
      profileId: profile.id,
      sessionId: session.id,
      name: 'Subaru',
    });

    const run = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'decisão 1: Abre em Todos, porque é o padrão', requestKey: 'answer' },
      { ownerMessage: true },
    );

    expect(run.input).toContain('[Decisão #1 tomada pelo Moabe] Abre em Todos');
    expect((await services.pautas.get(pauta.id)).decisions[0]).toMatchObject({
      state: 'decidida',
      reason: 'é o padrão',
      decidedVia: 'panel',
    });
  });
});

describe('the agents board', () => {
  it('shows each agent’s tasks with their topic and how long they stayed in each column', async () => {
    let now = Date.parse('2026-10-09T09:00:00Z');
    const services = await testServices(() => now);
    const profile = await services.profiles.createProfile(agent);
    const pauta = await services.pautas.create({ title: 'Cores de Aparelhos' });
    const session = await services.sessions.createSession(profile.id, { title: 'Trabalho' });
    const item = await services.work.create(
      profile.id,
      { title: 'Escrever o épico', description: 'Épico da listagem de cores.', pautaId: pauta.id },
      session.id,
    );

    now += 60_000;
    const doing = await services.work.update(profile.id, item.id, {
      status: 'in_progress',
      expectedVersion: 1,
    });
    now += 600_000;
    await services.work.update(profile.id, item.id, {
      status: 'done',
      expectedVersion: doing.version,
    });

    const [card] = await services.pautas.board();

    expect(card).toMatchObject({
      title: 'Escrever o épico',
      agent: 'Subaru',
      pauta: 'Cores de Aparelhos',
      status: 'done',
      workedMs: 600_000,
    });
    expect(card?.byStatus).toMatchObject({ todo: 60_000, in_progress: 600_000 });
  });
});
