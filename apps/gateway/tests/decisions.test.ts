import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Decisions } from '../src/decisions/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-decisions-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };
const question = {
  state: { message: 'Ada, pode confirmar?' },
  instructions: 'Is this message speaking to Ada?',
  yes: 'It is.',
  no: 'It is not.',
};

async function setup(respond: (init?: RequestInit) => Response | Promise<Response>) {
  const services = await testServices();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const reports: string[] = [];
  const decisions = new Decisions(
    services.store,
    services.gatewayVault,
    async (input, init) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });

      return respond(init);
    },
    (line) => reports.push(line),
  );
  const app = createApp({ ...services, decisions, token, logger: false });

  return { decisions, requests, reports, app };
}

describe('asking Jev', () => {
  it('asks nothing and sends nothing until the owner saves a key', async () => {
    const { decisions, requests } = await setup(() => Response.json({}));

    expect(await decisions.ask(question, { use: 'groups' })).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it('keeps the key write-only and sends it only to TypeSafe', async () => {
    const { app, decisions, requests } = await setup(() =>
      Response.json({ answers: { answer: { type: 'noul', noul: 0.82, confidence: 0.9 } } }),
    );

    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/decisions',
      headers: admin,
      payload: { provider: 'jev', apiKey: 'jev-synthetic' },
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('jev-synthetic');
    expect(saved.json()).toMatchObject({ provider: 'jev', configured: true });

    expect(await decisions.ask(question, { use: 'groups' })).toBe(0.82);
    expect(requests[0]?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe(
      'Bearer jev-synthetic',
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      model: 'jev-latest',
      questions: { answer: { type: 'noul' } },
    });

    const removed = await app.inject({ method: 'DELETE', url: '/v1/decisions', headers: admin });

    expect(removed.json()).toMatchObject({ configured: false });
    expect(await decisions.ask(question, { use: 'groups' })).toBeUndefined();
  });

  it('leaves the decision to the caller when Jev fails, without logging what it answered', async () => {
    const { decisions, reports } = await setup(
      () => new Response('{"detail":"Ada, pode confirmar?"}', { status: 529 }),
    );

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });

    expect(await decisions.ask(question, { use: 'groups' })).toBeUndefined();
    expect(reports.join('\n')).toContain('529');
    expect(reports.join('\n')).not.toContain('pode confirmar');
  });

  it('stops waiting when Jev is slow', async () => {
    // Like fetch, the synthetic Jev gives up only when the request is aborted.
    const { decisions } = await setup(
      (init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)),
        ),
    );

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });

    expect(await decisions.ask(question, { use: 'groups', timeoutMs: 50 })).toBeUndefined();
  });
});

describe('spending on Jev', () => {
  const answered = () =>
    Response.json({
      answers: { answer: { type: 'noul', noul: 0.7 } },
      usage: { input_tokens: 300, output_tokens: 20 },
    });

  it('counts the tokens of each use, and shows them without anything that was asked', async () => {
    const { app, decisions } = await setup(answered);

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });
    await decisions.ask(question, { use: 'groups' });
    await decisions.ask({ ...question, state: { message: 'Another one' } }, { use: 'groups' });

    const status = await app.inject({ method: 'GET', url: '/v1/decisions', headers: admin });

    expect(status.json().usage).toEqual([
      expect.objectContaining({
        use: 'groups',
        requests: 2,
        cached: 0,
        inputTokens: 600,
        outputTokens: 40,
      }),
    ]);
    expect(status.body).not.toContain('pode confirmar');
  });

  it('does not pay twice for the same question over the same state', async () => {
    const { decisions, requests } = await setup(answered);

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });

    expect(await decisions.ask(question, { use: 'groups' })).toBe(0.7);
    expect(await decisions.ask(question, { use: 'groups' })).toBe(0.7);
    expect(requests).toHaveLength(1);
    expect((await decisions.status()).usage[0]).toMatchObject({ requests: 1, cached: 1 });
  });

  it('asks nothing for a use the owner switched off, and the others keep asking', async () => {
    const { app, decisions, requests } = await setup(answered);

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/decisions',
      headers: admin,
      payload: { uses: { groups: false } },
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json().uses).toMatchObject({ groups: false, actions: true, turn: true });
    expect(await decisions.ask(question, { use: 'groups' })).toBeUndefined();
    expect(requests).toEqual([]);
    expect(await decisions.ask(question, { use: 'actions' })).toBe(0.7);
    expect(requests).toHaveLength(1);
  });

  it('stops asking for the day once the ceiling is reached, and a ceiling can be removed', async () => {
    const { decisions, requests, reports } = await setup(answered);

    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });
    await decisions.updateSettings({ dailyTokenLimit: 1000 });

    for (const message of ['one', 'two', 'three', 'four']) {
      await decisions.ask({ ...question, state: { message } }, { use: 'turn' });
    }

    // 320 tokens each: the fourth starts at 960, under the ceiling, and ends past it.
    expect(requests).toHaveLength(4);
    expect(await decisions.ask({ ...question, state: { message: 'five' } }, { use: 'turn' })).toBe(
      undefined,
    );
    expect(requests).toHaveLength(4);
    expect(reports.join('\n')).toContain('daily ceiling');

    const status = await decisions.updateSettings({ dailyTokenLimit: null });

    expect(status.dailyTokenLimit).toBeUndefined();
    expect(await decisions.ask({ ...question, state: { message: 'six' } }, { use: 'turn' })).toBe(
      0.7,
    );
  });

  it('refuses a ceiling too small to be meant', async () => {
    const { app } = await setup(answered);
    const refused = await app.inject({
      method: 'PATCH',
      url: '/v1/decisions',
      headers: admin,
      payload: { dailyTokenLimit: 5 },
    });

    expect(refused.statusCode).toBe(400);
  });
});
