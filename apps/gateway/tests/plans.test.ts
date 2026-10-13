import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePlanReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import type { Generator } from '../src/prototypes/generator.js';
import { Prototypes } from '../src/prototypes/service.js';
import { testServices } from './helpers/services.js';

const text = (value: string) => Buffer.from(value, 'utf8');

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

const request = {
  application: 'erp',
  title: 'Cores de Aparelhos',
  brief: 'Listagem das cores com filtro por situação.',
};

const finding = {
  kind: 'lacuna' as const,
  text: 'Não diz quais situações o filtro tem.',
  source: 'pedido',
};

/** Two agents and a Reviewer, a prototype service that records what it was asked to draw. */
async function fixture(options: { reviewer?: boolean; automatic?: boolean } = {}) {
  const services = await testServices();
  const author = await services.profiles.createProfile({
    name: 'Subaru',
    instructions: 'Help.',
    model,
  });
  const reviewer = await services.profiles.createProfile({
    name: 'Revisor',
    instructions: 'Review.',
    model,
  });

  await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });
  await services.applications.put('erp', [
    { path: 'project/README.md', data: text('# ERP') },
    { path: 'project/preferencias-do-po.md', data: text('- Dados em toda tela.') },
  ]);

  const drawn: string[] = [];
  const generator: Generator = async (folder) => {
    drawn.push(await readFile(join(folder, 'pedido.md'), 'utf8'));
    await writeFile(join(folder, 'prototipo.html'), '<!doctype html><p>tela</p>');
    return { ok: true };
  };
  const prototypes = new Prototypes(
    services.store,
    services.applications,
    services.quality,
    generator,
    await mkdtemp(join(tmpdir(), 'jian-plans-')),
  );
  const told: Array<{ profileId: string; text: string }> = [];
  const owner: string[] = [];

  services.plans.useAgents(async (profileId, _session, said) =>
    told.push({ profileId, text: said }),
  );
  services.plans.useOwner(async (said) => owner.push(said));
  services.plans.usePrototypes(prototypes);
  prototypes.usePlanner(services.plans);

  if (options.reviewer !== false) {
    await services.plans.updateSettings('prototype', {
      reviewerProfileId: reviewer.id,
      automatic: options.automatic ?? false,
    });
  }

  return { services, prototypes, author, reviewer, told, owner, drawn };
}

async function opened(context: Awaited<ReturnType<typeof fixture>>) {
  const created = await context.prototypes.create(request, {
    kind: 'owner',
    profileId: context.author.id,
  });
  const [plan] = await context.services.plans.list();

  return { created, plan: plan ?? expect.fail('no plan was opened') };
}

