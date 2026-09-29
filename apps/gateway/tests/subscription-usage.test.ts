import { expect, it } from 'vitest';
import { SubscriptionUsageReader } from '../src/providers/subscription-usage.js';
import { testServices } from './helpers/services.js';

it('reads both subscription windows without exposing credentials and caches the result', async () => {
  const services = await testServices();
  const token = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' },
    }),
  ).toString('base64url')}.x`;
  await services.providers.configureCodexProvider('{"access_token":"synthetic"}');
  await services.providers.createProvider({
    name: 'Claude',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic-test-only',
  });
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('authorization');
    seen.push(url);
    expect(authorization).toMatch(/^Bearer /);
    return Response.json(
      url.includes('wham')
        ? {
            rate_limit: {
              primary_window: { used_percent: 32, reset_at: 1_800_000_000 },
              secondary_window: { used_percent: 61 },
            },
          }
        : {
            five_hour: { utilization: 18, resets_at: '2027-01-15T12:00:00Z' },
            seven_day: { utilization: 47 },
          },
    );
  }) as typeof fetch;
  const reader = new SubscriptionUsageReader(
    services.providers,
    services.gatewayVault,
    fetcher,
    () => Date.parse('2027-01-15T10:00:00Z'),
  );
  reader.useCodexLogin({ accessToken: async () => token });

  const result = await reader.read();
  expect(result).toMatchObject([
    {
      provider: 'codex',
      status: 'available',
      fiveHour: { usedPercent: 32 },
      weekly: { usedPercent: 61 },
    },
    {
      provider: 'claude',
      status: 'available',
      fiveHour: { usedPercent: 18 },
      weekly: { usedPercent: 47 },
    },
  ]);
  expect(result[0]?.fiveHour?.resetsAt).toBe('2027-01-15T08:00:00.000Z');
  expect(JSON.stringify(result)).not.toContain('synthetic');
  await reader.read();
  expect(seen).toHaveLength(2);
});

it('reports an unavailable window instead of inventing zero after endpoint failure', async () => {
  const services = await testServices();
  await services.providers.createProvider({
    name: 'Claude',
    kind: 'anthropic',
    credential: 'subscription',
    secret: 'sk-ant-oat-synthetic-test-only',
  });
  const reader = new SubscriptionUsageReader(
    services.providers,
    services.gatewayVault,
    (async () => new Response('secret echoed here', { status: 401 })) as typeof fetch,
  );

  expect(await reader.read()).toEqual([
    { provider: 'claude', status: 'unavailable', fiveHour: null, weekly: null },
  ]);
});
