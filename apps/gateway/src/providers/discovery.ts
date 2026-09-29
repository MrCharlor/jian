import type {
  ModelCapabilities,
  ProviderModel,
  ProviderModelList,
  ProviderRecord,
} from '@jian/contracts';
import { z } from 'zod';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import { bareModelId, modelCapabilities } from './capabilities.js';
import { GROQ_BASE_URL, type ProviderKind } from './catalog.js';
import type { ModelCatalog } from './catalog-source.js';
import {
  anthropicCredential,
  subscriptionFetch,
  subscriptionHeaders,
} from './claude-subscription.js';
import { listCodexModels } from './codex/models.js';
import type { ProviderAdmin } from './port.js';
import { providerSecret } from './service.js';

/** Each provider's own list of what the authenticated account may call. */
const endpoints: Record<Exclude<ProviderKind, 'openai-compatible'>, string> = {
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models?limit=1000',
  google: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
  openrouter: 'https://openrouter.ai/api/v1/models',
  groq: `${GROQ_BASE_URL}/models`,
};

/** A server the owner runs lists its models where the OpenAI API does, under its address. */
const endpointOf = (provider: ProviderRecord) =>
  provider.kind === 'openai-compatible'
    ? `${provider.baseURL ?? ''}/models`
    : endpoints[provider.kind as Exclude<ProviderKind, 'openai-compatible'>];

/** What the router publishes per model; everything the capability table exists to supply. */
const routed = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().optional(),
      context_length: z.number().optional(),
      top_provider: z.object({ max_completion_tokens: z.number().nullish() }).optional(),
      architecture: z.object({ input_modalities: z.array(z.string()).optional() }).optional(),
      supported_parameters: z.array(z.string()).optional(),
    }),
  ),
});

const modalities = new Set(['text', 'image', 'audio', 'video', 'pdf']);

/** The router names a document modality `file`; the contract calls the same thing `pdf`. */
function toModalities(reported: string[] | undefined): ModelCapabilities['inputModalities'] {
  const mapped = (reported ?? [])
    .map((value) => (value === 'file' ? 'pdf' : value))
    .filter((value) => modalities.has(value)) as ModelCapabilities['inputModalities'];

  return mapped.length ? [...new Set(mapped)] : ['text'];
}

/**
 * The router says whether a model takes an effort, not which levels it accepts, so the set is
 * the contract's own — a level the model rejects comes back as the provider's error, which is
 * the truth, rather than being hidden behind a guess made here.
 */
function toEfforts(parameters: string[] | undefined): ModelCapabilities['reasoningEfforts'] {
  return parameters?.includes('reasoning_effort') ? ['low', 'medium', 'high'] : [];
}

