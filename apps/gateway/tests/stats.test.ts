import { randomUUID } from 'node:crypto';
import type { ProfileStats } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { Stats } from '../src/stats/service.js';
import { checkpoints, runs } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

it('adds up tokens, list-price cost, days, models, channels and tools', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const api = await services.sessions.createSession(profile.id, { title: 'Report' });
  const gateway = await services.sessions.gatewaySession(profile.id);
  const now = Date.parse('2026-09-24T15:00:00Z');

  const turn = async (
    sessionId: string,
    key: string,
    at: number,
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
    model: Record<string, unknown>,
  ) => {
    const run = await services.runs.submit(profile.id, sessionId, { text: 'Go', requestKey: key });

    await services.store.db
      .update(runs)
      .set({
        status: 'completed',
        usage: { ...usage, estimated: false, steps: 1 },
        model: model as never,
        createdAt: new Date(at),
        updatedAt: new Date(at + 90_000),
      })
      .where(eq(runs.id, run.id));

    return run;
  };

  const metered = { provider: 'openai', modelId: 'gpt-priced' };
  const first = await turn(
    api.id,
    'a',
    now - 3600_000,
    { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 400_000 },
    metered,
  );

  await turn(
    gateway.id,
    'b',
    now - 2 * 86_400_000,
    { inputTokens: 200_000, outputTokens: 20_000, cachedInputTokens: 0 },
    { provider: 'anthropic', modelId: 'claude-test', credential: 'subscription' },
  );
  // Outside a seven-day period, inside everything else.
  await turn(
    api.id,
    'c',
    now - 20 * 86_400_000,
    { inputTokens: 5_000, outputTokens: 500, cachedInputTokens: 0 },
    metered,
  );

  for (const phase of ['tool-started', 'tool-started', 'tool-failed'])
    await services.store.db.insert(checkpoints).values({
      id: randomUUID(),
      profileId: profile.id,
      runId: first.id,
      data: { phase, toolName: 'web_search' },
      createdAt: new Date(now - 3000_000),
    });

  const stats = new Stats(
    services.store,
    services.profiles,
    { timeZone: async () => 'America/Sao_Paulo' },
    {
      prime: async () => {},
      lookup: (kind, modelId) =>
        kind === 'openai' && modelId === 'gpt-priced'
          ? {
              reasoningEfforts: [],
              inputModalities: [],
              outputModalities: [],
              price: { input: 2, output: 8, cacheRead: 0.5 },
            }
          : undefined,
    },
    () => now,
    {
      read: async () => [
        {
          provider: 'codex',
          status: 'available',
          fiveHour: { usedPercent: 20, resetsAt: null },
          weekly: null,
        },
      ],
    },
  );

  const week = await stats.stats(profile.id, { days: '7' });

  // 600k fresh at $2, 400k cached at $0.50, 100k out at $8, per million.
  expect(week.period.cost).toBeCloseTo(1.2 + 0.2 + 0.8, 6);
  expect(week.subscriptions[0]?.fiveHour?.usedPercent).toBe(20);
  const agentStats = (await profileTools(
    { ...services, stats },
    first,
  ).read_activity_stats?.execute?.(
    { days: 7 },
    { toolCallId: 'subscription-stats', messages: [], context: {} },
  )) as ProfileStats;
  expect(agentStats.subscriptions[0]?.fiveHour?.usedPercent).toBe(20);
  expect(week.period.tokens).toEqual({ input: 800_000, cached: 400_000, output: 120_000 });
  expect(week.period.unpricedTokens).toBe(220_000);
  expect(week.period.activeDays).toBe(2);
  expect(week.period.turns).toBe(2);
  expect(week.models.map((model) => [model.modelId, model.billing])).toEqual([
    ['gpt-priced', 'metered'],
    ['claude-test', 'subscription'],
  ]);
  expect(week.channels.map((channel) => [channel.channel, channel.conversations])).toEqual([
    ['api', 1],
    ['gateway', 1],
  ]);
  expect(week.tools).toEqual([{ name: 'web_search', calls: 2, failed: 1 }]);
  expect(week.totals).toMatchObject({ turns: 3, workedMs: 270_000, conversations: 2 });

  const month = await stats.stats(profile.id, { days: '30' });

  expect(month.period.turns).toBe(3);
  const firstPage = await stats.usageRuns(profile.id, 7, 1, 0);
  const secondPage = await stats.usageRuns(profile.id, 7, 1, 1);
  expect(firstPage).toMatchObject([
    { id: first.id, tokens: { input: 600_000, cached: 400_000, output: 100_000 } },
  ]);
  expect(firstPage[0]?.estimatedCostUsd).toBeCloseTo(2.2, 6);
  expect(secondPage[0]).toMatchObject({
    model: { billing: 'subscription' },
    estimatedCostUsd: null,
  });
});

it('lets an agent read its own full activity without exposing another profile', async () => {
  const services = await testServices();
  const create = (name: string) =>
    services.profiles.createProfile({
      name,
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
  const mine = await create('Mine');
  const other = await create('Other');
  const mineSession = await services.sessions.createSession(mine.id, { title: 'Mine' });
  const otherSession = await services.sessions.createSession(other.id, { title: 'Other' });
  const ownRun = await services.runs.submit(mine.id, mineSession.id, {
    text: 'Report',
    requestKey: 'mine',
  });
  const otherRun = await services.runs.submit(other.id, otherSession.id, {
    text: 'Private',
    requestKey: 'other',
  });
  for (const [run, tokens] of [
    [ownRun, 10],
    [otherRun, 1000],
  ] as const) {
    await services.store.db
      .update(runs)
      .set({
        status: 'completed',
        usage: {
          inputTokens: tokens,
          outputTokens: 0,
          cachedInputTokens: 0,
          estimated: false,
          steps: 1,
        },
      })
      .where(eq(runs.id, run.id));
  }
  for (let index = 0; index < 10; index++) {
    await services.store.db.insert(checkpoints).values({
      id: randomUUID(),
      profileId: mine.id,
      runId: ownRun.id,
      data: { phase: 'tool-started', toolName: `tool_${index}` },
    });
  }

  const result = (await profileTools(services, ownRun).read_activity_stats?.execute?.(
    { days: 7 },
    { toolCallId: 'stats', messages: [], context: {} },
  )) as ProfileStats;

  expect(result.period.tokens.input).toBe(10);
  expect(result.tools).toHaveLength(10);
  expect(result.totals.turns).toBe(1);

  const page = (await profileTools(services, ownRun).read_usage_runs?.execute?.(
    { days: 7, limit: 25, offset: 0 },
    { toolCallId: 'runs', messages: [], context: {} },
  )) as Array<{ id: string; tokens: { input: number } }>;

  expect(page).toHaveLength(1);
  expect(page[0]).toMatchObject({ id: ownRun.id, tokens: { input: 10 } });
  expect(JSON.stringify(page)).not.toContain('Private');
});
