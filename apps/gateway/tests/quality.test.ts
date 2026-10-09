import { parseCorrectionReply, READY_AFTER } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { guardTools, policyGuard } from '../src/agent/guard.js';
import { Approvals } from '../src/approvals/service.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Otto',
  instructions: 'Operate the board.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  actionPolicy: { machine: 2, service: 2, message: 2, tools: {} },
};

const call = async (definition: unknown, args: unknown) =>
  (definition as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(args, {
    toolCallId: 'call',
    messages: [],
  });

/** A profile that asks first, one conversation, and a comment tool that records what ran. */
async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { title: 'Board' });
  const ran: unknown[] = [];
  let turn = 0;

  const startRun = async (text = 'Comment on the card.') => {
    const run = await services.runs.submit(profile.id, session.id, {
      text,
      requestKey: `turn-${turn++}`,
    });
    const tools: ToolSet = {
      comment: tool({
        inputSchema: z.object({ body: z.string() }),
        execute: async (args) => {
          ran.push(args);
          return 'commented';
        },
      }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, () => 'work.comment'),
      () => 'service',
    );

    return { run, tools };
  };

  return { services, profile, session, ran, startRun };
}

describe('the correction reply', () => {
  it('reads "corrige:" and its variants, and nothing else', () => {
    expect(parseCorrectionReply('corrige: o card é o outro')).toBe('o card é o outro');
    expect(parseCorrectionReply('Corrigir - use a Entrada')).toBe('use a Entrada');
    expect(parseCorrectionReply('não, é o outro')).toBeUndefined();
    expect(parseCorrectionReply('corrige:')).toBeUndefined();
  });
});

describe('corrections', () => {
  it('runs the owner’s edited version and keeps the difference', async () => {
    const { services, profile, ran, startRun } = await fixture();
    const { run, tools } = await startRun();

    await call(tools.comment, { body: 'Aprovado' });
    const [request] = await services.approvals.list(profile.id);
    const decided = await services.approvals.approve(
      profile.id,
      request?.id ?? '',
      { input: { body: 'Aprovado em produção' } },
      'panel',
    );

    expect(decided).toMatchObject({ status: 'approved', edited: true });
    expect(Approvals.notice(decided)).toContain('"body":"Aprovado em produção"');

    // The agent's version is no longer approved; the owner's is, once.
    expect(await call(tools.comment, { body: 'Aprovado' })).toMatchObject({
      held: expect.stringContaining('request #2'),
    });
    expect(await call(tools.comment, { body: 'Aprovado em produção' })).toBe('commented');
    expect(ran).toEqual([{ body: 'Aprovado em produção' }]);

    const [correction] = await services.quality.corrections(profile.id);
    expect(correction).toMatchObject({
      kind: 'edited',
      automation: 'work.comment',
      original: { body: 'Aprovado' },
      corrected: { body: 'Aprovado em produção' },
      runId: run.id,
      via: 'panel',
    });
  });

  it('does not count an approval sent back unchanged as an edit', async () => {
    const { services, profile, startRun } = await fixture();
    const { tools } = await startRun();

    await call(tools.comment, { body: 'Aprovado' });
    const [request] = await services.approvals.list(profile.id);
    await services.approvals.approve(
      profile.id,
      request?.id ?? '',
      { input: { body: 'Aprovado' } },
      'panel',
    );

    expect(await services.quality.corrections(profile.id)).toEqual([]);
  });

  it('keeps a refusal and its reason as a correction', async () => {
    const { services, profile, startRun } = await fixture();
    const { tools } = await startRun();

    await call(tools.comment, { body: 'errado' });
    await services.approvals.decide(profile.id, { number: 1 }, false, 'channel', 'card errado');

    expect(await services.quality.corrections(profile.id)).toMatchObject([
      { kind: 'rejected', note: 'card errado', automation: 'work.comment', via: 'channel' },
    ]);
  });

  it('keeps "corrige:" from the owner against the last answer, and ignores it from anyone else', async () => {
    const { services, profile, session } = await fixture();
    const first = await services.runs.submit(profile.id, session.id, {
      text: 'Resumo da Entrada',
      requestKey: 'first',
    });
    const store = services.store;
    // A finished answer, the way the runtime would have left it.
    await services.runs.cancel(profile.id, first.id);
    await store.db.execute(
      sql`update runs set status = 'completed', output = '27 cards' where id = ${first.id}`,
    );

    await services.runs.submit(profile.id, session.id, {
      text: 'corrige: são 26, um foi apagado',
      requestKey: 'stranger',
    });
    expect(await services.quality.corrections(profile.id)).toEqual([]);

    const owner = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'corrige: são 26, um foi apagado', requestKey: 'owner' },
      { ownerMessage: true },
    );

    expect(owner.input).toBe('corrige: são 26, um foi apagado');
    expect(await services.quality.corrections(profile.id)).toMatchObject([
      {
        kind: 'redone',
        runId: first.id,
        original: '27 cards',
        note: 'são 26, um foi apagado',
        automation: 'conversation',
      },
    ]);
  });
});

describe('the quality report', () => {
  it('counts rounds and corrections per action, and is ready only after enough clean rounds', async () => {
    const { services, profile, startRun } = await fixture();

    const round = async (approve: boolean, body: string) => {
      const { run, tools } = await startRun();
      await call(tools.comment, { body });
      const pending = (await services.approvals.list(profile.id)).find(
        (item) => item.status === 'pending',
      );
      await services.approvals.decide(
        profile.id,
        { id: pending?.id ?? '' },
        approve,
        'panel',
        approve ? undefined : 'não',
      );
      await services.runs.cancel(profile.id, run.id);
    };

    await round(false, 'zero');

    for (let index = 0; index < READY_AFTER - 1; index += 1) await round(true, `ok ${index}`);

    let [row] = await services.quality.report(profile.id);
    expect(row).toMatchObject({
      automation: 'work.comment',
      action: 'work.comment',
      rounds: READY_AFTER,
      corrections: 1,
      clean: READY_AFTER - 1,
      ready: false,
    });

    await round(true, 'last');
    [row] = await services.quality.report(profile.id);
    expect(row).toMatchObject({ clean: READY_AFTER, ready: true });
  });

  it('counts a scheduled routine as one automation, by its schedule', async () => {
    const { services, profile, session } = await fixture();

    await services.runs.submit(
      profile.id,
      session.id,
      { text: '[Scheduled: Verificação diária] Rode a verificação.', requestKey: 's1' },
      { origin: 'schedule:Verificação diária' },
    );

    const [row] = await services.quality.report(profile.id);
    expect(row).toMatchObject({ automation: 'schedule:Verificação diária', rounds: 1 });
    expect(row?.action).toBeUndefined();
  });
});
