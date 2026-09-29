import { randomUUID } from 'node:crypto';
import {
  type ModelConfig,
  type ModelRole,
  type ModelSelection,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  type ProviderRecord,
  providerInputSchema,
  providerRecordSchema,
  type Run,
  supportsModelRole,
} from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { profiles } from '../storage/schema.js';
import { modelCapabilities } from './capabilities.js';
import { environmentProvider, GROQ_BASE_URL, providerKinds } from './catalog.js';
import type { ModelCatalog } from './catalog-source.js';
import { anthropicCredential } from './claude-subscription.js';
import {
  findProvider,
  insertProvider,
  isUniqueViolation,
  listProviders,
  markProviderRevoked,
  readModelDefaults,
  revokeLiveProviders,
  writeModelDefaults,
} from './repository.js';

/** Where a provider's key lives in the vault. Revoking the provider takes the key with it. */
export const providerSecret = (providerId: string) => `provider:${providerId}`;

/** The ceilings a run freezes; the run record keeps them optional for pre-selection runs. */
export type ContextPolicy = NonNullable<Run['contextPolicy']>;

export class Providers {
  constructor(
    private readonly store: Store,
    // Credentials need no profile; the model each profile chooses with them does.
    private readonly profiles: ProfileReader,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
    private readonly catalog?: ModelCatalog,
  ) {}

  async providers() {
    const stored = await listProviders(this.store.db);
    // A configured provider hides the host environment's key for the same vendor.
    const environment = providerKinds
      .map((kind) => environmentProvider(kind))
      .filter((provider) => provider !== null)
      .filter(
        (provider) =>
          !stored.some(
            (item) => !item.revokedAt && item.kind === provider.kind && item.authMode !== 'codex',
          ),
      );

    return [...stored, ...environment];
  }

  async createProvider(input: unknown) {
    const { secret, credential, baseURL, ...data } = providerInputSchema.parse(input);
    const server = data.kind === 'openai-compatible';

    if (server && !baseURL) {
      throw new GatewayError(400, 'Give the address of the server, such as http://whisper:8000/v1');
    }

    if (!server && !secret) {
      throw new GatewayError(400, 'Paste the API key for this provider');
    }

    return this.register(
      {
        ...data,
        // Only Anthropic has two kinds of credential; for the others the question has one answer.
        ...(data.kind === 'anthropic'
          ? { credential: anthropicCredential(credential, undefined, secret) }
          : {}),
        // An address is the server's alone; every vendor has its own, fixed.
        ...(server && baseURL ? { baseURL: baseURL.replace(/\/+$/, '') } : {}),
        id: randomUUID(),
        createdAt: nowIso(this.clock),
      },
      secret,
    );
  }

  configureCodexProvider(secret: string) {
    return this.register(
      providerRecordSchema.parse({
        id: randomUUID(),
        name: 'OpenAI',
        kind: 'openai',
        authMode: 'codex',
        createdAt: nowIso(this.clock),
      }),
      secret,
    );
  }

