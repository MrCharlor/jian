import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKnowledgeReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Generator } from '../src/prototypes/generator.js';
import { Prototypes } from '../src/prototypes/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const admin = { authorization: `Bearer ${token}` };

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

const inventario = (ref: string) => ({ kind: 'inventario' as const, ref, date: '2026-09-25' });

/** A slice of the inventory: rules of every scope, one sensitive, one replaced. */
const load = {
  rules: [
    {
      code: 'G10',
      text: 'Nunca usar travessão em texto que vai ao Work.',
      scope: { kind: 'geral' as const },
      source: inventario('mem:feedback_sem_travessao'),
    },
    {
      code: 'E01',
      text: 'Busca da listagem acha por parte do nome.',
      scope: { kind: 'tipo_de_tela' as const, application: 'ERP', screen: 'listagem' },
      source: inventario('plano 1'),
    },
    {
      code: 'E02',
      text: 'Exportar fica no canto direito do cabeçalho da listagem.',
      scope: { kind: 'tipo_de_tela' as const, application: 'ERP', screen: 'listagem' },
      source: inventario('plano 1'),
    },
    {
      code: 'C01',
      text: 'Cores de Aparelhos mostra a cor como amostra ao lado do nome.',
      scope: { kind: 'tela' as const, application: 'ERP', screen: 'Cores de Aparelhos' },
      source: inventario('plano 1'),
    },
    {
      code: 'AG01',
      text: 'Até 5 lojas, uma linha por loja; acima, o resumo.',
      scope: { kind: 'aplicacao' as const, application: 'App Gestores' },
      source: inventario('mem:feedback_regra_por_numero_de_lojas'),
    },
    {
      code: 'FI30',
      text: 'Campo fiscal com nota emitida não é editável, salvo nota cancelada.',
      scope: { kind: 'tela' as const, application: 'ERP', screen: 'Marco Fiscal' },
      source: inventario('CLAUDE-fiscal'),
      sensitive: true,
      state: 'pendente' as const,
    },
    {
      code: 'X01',
      text: 'Situação da listagem tem só Ativo e Inativo.',
      scope: { kind: 'tipo_de_tela' as const, application: 'ERP', screen: 'listagem' },
      source: inventario('plano 1'),
    },
    {
      code: 'X02',
      text: 'Situação da listagem tem Ativo, Inativo e Todos, com Ativo marcado ao abrir.',
      scope: { kind: 'tipo_de_tela' as const, application: 'ERP', screen: 'listagem' },
      source: inventario('plano 2'),
      replaces: 'X01',
    },
  ],
};

async function fixture(options: { automatic?: boolean; sensitiveAlwaysAsks?: boolean } = {}) {
  const services = await testServices();
  const curator = await services.profiles.createProfile({
    name: 'Curador',
    instructions: 'Keep the base.',
    model,
  });
  const other = await services.profiles.createProfile({
    name: 'Subaru',
    instructions: 'Help.',
    model,
  });
  const owner: string[] = [];
  const told: Array<{ profileId: string; text: string }> = [];

  services.knowledge.useOwner(async (text) => owner.push(text));
  services.knowledge.useAgents(async (profileId, _session, text) => told.push({ profileId, text }));
  await services.knowledge.updateSettings({
    curatorProfileId: curator.id,
    ...(options.automatic !== undefined ? { automatic: options.automatic } : {}),
    ...(options.sensitiveAlwaysAsks !== undefined
      ? { sensitiveAlwaysAsks: options.sensitiveAlwaysAsks }
      : {}),
  });

  return { services, curator, other, owner, told };
}

const proposal = {
  kind: 'incluir' as const,
  text: 'Filtro de Situação abre com Ativo marcado.',
  scope: { kind: 'tipo_de_tela' as const, application: 'ERP', screen: 'listagem' },
  reason: 'O Moabe respondeu isso no plano 3.',
  source: { kind: 'plano' as const, ref: 'Plano #3', date: '2026-10-13' },
};

