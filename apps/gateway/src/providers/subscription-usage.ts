import type { ProviderRecord, SubscriptionUsage } from '@jian/contracts';
import { z } from 'zod';
import type { GatewayVault } from '../security/gateway-vault.js';
import {
  anthropicCredential,
  subscriptionFetch,
  subscriptionHeaders,
} from './claude-subscription.js';
import type { CodexLogin } from './codex/login.js';
import { accountHeaders } from './codex/model.js';
import { providerSecret } from './service.js';

const windowSchema = z.object({
  used_percent: z.number().finite().nonnegative().optional(),
  utilization: z.number().finite().nonnegative().optional(),
  resets_at: z.union([z.string(), z.number()]).nullish(),
  reset_at: z.union([z.string(), z.number()]).nullish(),
});

function windowOf(value: unknown, field: 'used_percent' | 'utilization') {
  const parsed = windowSchema.safeParse(value);
  if (!parsed.success) return null;
  const usedPercent = parsed.data[field];
  if (usedPercent === undefined) return null;
  const reset = parsed.data.resets_at ?? parsed.data.reset_at;
  const date =
    reset === undefined || reset === null
      ? null
      : new Date(typeof reset === 'number' ? reset * 1000 : reset);
  return {
    usedPercent,
    resetsAt: date && Number.isFinite(date.getTime()) ? date.toISOString() : null,
  };
}

const unavailable = (provider: 'codex' | 'claude'): SubscriptionUsage => ({
  provider,
  status: 'unavailable',
  fiveHour: null,
  weekly: null,
});

/** Private provider endpoints may change without notice. Never surface their response bodies. */
export class SubscriptionUsageReader {
  private codexLogin?: Pick<CodexLogin, 'accessToken'>;
  private cached?: { until: number; value: SubscriptionUsage[] };
  private pending?: Promise<SubscriptionUsage[]>;

  constructor(
    private readonly providers: { providers(): Promise<ProviderRecord[]> },
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  useCodexLogin(login: Pick<CodexLogin, 'accessToken'>) {
    this.codexLogin = login;
  }

  async read(): Promise<SubscriptionUsage[]> {
    if (this.cached && this.cached.until > this.clock()) return this.cached.value;
    this.pending ??= this.load()
      .then((value) => {
        this.cached = { until: this.clock() + 60_000, value };
        return value;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async load(): Promise<SubscriptionUsage[]> {
    const providers = (await this.providers.providers()).filter((provider) => !provider.revokedAt);
    const subscribed = providers.filter(
      (provider) =>
        provider.authMode === 'codex' ||
        (provider.kind === 'anthropic' &&
          anthropicCredential(provider.credential, provider.apiKeyEnv, undefined) ===
            'subscription'),
    );

    return Promise.all(
      subscribed.map(async (provider): Promise<SubscriptionUsage> => {
        const kind = provider.authMode === 'codex' ? 'codex' : 'claude';
        try {
          const token =
            kind === 'codex'
              ? await this.codexLogin?.accessToken(provider.id)
              : provider.apiKeyEnv
                ? process.env[provider.apiKeyEnv]
                : await this.vault.read(providerSecret(provider.id));
          if (!token) return unavailable(kind);
          const codexHeaders = kind === 'codex' ? accountHeaders(token) : null;
          if (codexHeaders && !codexHeaders['ChatGPT-Account-ID']) return unavailable(kind);
          const request = kind === 'claude' ? await subscriptionFetch(this.fetcher) : this.fetcher;
          const response = await request(
            kind === 'codex'
              ? 'https://chatgpt.com/backend-api/wham/usage'
              : 'https://api.anthropic.com/api/oauth/usage',
            {
              headers:
                kind === 'codex'
                  ? {
                      authorization: `Bearer ${token}`,
                      ...codexHeaders,
                      accept: 'application/json',
                    }
                  : {
                      authorization: `Bearer ${token}`,
                      ...subscriptionHeaders(),
                      accept: 'application/json',
                    },
              signal: AbortSignal.timeout(8_000),
            },
          );
          if (!response.ok) return unavailable(kind);
          const body = z.record(z.string(), z.unknown()).safeParse(await response.json());
          if (!body.success) return unavailable(kind);
          const windows =
            kind === 'codex'
              ? z
                  .object({ primary_window: z.unknown(), secondary_window: z.unknown() })
                  .safeParse(body.data.rate_limit)
              : z.object({ five_hour: z.unknown(), seven_day: z.unknown() }).safeParse(body.data);
          if (!windows.success) return unavailable(kind);
          const fiveHour =
            kind === 'codex'
              ? windowOf(
                  (windows.data as { primary_window: unknown }).primary_window,
                  'used_percent',
                )
              : windowOf((windows.data as { five_hour: unknown }).five_hour, 'utilization');
          const weekly =
            kind === 'codex'
              ? windowOf(
                  (windows.data as { secondary_window: unknown }).secondary_window,
                  'used_percent',
                )
              : windowOf((windows.data as { seven_day: unknown }).seven_day, 'utilization');
          return fiveHour || weekly
            ? { provider: kind, status: 'available', fiveHour, weekly }
            : unavailable(kind);
        } catch {
          return unavailable(kind);
        }
      }),
    );
  }
}
