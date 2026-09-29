import {
  type ModelConfig,
  type Profile,
  type ProfileStats,
  profileStatsSchema,
  statsQuerySchema,
  type Usage,
} from '@jian/contracts';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import type { ProviderKind } from '../providers/catalog.js';
import type { CatalogEntry } from '../providers/catalog-source.js';
import type { SubscriptionUsageReader } from '../providers/subscription-usage.js';
import type { Store } from '../storage/database.js';
import { checkpoints, memories, runs, sessions } from '../storage/schema.js';

type Mix = { input: number; cached: number; output: number };
type Price = NonNullable<CatalogEntry['price']>;

/** How many tools the overview names; an agent can request the full breakdown. */
const TOP_TOOLS = 8;

const empty = (): Mix => ({ input: 0, cached: 0, output: 0 });

/**
 * A run's usage split three ways. Providers report input with the cached part inside it, and a
 * cached token is billed far below a fresh one, so the two are told apart before anything is
 * added up or priced.
 */
const mixOf = (usage: Usage | null): Mix => {
  if (!usage) return empty();

  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);

  return {
    input: Math.round(usage.inputTokens - cached),
    cached: Math.round(cached),
    output: Math.round(usage.outputTokens),
  };
};

const add = (into: Mix, mix: Mix) => {
  into.input += mix.input;
  into.cached += mix.cached;
  into.output += mix.output;
};

const total = (mix: Mix) => mix.input + mix.cached + mix.output;

/** List price in dollars; a cached token costs the input price when the catalog gives no other. */
const priced = (mix: Mix, price: Price) =>
  (mix.input * price.input +
    mix.cached * (price.cacheRead ?? price.input) +
    mix.output * price.output) /
  1_000_000;

/**
 * Where the catalog files a model's price. A Groq server is found under Groq; any other server
 * the owner runs has no list price.
 */
function catalogKind(config: ModelConfig): ProviderKind | undefined {
  if (config.provider === 'openai-codex') return 'openai';
  if (config.provider === 'openai-compatible')
    return config.baseURL?.includes('api.groq.com') ? 'groq' : undefined;

  return config.provider as ProviderKind;
}

/** A subscription pays for its tokens in advance: they have no price to add up. */
const subscribed = (config: ModelConfig) =>
  config.provider === 'openai-codex' ||
  (config.provider === 'anthropic' && config.credential === 'subscription');

/**
 * The numbers the Overview shows: what a profile has done since it was created, and how much it
 * used over a period, by model, by channel and by tool. Read from the runs themselves, so there
 * is no second record to drift from them. Days are the gateway's, in its own time zone.
 */
export class Stats {
  constructor(
    private readonly store: Store,
    private readonly profiles: { profile(id: string): Promise<Profile> },
    private readonly settings: { timeZone(): Promise<string> },
    private readonly prices: {
      prime(): Promise<void>;
      lookup(kind: ProviderKind, modelId: string): CatalogEntry | undefined;
    },
    private readonly clock: () => number = Date.now,
    private readonly subscriptionUsage?: Pick<SubscriptionUsageReader, 'read'>,
  ) {}

  async usageRuns(profileId: string, days: number, limit: number, offset: number) {
    await this.profiles.profile(profileId);
    await this.prices.prime();

    const rows = await this.store.db
      .select({
        id: runs.id,
        sessionId: runs.sessionId,
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        model: runs.model,
        usage: runs.usage,
        channel: sessions.channel,
      })
      .from(runs)
      .innerJoin(sessions, eq(sessions.id, runs.sessionId))
      .where(
        and(
          eq(runs.profileId, profileId),
          gte(runs.createdAt, new Date(this.clock() - days * 24 * 60 * 60 * 1000)),
        ),
      )
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(limit)
      .offset(offset);

    return rows.map((row) => {
      const mix = mixOf(row.usage);
      const kind = row.model && catalogKind(row.model);
      const price =
        row.model && !subscribed(row.model) && kind
          ? this.prices.lookup(kind, row.model.modelId)?.price
          : undefined;

      return {
        id: row.id,
        sessionId: row.sessionId,
        channel: row.channel,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        durationMs: Math.max(0, row.updatedAt.getTime() - row.createdAt.getTime()),
        model: row.model
          ? {
              provider: row.model.provider,
              modelId: row.model.modelId,
              billing: subscribed(row.model) ? 'subscription' : price ? 'metered' : 'unknown',
            }
          : null,
        tokens: mix,
        estimatedCostUsd: price ? priced(mix, price) : null,
      };
    });
  }