describe('knowledge base', () => {
  it('loads a batch once, retiring a replaced rule, and refuses a replacement it cannot find', async () => {
    const { services } = await fixture();

    const first = await services.knowledge.import(load);
    expect(first.created).toHaveLength(8);
    expect(first.skipped).toEqual([]);

    const rules = await services.knowledge.list();
    const byCode = new Map(rules.map((rule) => [rule.code, rule]));
    expect(byCode.get('X01')?.state).toBe('aposentada');
    expect(byCode.get('X02')).toMatchObject({
      state: 'ativa',
      replaces: byCode.get('X01')?.number,
    });
    expect(byCode.get('FI30')).toMatchObject({ state: 'pendente', sensitive: true });

    const again = await services.knowledge.import(load);
    expect(again.created).toEqual([]);
    expect(again.skipped).toHaveLength(8);

    await expect(
      services.knowledge.import({
        rules: [
          { ...load.rules[0], code: 'N01' },
          { ...load.rules[1], code: 'N02', replaces: 'Z99' },
        ],
      }),
    ).rejects.toThrow('Z99');
    expect(await services.knowledge.list()).toHaveLength(8);
  });

  it('serves the load, the list, an edit and the settings over the API', async () => {
    const { services } = await fixture();
    const app = createApp({ ...services, token, logger: false });

    try {
      const loaded = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/import',
        headers: admin,
        payload: load,
      });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.json().created).toHaveLength(8);

      const bad = await app.inject({
        method: 'POST',
        url: '/v1/knowledge/import',
        headers: admin,
        payload: { rules: [{ text: 'Sem escopo.', source: { kind: 'manual' } }] },
      });
      expect(bad.statusCode).toBe(400);

      const listed = await app.inject({
        method: 'GET',
        url: '/v1/knowledge?application=ERP&state=ativa&q=exportar',
        headers: admin,
      });
      const [rule] = listed.json();
      expect(rule).toMatchObject({ code: 'E02' });

      const retired = await app.inject({
        method: 'PATCH',
        url: `/v1/knowledge/${rule.id}`,
        headers: admin,
        payload: { state: 'aposentada' },
      });
      expect(retired.json()).toMatchObject({ state: 'aposentada' });

      const settings = await app.inject({
        method: 'PUT',
        url: '/v1/knowledge-settings',
        headers: admin,
        payload: { automatic: true },
      });
      expect(settings.json()).toMatchObject({ automatic: true, sensitiveAlwaysAsks: true });
    } finally {
      await app.close();
    }
  });

  it('filters the list and finds rules by where they hold', async () => {
    const { services } = await fixture();
    await services.knowledge.import(load);

    expect(
      (await services.knowledge.list({ application: 'erp', state: 'ativa' })).map((r) => r.code),
    ).toEqual(expect.arrayContaining(['E01', 'E02', 'C01', 'X02']));
    expect(
      (await services.knowledge.list({ screen: 'Cores de Aparelhos' })).map((r) => r.code),
    ).toEqual(['C01']);
    expect((await services.knowledge.list({ q: 'listagens exportar' })).map((r) => r.code)).toEqual(
      ['E02'],
    );

    // An agent never reads a pending or retired rule, nor one of another application.
    const found = await services.knowledge.lookup({ q: 'situação', application: 'VXCASE ERP' });
    expect(found.map((rule) => rule.text)).toEqual([
      'Situação da listagem tem Ativo, Inativo e Todos, com Ativo marcado ao abrir.',
    ]);
    expect(
      (await services.knowledge.lookup({ application: 'erp' })).map((rule) => rule.text),
    ).not.toContain('Até 5 lojas, uma linha por loja; acima, o resumo.');

    // A plan carries its screen's rules first, then every listing of the ERP, never another
    // screen's rule or a rule of the App Gestores.
    const relevant = await services.knowledge.relevant({
      applications: ['erp', 'VXCASE ERP'],
      screen: 'Cores de Aparelhos',
      text: 'Cores de Aparelhos: listagem com filtro por situação, sem travessão no texto',
    });
    expect(relevant.map((rule) => rule.code)).toEqual(['C01', 'X02', 'E02', 'E01', 'G10']);
  });

  it('keeps a proposal waiting for the owner, and only the Curator proposes', async () => {
    const { services, curator, other, owner } = await fixture();

    await expect(services.knowledge.propose(proposal, { profileId: other.id })).rejects.toThrow(
      'Only the Curator',
    );

    const waiting = await services.knowledge.propose(proposal, { profileId: curator.id });
    expect(waiting).toMatchObject({ state: 'aguardando_po', proposedBy: 'Curador' });
    expect(owner).toEqual([expect.stringContaining(`ok regra ${waiting.number}`)]);
    expect(await services.knowledge.list()).toEqual([]);

    const applied = await services.knowledge.approve({ id: waiting.id }, 'panel');
    expect(applied).toMatchObject({ state: 'aplicada', appliedBy: 'owner', decidedVia: 'panel' });
    expect(await services.knowledge.list()).toMatchObject([
      { number: applied.resultNumber, text: proposal.text, state: 'ativa' },
    ]);
    await expect(services.knowledge.approve({ id: waiting.id })).rejects.toThrow('already');
  });

  it('applies on its own when automatic, but holds a sensitive change for the owner', async () => {
    const { services, curator, owner } = await fixture({ automatic: true });
    await services.knowledge.import(load);
    const fiscal = (await services.knowledge.list({ q: 'nota emitida' }))[0];

    const plain = await services.knowledge.propose(proposal, { profileId: curator.id });
    expect(plain).toMatchObject({ state: 'aplicada', appliedBy: 'automatico' });
    expect(owner).toEqual([]);

    // Changing a sensitive rule is sensitive, whatever the Curator marked.
    const held = await services.knowledge.propose(
      {
        kind: 'mudar',
        ruleNumber: fiscal?.number,
        text: 'Campo fiscal com nota emitida nunca é editável.',
        reason: 'Correção do Moabe.',
        source: { kind: 'correcao', ref: 'corrige', date: '2026-10-13' },
      },
      { profileId: curator.id },
    );
    expect(held).toMatchObject({ state: 'aguardando_po', sensitive: true });
    expect(owner).toEqual([expect.stringContaining('sensível')]);

    const applied = await services.knowledge.approve({ number: held.number });
    const rules = await services.knowledge.list();
    expect(rules.find((rule) => rule.id === fiscal?.id)?.state).toBe('aposentada');
    expect(rules.find((rule) => rule.number === applied.resultNumber)).toMatchObject({
      text: 'Campo fiscal com nota emitida nunca é editável.',
      sensitive: true,
      replaces: fiscal?.number,
      scope: fiscal?.scope,
    });

    // With "sensível sempre pede OK" off, a sensitive one applies too.
    await services.knowledge.updateSettings({ sensitiveAlwaysAsks: false });
    const retired = await services.knowledge.propose(
      {
        kind: 'aposentar',
        ruleNumber: applied.resultNumber,
        sensitive: true,
        reason: 'Regra mudou.',
        source: { kind: 'decisao', ref: 'Decisão #2' },
      },
      { profileId: curator.id },
    );
    expect(retired.state).toBe('aplicada');
  });

  it('takes "ok regra N" and "recusa regra N" from the owner in a chat', async () => {
    const { services, curator, other } = await fixture();
    const session = await services.sessions.createSession(other.id, { title: 'Moabe' });
    const first = await services.knowledge.propose(proposal, { profileId: curator.id });
    const second = await services.knowledge.propose(
      { ...proposal, text: 'Exportar vai no rodapé.' },
      { profileId: curator.id },
    );

    const ok = await services.runs.submit(
      other.id,
      session.id,
      { text: `ok regra ${first.number}`, requestKey: 'ok' },
      { ownerMessage: true },
    );
    expect(ok.input).toContain('aprovou');
    await services.runs.cancel(other.id, ok.id);

    const no = await services.runs.submit(
      other.id,
      session.id,
      { text: `recusa regra ${second.number}: o Exportar fica no cabeçalho`, requestKey: 'no' },
      { ownerMessage: true },
    );
    expect(no.input).toContain('recusou');
    expect((await services.knowledge.proposals()).map((item) => item.state).sort()).toEqual([
      'aplicada',
      'recusada',
    ]);
    expect((await services.knowledge.proposals({ state: 'recusada' }))[0]?.note).toBe(
      'o Exportar fica no cabeçalho',
    );

    expect(parseKnowledgeReply('regra #4: ok')).toEqual({ number: 4, approve: true });
    expect(parseKnowledgeReply('recusa regra 4')).toEqual({ number: 4, approve: false });
    expect(parseKnowledgeReply('ok plano 4')).toBeUndefined();
  });
});