function parseRouted(body: unknown, catalog: ModelCatalog | undefined): ProviderModel[] {
  return routed
    .parse(body)
    .data.slice(0, 1000)
    .map((model) => ({
      id: model.id,
      ...(model.name ? { displayName: model.name.slice(0, 200) } : {}),
      ...modelCapabilities(
        'openrouter',
        model.id,
        {
          contextWindow: model.context_length,
          maxOutputTokens: model.top_provider?.max_completion_tokens ?? undefined,
          reasoningEfforts: toEfforts(model.supported_parameters),
          inputModalities: toModalities(model.architecture?.input_modalities),
        },
        catalog?.lookup('openrouter', model.id),
      ),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 500);
}

const listed = z.object({
  data: z
    .array(z.object({ id: z.string().min(1), display_name: z.string().optional() }))
    .optional(),
  models: z
    .array(
      z.object({
        name: z.string().min(1),
        displayName: z.string().optional(),
        inputTokenLimit: z.number().optional(),
        outputTokenLimit: z.number().optional(),
      }),
    )
    .optional(),
});

function parse(
  kind: ProviderKind,
  body: unknown,
  catalog: ModelCatalog | undefined,
): ProviderModel[] {
  if (kind === 'openrouter') {
    return parseRouted(body, catalog);
  }

  const payload = listed.parse(body);
  const rows =
    kind === 'google'
      ? (payload.models ?? []).map((model) => ({
          id: bareModelId(model.name),
          displayName: model.displayName,
          reported: {
            contextWindow: model.inputTokenLimit,
            maxOutputTokens: model.outputTokenLimit,
          },
        }))
      : (payload.data ?? []).map((model) => ({
          id: model.id,
          displayName: model.display_name,
          reported: undefined,
        }));

  const unique = new Map<string, ProviderModel>();

  for (const row of rows) {
    if (!row.id || row.id.length > 160 || unique.has(row.id)) continue;

    unique.set(row.id, {
      id: row.id,
      ...(row.displayName ? { displayName: row.displayName.slice(0, 200) } : {}),
      ...modelCapabilities(kind, row.id, row.reported, catalog?.lookup(kind, row.id)),
    });
  }

  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 500);
}

type Entry = { list: ProviderModelList; expiresAt: number };

export interface ProviderModelOptions {
  ttlMs?: number;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  catalog?: ModelCatalog;
  /** Absent means a ChatGPT login cannot be listed; its models are then typed by hand. */
  codexLogin?: { accessToken(providerId: string): Promise<string> };
}

/**
 * The model list a provider reports, cached briefly so the panel can render it on every
 * paint without a call per render.
 *
 * A provider that is down never costs the owner anything: the last successful answer is
 * served with `stale`, and if there is none the list is empty with a reason. Neither path
 * touches the stored providers or the saved defaults, and neither path substitutes a list
 * written in this repository.
 */
export class ProviderModels {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<ProviderModelList>>();
  private readonly ttlMs: number;
  private readonly catalog: ModelCatalog | undefined;
  private readonly codexLogin: ProviderModelOptions['codexLogin'];
  private readonly env: NodeJS.ProcessEnv;
  private readonly clock: Clock;

  constructor(
    private readonly services: { providers: ProviderAdmin; vault: GatewayVault },
    private readonly fetcher: typeof globalThis.fetch = fetch,
    options: ProviderModelOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60_000;
    this.catalog = options.catalog;
    this.codexLogin = options.codexLogin;
    this.env = options.env ?? process.env;
    this.clock = options.clock ?? Date.now;
  }

  async list(providerId: string): Promise<ProviderModelList> {
    const provider = (await this.services.providers.providers()).find(
      (item) => item.id === providerId && !item.revokedAt,
    );

    if (!provider) {
      throw new GatewayError(404, 'Provider not found');
    }

    const key = providerId;
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > this.clock()) {
      return cached.list;
    }

    const pending = this.inflight.get(key);

    if (pending) {
      return pending;
    }

    const request = this.refresh(provider, key, cached).finally(() => this.inflight.delete(key));

    this.inflight.set(key, request);

    return request;
  }

  private async refresh(
    provider: ProviderRecord,
    key: string,
    cached: Entry | undefined,
  ): Promise<ProviderModelList> {
    try {
      const models = await this.fetchModels(provider);
      const list: ProviderModelList = {
        providerId: provider.id,
        models,
        fetchedAt: nowIso(this.clock),
        stale: false,
      };

      if (this.cache.size >= 200) {
        this.cache.clear();
      }

      this.cache.set(key, { list, expiresAt: this.clock() + this.ttlMs });

      return list;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Provider request failed';

      // The stale copy keeps its original fetchedAt, so the panel can say how old it is.
      return {
        ...(cached?.list ?? {
          providerId: provider.id,
          models: [],
          fetchedAt: nowIso(this.clock),
        }),
        stale: true,
        reason: reason.slice(0, 300),
      };
    }
  }

  private async fetchModels(provider: ProviderRecord) {
    if (provider.authMode === 'codex') {
      return this.fetchCodexModels(provider);
    }

    const kind = provider.kind as ProviderKind;
    const key = await this.apiKey(provider);
    const bearer =
      provider.kind === 'openai' ||
      provider.kind === 'openrouter' ||
      provider.kind === 'groq' ||
      (provider.kind === 'openai-compatible' && Boolean(key)) ||
      (provider.kind === 'anthropic' &&
        anthropicCredential(provider.credential, provider.apiKeyEnv, key) === 'subscription');

    // A subscription token is only accepted from something presenting itself as Claude Code,
    // here as much as on a run: listed through the plain client it answers 401.
    const subscription = provider.kind === 'anthropic' && bearer;
    const fetcher = subscription ? await subscriptionFetch(this.fetcher) : this.fetcher;

    const response = await fetcher(endpointOf(provider), {
      headers: {
        accept: 'application/json',
        ...(provider.kind === 'google' ? { 'x-goog-api-key': key } : {}),
        ...(provider.kind === 'anthropic'
          ? { 'anthropic-version': '2023-06-01', ...(bearer ? {} : { 'x-api-key': key }) }
          : {}),
        ...(subscription ? subscriptionHeaders() : {}),
        ...(bearer && provider.kind !== 'google' ? { authorization: `Bearer ${key}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // The body can echo the key back; only the status is safe to surface.
      throw new Error(`The provider answered ${response.status} when listing models.`);
    }

    await this.catalog?.prime();

    return parse(kind, await response.json(), this.catalog);
  }

  /**
   * A ChatGPT login has its own catalog, on the Codex backend rather than on the API. The
   * token is taken from the login service so an expired one is refreshed rather than refused,
   * and the capabilities still come from the public catalog like any other model's.
   */
  private async fetchCodexModels(provider: ProviderRecord): Promise<ProviderModel[]> {
    if (!this.codexLogin) {
      throw new Error('The ChatGPT login is not available on this gateway.');
    }

    const token = await this.codexLogin.accessToken(provider.id);
    const listed = await listCodexModels(token, this.fetcher);

    await this.catalog?.prime();

    return listed.map((model) => ({
      id: model.id,
      ...(model.displayName ? { displayName: model.displayName.slice(0, 200) } : {}),
      ...modelCapabilities(
        'openai',
        model.id,
        model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts } : undefined,
        this.catalog?.lookup('openai', model.id),
      ),
    }));
  }

  private async apiKey(provider: ProviderRecord) {
    if (provider.apiKeyEnv) {
      const value = this.env[provider.apiKeyEnv]?.trim();

      if (!value) {
        throw new Error('The environment variable for this provider is not set.');
      }

      return value;
    }

    const secret = await this.services.vault.read(providerSecret(provider.id));

    // A server the owner runs may take no key at all.
    if (!secret && provider.kind !== 'openai-compatible') {
      throw new Error('Provider key is not configured');
    }

    return secret ?? '';
  }
}
