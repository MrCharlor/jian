import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ModelCatalog } from '../src/providers/catalog-source.js';
import { ProviderModels } from '../src/providers/discovery.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const listing = (...ids: string[]) =>
  Response.json({ data: ids.map((id) => ({ id, display_name: id.toUpperCase() })) });

/** A catalog served from a fixture: the tests never reach models.dev. */
function testCatalog(entries: Record<string, unknown> = {}) {
  const body = { anthropic: { models: entries } };

  return new ModelCatalog(
    (async () => Response.json(body)) as typeof globalThis.fetch,
    () => 0,
    'https://models.test/api.json',
  );
}

async function setup(respond: () => Promise<Response>, catalog?: ModelCatalog) {
  let now = 1_700_000_000_000;
  const services = await testServices(() => now, catalog);
  const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });
  const provider = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-anthropic-key',
  });
  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    respond,
    {
      ttlMs: 60_000,
      clock: () => now,
      ...(catalog ? { catalog } : {}),
    },
  );

  return {
    services,
    profile,
    provider,
    models,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('keeps the saved default and the last list when the provider is unreachable', async () => {
  let reachable = true;
  const { services, profile, provider, models, advance } = await setup(async () => {
    if (!reachable) throw new Error('connect ECONNREFUSED');

    return listing('claude-sonnet-4-5', 'claude-opus-4-5');
  });

  await services.providers.setModelDefaults(profile.id, {
    conversation: { providerId: provider.id, modelId: 'claude-sonnet-4-5', reasoningEffort: 'low' },
  });

  const fresh = await models.list(provider.id);

  expect(fresh.stale).toBe(false);
  expect(fresh.models.map((model) => model.id)).toEqual(['claude-opus-4-5', 'claude-sonnet-4-5']);

  reachable = false;
  advance(120_000);

  const offline = await models.list(provider.id);

  expect(offline.stale).toBe(true);
  expect(offline.reason).toBeDefined();
  expect(offline.models.map((model) => model.id)).toEqual(fresh.models.map((model) => model.id));
  expect(offline.fetchedAt).toBe(fresh.fetchedAt);

  // The outage must not reach into stored configuration.
  expect((await services.providers.modelDefaults(profile.id)).conversation).toEqual({
    providerId: provider.id,
    modelId: 'claude-sonnet-4-5',
    reasoningEffort: 'low',
  });
  expect(
    (await services.providers.providers()).find((item) => item.id === provider.id)?.revokedAt,
  ).toBeUndefined();
});

it('reports an unreachable provider as empty instead of inventing a list', async () => {
  const { provider, models } = await setup(async () => {
    throw new Error('connect ECONNREFUSED');
  });

  const list = await models.list(provider.id);

  expect(list).toMatchObject({ providerId: provider.id, models: [], stale: true });
  expect(list.reason).toBeDefined();
});

it('answers inside the cache window without reaching the provider again', async () => {
  let reachable = true;
  const { provider, models, advance } = await setup(async () => {
    if (!reachable) throw new Error('connect ECONNREFUSED');

    return listing('claude-sonnet-4-5');
  });

  await models.list(provider.id);
  reachable = false;
  advance(30_000);

  expect(await models.list(provider.id)).toMatchObject({ stale: false });
});

it('takes what the public catalog knows and marks the model it does not cover', async () => {
  const { services, profile, provider, models } = await setup(
    async () => listing('claude-sonnet-4-5', 'claude-next-experimental'),
    testCatalog({
      'claude-sonnet-4-5': {
        name: 'Claude Sonnet 4.5',
        limit: { context: 200_000, output: 64_000 },
        modalities: { input: ['text', 'image', 'pdf'] },
        reasoning_options: [
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
        ],
      },
    }),
  );

  const list = await models.list(provider.id);
  const known = list.models.find((model) => model.id === 'claude-sonnet-4-5');
  const unknown = list.models.find((model) => model.id === 'claude-next-experimental');

  // Nothing about this model is written in this repository: it comes from the catalog.
  expect(known).toMatchObject({ known: true, contextWindow: 200_000, maxOutputTokens: 64_000 });
  expect(known?.reasoningEfforts).toContain('high');
  expect(known?.reasoningEfforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(unknown).toMatchObject({
    known: false,
    contextWindow: 128_000,
    reasoningEfforts: [],
    inputModalities: ['text'],
  });

  // Unknown capabilities never make a model unselectable.
  const saved = await services.providers.setModelDefaults(profile.id, {
    conversation: { providerId: provider.id, modelId: 'claude-next-experimental' },
  });

  expect(saved.conversation?.modelId).toBe('claude-next-experimental');

  // Nor does an uncatalogued model refuse an effort: the provider is the one who knows.
  const withEffort = await services.providers.setModelDefaults(profile.id, {
    conversation: {
      providerId: provider.id,
      modelId: 'claude-next-experimental',
      reasoningEffort: 'high',
    },
  });

  expect(withEffort.conversation?.reasoningEffort).toBe('high');

  // A level the catalog does contradict is still refused.
  await expect(
    services.providers.setModelDefaults(profile.id, {
      conversation: {
        providerId: provider.id,
        modelId: 'claude-sonnet-4-5',
        reasoningEffort: 'minimal',
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('keeps model discovery admin-only and never echoes the key behind it', async () => {
  const { services, provider, models } = await setup(async () => listing('claude-sonnet-4-5'));
  const app = createApp({ ...services, providerModels: models, token, logger: false });
  apps.push(app);

  const path = `/v1/providers/${provider.id}/models`;

  expect((await app.inject({ url: path })).statusCode).toBe(401);

  const allowed = await app.inject({ url: path, headers });

  expect(allowed.statusCode).toBe(200);
  expect(allowed.body).not.toContain('synthetic-anthropic-key');

  // A provider that is not configured is not found, whoever asks.
  const missing = await app.inject({ url: `/v1/providers/${randomUUID()}/models`, headers });

  expect(missing.statusCode).toBe(404);
});

it('takes the router listing as the whole truth about a model', async () => {
  const services = await testServices();
  const _profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

  const provider = await services.providers.createProvider({
    name: 'OpenRouter',
    kind: 'openrouter',
    secret: 'synthetic-key',
  });

  const fetcher = (async () =>
    Response.json({
      data: [
        {
          id: 'anthropic/claude-sonnet-5',
          name: 'Claude Sonnet 5',
          context_length: 1_000_000,
          top_provider: { max_completion_tokens: 128_000 },
          architecture: { input_modalities: ['text', 'image', 'file'] },
          supported_parameters: ['reasoning_effort', 'tools'],
        },
        {
          id: 'some/plain-model',
          context_length: 32_768,
          top_provider: { max_completion_tokens: null },
          architecture: { input_modalities: ['text'] },
          supported_parameters: ['tools'],
        },
      ],
    })) as typeof globalThis.fetch;

  const list = await new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    fetcher,
  ).list(provider.id);
  const sonnet = list.models.find((model) => model.id === 'anthropic/claude-sonnet-5');
  const plain = list.models.find((model) => model.id === 'some/plain-model');

  // Reported, not guessed: no row for either model exists in the capability table.
  expect(sonnet).toMatchObject({
    known: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    displayName: 'Claude Sonnet 5',
  });
  expect(sonnet?.inputModalities).toEqual(['text', 'image', 'pdf']);
  expect(sonnet?.reasoningEfforts).toContain('high');

  expect(plain).toMatchObject({ known: true, contextWindow: 32_768 });
  expect(plain?.reasoningEfforts).toEqual([]);
});

it('reads a catalog that carries a malformed entry among the good ones', async () => {
  const services = await testServices();
  const _profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

  const provider = await services.providers.createProvider({
    name: 'Anthropic',
    kind: 'anthropic',
    secret: 'synthetic-key',
  });

  // One provider with a null where a string belongs must not cost every other model its
  // capabilities: nobody here reviews this source before it is used.
  const catalog = new ModelCatalog(
    (async () =>
      Response.json({
        broken: {
          models: { 'bad-model': { reasoning_options: [{ type: 'effort', values: [null] }] } },
        },
        anthropic: {
          models: {
            'claude-sonnet-5': {
              limit: { context: 1_000_000, output: 128_000 },
              modalities: { input: ['text', 'image', 'pdf'] },
              reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
            },
          },
        },
      })) as typeof globalThis.fetch,
    () => 0,
    'https://models.test/api.json',
  );

  const models = new ProviderModels(
    { providers: services.providers, vault: services.gatewayVault },
    async () => listing('claude-sonnet-5'),
    { catalog },
  );
  const list = await models.list(provider.id);

  expect(list.models[0]).toMatchObject({ known: true, contextWindow: 1_000_000 });
});