  async stats(profileId: string, query: unknown, allTools = false): Promise<ProfileStats> {
    const { days } = statsQuerySchema.parse(query ?? {});
    const profile = await this.profiles.profile(profileId);
    const zone = await this.settings.timeZone();
    const from = new Date(this.clock() - days * 24 * 60 * 60 * 1000);
    const db = this.store.db;

    await this.prices.prime();

    const [lifetime] = await db
      .select({
        turns: count(),
        worked: sql<string>`coalesce(sum(extract(epoch from (${runs.updatedAt} - ${runs.createdAt})) * 1000), 0)`,
      })
      .from(runs)
      .where(
        and(
          eq(runs.profileId, profileId),
          sql`${runs.status} in ('completed', 'failed', 'interrupted')`,
        ),
      );
    const [conversations] = await db
      .select({ total: count() })
      .from(sessions)
      .where(and(eq(sessions.profileId, profileId), sql`${sessions.channel} <> 'learning'`));
    const [kept] = await db
      .select({ total: count() })
      .from(memories)
      .where(eq(memories.profileId, profileId));

    const rows = await db
      .select({
        sessionId: runs.sessionId,
        status: runs.status,
        usage: runs.usage,
        model: runs.model,
        createdAt: runs.createdAt,
        channel: sessions.channel,
      })
      .from(runs)
      .innerJoin(sessions, eq(sessions.id, runs.sessionId))
      .where(and(eq(runs.profileId, profileId), gte(runs.createdAt, from)));

    const day = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const period = empty();
    const daily = new Map<string, number>();
    const models = new Map<
      string,
      {
        provider: string;
        modelId: string;
        billing: 'metered' | 'subscription' | 'unknown';
        turns: number;
        tokens: Mix;
        cost: number | null;
      }
    >();
    const channels = new Map<
      string,
      { channel: string; sessions: Set<string>; turns: number; tokens: number }
    >();
    let cost: number | null = null;
    let unpricedTokens = 0;
    let turns = 0;

    for (const row of rows) {
      const mix = mixOf(row.usage);
      const tokens = total(mix);

      if (row.status === 'completed') turns++;
      add(period, mix);

      if (tokens) {
        const date = day.format(row.createdAt);

        daily.set(date, (daily.get(date) ?? 0) + tokens);
      }

      const channel = row.channel;
      const place = channels.get(channel) ?? { channel, sessions: new Set(), turns: 0, tokens: 0 };

      place.sessions.add(row.sessionId);
      if (row.status === 'completed') place.turns++;
      place.tokens += tokens;
      channels.set(channel, place);

      if (!row.model) {
        unpricedTokens += tokens;
        continue;
      }

      const kind = catalogKind(row.model);
      const price = subscribed(row.model)
        ? undefined
        : kind && this.prices.lookup(kind, row.model.modelId)?.price;
      const billing = subscribed(row.model) ? 'subscription' : price ? 'metered' : 'unknown';
      const key = `${row.model.provider}\n${row.model.modelId}\n${billing}`;
      const model = models.get(key) ?? {
        provider: row.model.provider,
        modelId: row.model.modelId,
        billing,
        turns: 0,
        tokens: empty(),
        cost: price ? 0 : null,
      };

      if (row.status === 'completed') model.turns++;
      add(model.tokens, mix);

      if (price) {
        const spent = priced(mix, price);

        model.cost = (model.cost ?? 0) + spent;
        cost = (cost ?? 0) + spent;
      } else {
        unpricedTokens += tokens;
      }

      models.set(key, model);
    }

    const toolQuery = db
      .select({
        name: sql<string>`${checkpoints.data}->>'toolName'`,
        calls: sql<number>`count(*) filter (where ${checkpoints.data}->>'phase' = 'tool-started')`,
        failed: sql<number>`count(*) filter (where ${checkpoints.data}->>'phase' in ('tool-failed', 'tool-uncertain'))`,
      })
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.profileId, profileId),
          gte(checkpoints.createdAt, from),
          sql`${checkpoints.data}->>'toolName' is not null`,
        ),
      )
      .groupBy(sql`${checkpoints.data}->>'toolName'`)
      .orderBy(sql`2 desc`);
    const tools = await (allTools ? toolQuery : toolQuery.limit(TOP_TOOLS));

    return profileStatsSchema.parse({
      since: profile.createdAt,
      subscriptions: this.subscriptionUsage ? await this.subscriptionUsage.read() : [],
      totals: {
        turns: lifetime?.turns ?? 0,
        workedMs: Math.round(Number(lifetime?.worked ?? 0)),
        conversations: conversations?.total ?? 0,
        skillsWritten: profile.skills.filter((skill) => skill.writtenBy === 'agent').length,
        memories: kept?.total ?? 0,
      },
      period: {
        days,
        from: from.toISOString(),
        turns,
        tokens: period,
        cost,
        unpricedTokens,
        activeDays: daily.size,
        daily: [...daily]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, tokens]) => ({ day: date, tokens })),
      },
      models: [...models.values()].sort((a, b) => total(b.tokens) - total(a.tokens)),
      channels: [...channels.values()]
        .map(({ sessions: held, ...place }) => ({ ...place, conversations: held.size }))
        .sort((a, b) => b.tokens - a.tokens),
      tools: tools.map((tool) => ({
        name: tool.name,
        calls: Number(tool.calls),
        failed: Number(tool.failed),
      })),
    });
  }
}