describe('plans before a prototype', () => {
  it('draws at once, as before, when no Reviewer is set', async () => {
    const context = await fixture({ reviewer: false });
    const created = await context.prototypes.create(request, { kind: 'owner' });

    expect(created.versions).toMatchObject([{ status: 'queued' }]);
    expect(await context.services.plans.list()).toEqual([]);

    await context.prototypes.drain();
    expect((await context.prototypes.get(created.id)).versions[0]?.status).toBe('ready');
  });

  it('sends a plan with findings back to its author, and to the owner after two returns', async () => {
    const context = await fixture();
    const { services, author, reviewer, told, owner } = context;
    const { created, plan } = await opened(context);

    expect(created.versions).toMatchObject([{ status: 'planning' }]);
    expect(told.at(-1)).toMatchObject({
      profileId: author.id,
      text: expect.stringContaining('write_plan'),
    });

    for (const round of [1, 2, 3]) {
      await services.plans.write(
        plan.id,
        { text: `Plano, volta ${round}.` },
        { profileId: author.id },
      );
      expect(told.at(-1)).toMatchObject({ profileId: reviewer.id });

      const reviewed = await services.plans.review(
        plan.id,
        { revised: 'Plano curto.', findings: [finding], approved: true },
        { profileId: reviewer.id },
      );

      if (round < 3) {
        expect(reviewed).toMatchObject({ state: 'devolvido', rounds: round });
        expect(told.at(-1)).toMatchObject({
          profileId: author.id,
          text: expect.stringContaining('Não diz quais situações'),
        });
      } else {
        expect(reviewed).toMatchObject({ state: 'aguardando_po', rounds: 3 });
      }
    }

    expect(owner).toEqual([expect.stringContaining(`Plano #${plan.number} esperando você`)]);
    await context.prototypes.drain();
    expect(context.drawn).toEqual([]);
  });

  it('waits for the owner when the Reviewer approves and the action is not automatic', async () => {
    const context = await fixture();
    const { services, author, reviewer } = context;
    const { created, plan } = await opened(context);

    await services.plans.write(plan.id, { text: 'Plano longo.' }, { profileId: author.id });
    const reviewed = await services.plans.review(
      plan.id,
      { revised: 'Usar o grid do guia; filtro por situação.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    expect(reviewed.state).toBe('aguardando_po');
    await context.prototypes.drain();
    expect(context.drawn).toEqual([]);

    expect((await services.plans.approve({ id: plan.id }, 'panel')).state).toBe('executado');
    await context.prototypes.drain();

    expect(context.drawn[0]).toContain('Plano aprovado (#1)');
    expect(context.drawn[0]).toContain('Usar o grid do guia');
    expect((await context.prototypes.get(created.id)).versions[0]?.status).toBe('ready');
  });

  it('runs a plan the Reviewer approved at once when the action is automatic', async () => {
    const context = await fixture({ automatic: true });
    const { services, author, reviewer, owner } = context;
    const { plan } = await opened(context);

    await services.plans.write(plan.id, { text: 'Plano.' }, { profileId: author.id });
    const reviewed = await services.plans.review(
      plan.id,
      { revised: 'Plano revisado.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    expect(reviewed).toMatchObject({ state: 'executado', approvedBy: 'automatico' });
    expect(owner).toEqual([]);
    await context.prototypes.drain();
    expect(context.drawn[0]).toContain('Plano revisado.');
  });

  it('takes "ok plano N" from the owner in a chat, and "corrige plano N" as a correction', async () => {
    const context = await fixture();
    const { services, author, reviewer } = context;
    const { plan } = await opened(context);
    const session = await services.sessions.createSession(author.id, { title: 'Moabe' });

    await services.plans.write(plan.id, { text: 'Plano.' }, { profileId: author.id });
    await services.plans.review(
      plan.id,
      { revised: 'Plano revisado.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    const back = await services.runs.submit(
      author.id,
      session.id,
      { text: `corrige plano ${plan.number}: falta a coluna Responsável`, requestKey: 'back' },
      { ownerMessage: true },
    );
    expect(back.input).toContain('devolveu');
    expect(await services.plans.get(plan.id)).toMatchObject({ state: 'devolvido', rounds: 0 });
    expect((await services.quality.corrections(author.id))[0]).toMatchObject({
      automation: 'prototipo:erp',
      note: 'falta a coluna Responsável',
    });
    await services.runs.cancel(author.id, back.id);

    // The correction reaches the Reviewer the next time it reads a plan of this action.
    await services.plans.write(
      plan.id,
      { text: 'Plano com Responsável.' },
      { profileId: author.id },
    );
    expect(context.told.at(-1)?.text).toContain('falta a coluna Responsável');
    await services.plans.review(
      plan.id,
      { revised: 'Plano com Responsável.', findings: [], approved: true },
      { profileId: reviewer.id },
    );

    const ok = await services.runs.submit(
      author.id,
      session.id,
      { text: `ok plano ${plan.number}`, requestKey: 'ok' },
      { ownerMessage: true },
    );
    expect(ok.input).toContain('aprovou');
    expect(await services.plans.get(plan.id)).toMatchObject({
      state: 'executado',
      approvedBy: 'owner',
      decidedVia: 'channel',
    });
  });

  it('lets only the plan’s author write it and its Reviewer review it', async () => {
    const context = await fixture();
    const { services, author, reviewer } = context;
    const { plan } = await opened(context);

    await expect(
      services.plans.write(plan.id, { text: 'Plano.' }, { profileId: reviewer.id }),
    ).rejects.toThrow('not yours');
    await services.plans.write(plan.id, { text: 'Plano.' }, { profileId: author.id });
    await expect(
      services.plans.review(
        plan.id,
        { revised: 'x', findings: [], approved: true },
        { profileId: author.id },
      ),
    ).rejects.toThrow('not yours');
  });

  it('reads the owner’s answers in their usual shapes', () => {
    expect(parsePlanReply('ok plano 3')).toEqual({ number: 3, approve: true });
    expect(parsePlanReply('Plano #3: ok')).toEqual({ number: 3, approve: true });
    expect(parsePlanReply('corrige plano 3: sem cards no topo')).toEqual({
      number: 3,
      approve: false,
      reason: 'sem cards no topo',
    });
    expect(parsePlanReply('plano 3: corrige sem cards')).toMatchObject({ approve: false });
    expect(parsePlanReply('ok 3')).toBeUndefined();
  });
});
