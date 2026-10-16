import { parseInboxReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { Inbox, type InboxPending, type InboxSource } from '../src/inbox/service.js';
import { testServices } from './helpers/services.js';

const NOW = Date.parse('2026-10-16T12:00:00Z');

/** A queue in memory: what waits in it, and every answer it was given. */
function queue(kind: InboxSource['kind'], items: InboxPending[], withText = true) {
  const waiting = [...items];
  const answers: string[] = [];
  const done = (item: InboxPending, said: string) => {
    waiting.splice(waiting.indexOf(item), 1);
    answers.push(said);
    return said;
  };
  const source: InboxSource = {
    kind,
    label: kind,
    pending: async () => [...waiting],
    ok: async (item) => done(item, `ok ${item.refNumber}`),
    no: async (item, reason) => done(item, `não ${item.refNumber}: ${reason ?? ''}`),
    ...(withText ? { text: async (item, text) => done(item, `${item.refNumber}: ${text}`) } : {}),
  };

  return { source, waiting, answers };
}

const item = (refNumber: number, minutesAgo: number, extra: Partial<InboxPending> = {}) => ({
  refId: `ref-${refNumber}`,
  refNumber,
  title: `item ${refNumber}`,
  createdAt: new Date(NOW - minutesAgo * 60_000).toISOString(),
  ...extra,
});

async function fixture() {
  const services = await testServices();
  let now = NOW;
  const inbox = new Inbox(services.store, () => now);
  const plans = queue('plano', [item(3, 30), item(4, 10)]);
  const rules = queue('regra', [item(3, 60, { highImpact: true })], false);

  inbox.use(plans.source);
  inbox.use(rules.source);

  return { inbox, plans, rules, advance: (ms: number) => (now += ms) };
}

describe('the inbox reply', () => {
  it('reads ok, não and text with numbers, ranges and lists', () => {
    expect(parseInboxReply('ok 3')).toEqual({ numbers: [3], action: 'ok' });
    expect(parseInboxReply('OK #3-5')).toEqual({ numbers: [3, 4, 5], action: 'ok' });
    expect(parseInboxReply('ok 3, 5 e 8')).toEqual({ numbers: [3, 5, 8], action: 'ok' });
    expect(parseInboxReply('não 4: fora do escopo')).toEqual({
      numbers: [4],
      action: 'no',
      text: 'fora do escopo',
    });
    expect(parseInboxReply('nao 4')).toEqual({ numbers: [4], action: 'no' });
    expect(parseInboxReply('5: troca o filtro por etiqueta')).toEqual({
      numbers: [5],
      action: 'text',
      text: 'troca o filtro por etiqueta',
    });
  });

  it('leaves the old commands and plain talk alone', () => {
    for (const text of [
      'ok plano 3',
      'ok regra 4',
      'decisão 3: B',
      'menção 3: texto',
      'ok, pode seguir',
      'não sei',
      'ok 1-500',
      'sim 2 lojas',
    ]) {
      expect(parseInboxReply(text)).toBeUndefined();
    }
  });
});

describe('the inbox', () => {
  it('numbers every item once, across queues, the high-impact first then the oldest', async () => {
    const { inbox } = await fixture();
    const { items } = await inbox.list();

    expect(items.map((entry) => [entry.kind, entry.refNumber, entry.highImpact])).toEqual([
      ['regra', 3, true],
      ['plano', 3, false],
      ['plano', 4, false],
    ]);
    expect(new Set(items.map((entry) => entry.number)).size).toBe(3);

    const again = await inbox.list();
    expect(again.items.map((entry) => entry.number)).toEqual(items.map((entry) => entry.number));
  });

  it('answers each number through its own queue', async () => {
    const { inbox, plans, rules } = await fixture();
    const { items } = await inbox.list();
    const number = (kind: string, ref: number) =>
      items.find((entry) => entry.kind === kind && entry.refNumber === ref)?.number ?? 0;

    const outcomes = await inbox.decide(
      { numbers: [number('plano', 3), number('regra', 3)], action: 'ok' },
      'channel',
    );

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(plans.answers).toEqual(['ok 3']);
    expect(rules.answers).toEqual(['ok 3']);

    const [twice] = await inbox.decide({ numbers: [number('plano', 3)], action: 'ok' }, 'channel');
    expect(twice).toMatchObject({ ok: false });
    expect(twice?.text).toContain('já foi decidido');

    const [said] = await inbox.decide(
      { numbers: [number('plano', 4)], action: 'text', text: 'muda o título' },
      'panel',
    );
    expect(said).toMatchObject({ ok: true });
    expect(plans.answers.at(-1)).toBe('4: muda o título');
    expect((await inbox.list()).items).toEqual([]);
  });

  it('refuses words where the queue has nothing to do with them', async () => {
    const { inbox, rules } = await fixture();
    const rule = (await inbox.list()).items.find((entry) => entry.kind === 'regra');

    const [outcome] = await inbox.decide(
      { numbers: [rule?.number ?? 0], action: 'text', text: 'outra regra' },
      'channel',
    );

    expect(outcome?.ok).toBe(false);
    expect(outcome?.text).toContain('aqui não cabe texto');
    expect(rules.answers).toEqual([]);
    expect(rule?.acceptsText).toBe(false);
  });

  it('closes what its queue decided elsewhere, and opens a new item with a new number', async () => {
    const { inbox, plans } = await fixture();
    const first = await inbox.list();

    plans.waiting.splice(0, 1);
    plans.waiting.push(item(9, 1));

    const second = await inbox.list();
    const nine = second.items.find((entry) => entry.refNumber === 9);

    expect(second.items).toHaveLength(3);
    expect(first.items.map((entry) => entry.number)).not.toContain(nine?.number);
  });

  it('tells each number once in the notices, with the commands', async () => {
    const { inbox } = await fixture();

    const told = await inbox.announce(['plano']);
    expect(told).toContain('plano 3, item 3');
    expect(told).toContain('"ok N", "não N: motivo" ou "N: texto"');
    expect(await inbox.announce(['plano'])).toBe('');
  });

  it('measures the minutes from waiting to the owner’s decision', async () => {
    const { inbox } = await fixture();
    const plan = (await inbox.list()).items.find((entry) => entry.refNumber === 4);

    await inbox.decide({ numbers: [plan?.number ?? 0], action: 'ok' }, 'channel');

    expect((await inbox.list()).stats).toEqual([{ kind: 'plano', decided: 1, medianMinutes: 10 }]);
  });
});

describe('the inbox in a conversation', () => {
  it('answers "ok N" with the inbox number, and leaves a number it never gave alone', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Otto',
      instructions: 'Operate the board.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      actionPolicy: { machine: 2, service: 2, message: 2, tools: {} },
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Board' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Comment on the card.',
      requestKey: 'first',
    });
    const gate = await services.approvals.gate(run, {
      tool: 'comment',
      action: 'work.comment',
      input: { text: 'Aprovado' },
      summary: 'Comenta Aprovado no card',
    });

    if (gate.proceed) throw new Error('The call was not held');

    const [entry] = (await services.inbox.list()).items;
    expect(entry).toMatchObject({ kind: 'aprovacao', refNumber: 1 });
    expect(gate.held).toContain(`"ok ${entry?.number}"`);

    await services.runs.cancel(profile.id, run.id);

    const stray = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'ok 40', requestKey: 'stray' },
      { ownerMessage: true },
    );
    expect(stray.input).toBe('ok 40');
    await services.runs.cancel(profile.id, stray.id);

    const answer = await services.runs.submit(
      profile.id,
      session.id,
      { text: `ok ${entry?.number}`, requestKey: 'answer' },
      { ownerMessage: true },
    );

    expect(answer.input).toContain('[Caixa] O Moabe respondeu:');
    expect(answer.input).toContain('approved by the owner');
    expect((await services.approvals.list(profile.id))[0]?.status).toBe('approved');
    expect((await services.inbox.list()).items).toEqual([]);
  });
});