describe('plans with the knowledge base', () => {
  async function planned() {
    const context = await fixture();
    const { services, curator, told } = context;
    const author = await services.profiles.createProfile({
      name: 'Otto',
      instructions: 'Help.',
      model,
    });
    const reviewer = await services.profiles.createProfile({
      name: 'Revisor',
      instructions: 'Review.',
      model,
    });

    await services.knowledge.import(load);
    await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });
    await services.applications.put('erp', [
      { path: 'project/README.md', data: Buffer.from('# ERP', 'utf8') },
    ]);

    const generator: Generator = async (folder) => {
      await writeFile(join(folder, 'prototipo.html'), '<!doctype html><p>tela</p>');
      return { ok: true };
    };
    const prototypes = new Prototypes(
      services.store,
      services.applications,
      services.quality,
      generator,
      await mkdtemp(join(tmpdir(), 'jian-knowledge-')),
    );
    const agents: Array<{ profileId: string; text: string }> = [];

    services.plans.useAgents(async (profileId, _session, text) => agents.push({ profileId, text }));
    services.plans.useOwner(async () => {});
    services.plans.usePrototypes(prototypes);
    prototypes.usePlanner(services.plans);
    await services.plans.updateSettings('prototype', { reviewerProfileId: reviewer.id });
    await prototypes.create(
      {
        application: 'erp',
        title: 'Cores de Aparelhos',
        brief: 'Listagem das cores com filtro por situação.',
      },
      { kind: 'owner', profileId: author.id },
    );
    const [plan] = await services.plans.list();

    return {
      services,
      curator,
      told,
      author,
      reviewer,
      agents,
      plan: plan ?? expect.fail('no plan'),
    };
  }

  it('hands the author and the Reviewer the rules that hold and the question budget', async () => {
    const { services, author, reviewer, agents, plan } = await planned();
    const asked = agents.at(-1);

    expect(asked?.profileId).toBe(author.id);
    expect(asked?.text).toContain('no máximo 3 perguntas');
    expect(asked?.text).toContain('Suposições');
    expect(asked?.text).toContain('search_knowledge');
    expect(asked?.text).toContain('Cores de Aparelhos mostra a cor como amostra');
    expect(asked?.text).toContain('[toda listagem do ERP]');
    expect(asked?.text).not.toContain('Até 5 lojas');
    expect(asked?.text).not.toContain('nota emitida');

    await services.plans.write(
      plan.id,
      {
        text: 'Plano com quatro perguntas.',
        questions: ['Busca por parte?', 'Quais situações?', 'Onde o Exportar?', 'Ordem?'],
      },
      { profileId: author.id },
    );
    const review = agents.at(-1);

    expect(review?.profileId).toBe(reviewer.id);
    expect(review?.text).toContain('pergunta que já tem resposta na base');
    expect(review?.text).toContain('## Perguntas do autor ao Moabe (4)');
    expect(review?.text).toContain('Exportar fica no canto direito');

    const routines = await services.plans.routines();
    expect(routines.questionsPerWeek).toEqual([
      expect.objectContaining({ plans: 1, questions: 4, average: 4 }),
    ]);
  });

  it('asks the Curator to propose from what the owner wrote on a plan', async () => {
    const { services, curator, told, author, plan } = await planned();

    await services.plans.write(
      plan.id,
      { text: 'Plano.', questions: ['Quais situações?'] },
      { profileId: author.id },
    );
    await services.plans.giveBack(
      { id: plan.id },
      { reason: 'Situação: Ativo e Inativo.' },
      'panel',
    );

    expect(told).toEqual([
      {
        profileId: curator.id,
        text: expect.stringContaining('Situação: Ativo e Inativo.'),
      },
    ]);
    expect(told[0]?.text).toContain('propose_knowledge');
    expect(told[0]?.text).toContain('Quais situações?');
    expect(told[0]?.text).toContain('tela Cores de Aparelhos');
  });
});