  /**
   * One live credential per vendor and authentication mode. An OpenAI API key and a
   * ChatGPT login coexist; replacing either revokes only its own previous credential.
   * Nothing is announced — an installation credential belongs to no profile's event stream,
   * and the row's own timestamps are what says when it arrived and when it went.
   */
  private async register(provider: ProviderRecord, secret?: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const now = new Date(this.clock());

      for (const revoked of await revokeLiveProviders(
        tx,
        provider.kind,
        now,
        provider.authMode ?? 'api',
      )) {
        await this.vault.discard(providerSecret(revoked), tx);
      }

      if (secret) await this.vault.put(providerSecret(provider.id), secret, tx);

      try {
        await insertProvider(tx, provider);
      } catch (error) {
        // The partial unique index has the last word on one live credential per vendor and mode. Reaching
        // it means another request configured this vendor first, which the owner has to see as
        // a conflict rather than as a gateway fault.
        if (isUniqueViolation(error)) {
          throw new GatewayError(
            409,
            'Another provider for this vendor was configured; reload before retrying',
          );
        }

        throw error;
      }

      return provider;
    });
  }

  async revokeProvider(providerId: string) {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const provider = await findProvider(tx, providerId);

      if (!provider) {
        throw new GatewayError(404, 'Provider not found');
      }

      const revoked = { ...provider, revokedAt: provider.revokedAt ?? nowIso(this.clock) };

      await markProviderRevoked(tx, providerId, new Date(revoked.revokedAt));
      await this.vault.discard(providerSecret(providerId), tx);

      return revoked;
    });
  }

  async modelDefaults(profileId: string) {
    const profile = await this.profiles.profile(profileId);

    // Assembled from one row per role; missing optional roles start disabled, while an old
    // saved null stays Automatic.
    const defaults = await readModelDefaults(this.store.db, profileId, nowIso(this.clock));

    // A legacy owner may have switched stickers off before this role existed.
    return profile.useStickers ? defaults : { ...defaults, sticker: 'disabled' as const };
  }

  async setModelDefaults(profileId: string, input: unknown) {
    const data = modelDefaultsInputSchema.parse(input);
    // Older clients may still send transcription. Both names now address one audio selection.
    if (data.transcription && (data.audio === null || !Object.hasOwn(input as object, 'audio'))) {
      data.audio = data.transcription;
    }
    data.transcription = data.audio === 'disabled' ? null : data.audio;
    await this.warmCatalog();
    const available = await this.providers();

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);

      // Validate endpoint compatibility before persisting a model selection.
      for (const [role, selection] of Object.entries(data)) {
        if (selection && selection !== 'disabled') {
          const chosen = await this.selectedModel(selection, tx);
          const provider = available.find((item) => item.id === selection.providerId);
          if (
            provider &&
            !supportsModelRole(
              provider,
              { id: selection.modelId, ...this.capabilities(chosen.config) },
              role as ModelRole,
            )
          )
            throw new GatewayError(
              409,
              `This model cannot run ${role}; choose a compatible model and credential`,
            );
        }
      }

      const updatedAt = nowIso(this.clock);

      await writeModelDefaults(tx, profileId, data, new Date(updatedAt));
      // Keep the old switch in sync for older gateway versions and existing profiles that
      // turned stickers off before Model defaults owned the choice.
      await tx
        .update(profiles)
        .set({ useStickers: data.sticker !== 'disabled' })
        .where(eq(profiles.id, profileId));
      await recordEvent(tx, this.clock, profileId, 'model-defaults.updated', data);

      return modelDefaultsRecordSchema.parse({ ...data, id: profileId, profileId, updatedAt });
    });
  }

  async loadCapabilities(config: ModelConfig) {
    await this.catalog?.prime();
    return this.capabilities(config);
  }

  async warmCatalog() {
    await this.catalog?.prime();
  }

  capabilities(config: ModelConfig) {
    const kind =
      config.provider === 'openai-codex'
        ? 'openai'
        : config.provider === 'openai-compatible'
          ? 'openrouter'
          : config.provider;
    return modelCapabilities(
      kind,
      config.modelId,
      undefined,
      this.catalog?.lookup(kind, config.modelId),
    );
  }

  async selectedModel(
    selection: ModelSelection,
    reader: Queryable,
  ): Promise<{ config: ModelConfig; policy: ContextPolicy }> {
    const provider =
      (await findProvider(reader, selection.providerId)) ??
      providerKinds
        .map((kind) => environmentProvider(kind))
        .find((item) => item?.id === selection.providerId);

    if (!provider || provider.revokedAt) {
      throw new GatewayError(409, 'Selected provider or model is unavailable');
    }

    // Which models exist is the provider's answer and can change between two requests, so a
    // selection is never checked against a list: a provider outage would otherwise revoke a
    // model the owner already chose. Only the provider itself has to be live.
    const model = modelCapabilities(
      provider.kind,
      selection.modelId,
      undefined,
      this.catalog?.lookup(provider.kind, selection.modelId),
    );

    // Only a model whose accepted levels are actually known can have a level refused here.
    // For anything uncatalogued the provider is the authority: refusing on our own missing
    // information is how a working model ends up unusable.
    if (
      selection.reasoningEffort &&
      model.reasoningEfforts.length > 0 &&
      !model.reasoningEfforts.includes(selection.reasoningEffort)
    ) {
      throw new GatewayError(409, 'This model does not accept the selected reasoning effort');
    }

    // Ceilings, not targets: a large context window must not inflate routine memory/history.
    return {
      config: {
        // Groq and a server the owner runs both speak the OpenAI API at their own address.
        ...(provider.kind === 'groq' || provider.kind === 'openai-compatible'
          ? {
              provider: 'openai-compatible' as const,
              baseURL: provider.kind === 'groq' ? GROQ_BASE_URL : (provider.baseURL ?? ''),
            }
          : {
              provider: provider.authMode === 'codex' ? ('openai-codex' as const) : provider.kind,
            }),
        modelId: selection.modelId,
        ...(provider.kind === 'anthropic'
          ? { credential: anthropicCredential(provider.credential, provider.apiKeyEnv, undefined) }
          : {}),
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(provider.apiKeyEnv ? { apiKeyEnv: provider.apiKeyEnv } : { providerId: provider.id }),
      },
      // Reserve output inside the model's actual window. Session compaction, not a fixed
      // history share, decides when older turns leave the request.
      policy: {
        inputTokens: model.contextWindow,
        outputTokens: Math.min(
          model.maxOutputTokens,
          Math.max(1024, Math.floor(model.contextWindow / 4)),
          model.contextWindow - 256,
        ),
        memoryTokens: Math.min(32_000, Math.max(1500, Math.floor(model.contextWindow * 0.02))),
        historyTokens: model.contextWindow,
        toolResultTokens: Math.min(32_000, Math.max(1500, Math.floor(model.contextWindow * 0.02))),
        maxSteps: 500,
      },
    };
  }
}
