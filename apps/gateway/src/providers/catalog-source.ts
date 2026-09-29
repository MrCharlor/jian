import type { ModelCapabilities } from '@jian/contracts';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import type { ProviderKind } from './catalog.js';

/**
 * A public catalog of what each model can do, maintained outside this repository. It is the
 * answer to a question no provider listing answers completely: Anthropic and Gemini report
 * token limits but not modalities or reasoning levels, and OpenAI reports neither.
 *
 * Keeping the same facts in a table here would mean shipping a release every time a model is
 * announced, and being wrong in between.
 */
const CATALOG_URL = 'https://models.dev/api.json';

/** Long enough that the panel never waits on it, short enough to pick up a new model same-day. */
const TTL_MS = 4 * 60 * 60 * 1000;

const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const modality = z.enum(['text', 'image', 'audio', 'video', 'pdf']);

/**
 * Read leniently, field by field. The catalog describes hundreds of providers and one of them
 * having a null where a string belongs must not cost every other model its capabilities — the
 * whole point of this source is that nobody here reviews it before it is used.
 */
const entry = z.looseObject({
  name: z.string().optional().catch(undefined),
  limit: z
    .looseObject({
      context: z.number().optional().catch(undefined),
      output: z.number().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  modalities: z
    .looseObject({
      input: z.array(z.string()).optional().catch(undefined),
      output: z.array(z.string()).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  release_date: z.string().optional().catch(undefined),
  cost: z
    .looseObject({
      input: z.number().optional().catch(undefined),
      output: z.number().optional().catch(undefined),
      cache_read: z.number().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  reasoning_options: z
    .array(
      z.looseObject({
        type: z.string().optional().catch(undefined),
        values: z.array(z.string()).optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
});

const catalog = z.record(
  z.string(),
  z.looseObject({ models: z.record(z.string(), z.unknown()).optional().catch(undefined) }),
);

export type CatalogEntry = {
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningEfforts: ModelCapabilities['reasoningEfforts'];
  inputModalities: ModelCapabilities['inputModalities'];
  /** What the model returns. Empty means the catalog did not say, not that it returns nothing. */
  outputModalities: ModelCapabilities['inputModalities'];
  /** ISO date, when the catalog carries one. It is how a newer model wins over an older one. */
  releaseDate?: string;
  /** List prices in US dollars per million tokens, when the catalog carries them. */
  price?: { input: number; output: number; cacheRead?: number };
};

const modalities = (values: string[] | undefined): ModelCapabilities['inputModalities'] =>
  (values ?? []).flatMap((value) => {
    const parsed = modality.safeParse(value);

    return parsed.success ? [parsed.data] : [];
  });

function toEntry(model: z.infer<typeof entry>): CatalogEntry {
  const levels = model.reasoning_options?.find((option) => option.type === 'effort')?.values ?? [];

  return {
    ...(model.name ? { displayName: model.name.slice(0, 200) } : {}),
    ...(model.limit?.context ? { contextWindow: model.limit.context } : {}),
    ...(model.limit?.output ? { maxOutputTokens: model.limit.output } : {}),
    // Levels the catalog names but the contract does not carry are dropped rather than
    // renamed: offering an effort the provider will reject helps no one.
    reasoningEfforts: levels.flatMap((value) => {
      const parsed = effort.safeParse(value);

      return parsed.success ? [parsed.data] : [];
    }),
    inputModalities: modalities(model.modalities?.input),
    outputModalities: modalities(model.modalities?.output),
    ...(model.release_date ? { releaseDate: model.release_date } : {}),
    ...(model.cost?.input !== undefined && model.cost.output !== undefined
      ? {
          price: {
            input: model.cost.input,
            output: model.cost.output,
            ...(model.cost.cache_read !== undefined ? { cacheRead: model.cost.cache_read } : {}),
          },
        }
      : {}),
  };
}

type Loaded = { byProvider: Map<string, Map<string, CatalogEntry>>; fetchedAt: number };

/**
 * Reads the catalog once every few hours and keeps the last good copy forever. A catalog that
 * cannot be reached never blocks a run and never empties a model list: the caller falls through
 * to whatever the provider itself reported.
 */
export class ModelCatalog {
  private loaded: Loaded | undefined;
  private inflight: Promise<Loaded | undefined> | undefined;

  constructor(
    private readonly fetcher: typeof globalThis.fetch = fetch,
    private readonly clock: Clock = Date.now,
    private readonly url = CATALOG_URL,
    private readonly report: (reason: string) => void = (reason) =>
      console.error(`jian: could not read the model catalog (${reason})`),
  ) {}

  /** Never throws: a missing catalog is a gap to fall through, not a failure to report. */
  async prime(): Promise<void> {
    if (this.loaded && this.loaded.fetchedAt + TTL_MS > this.clock()) {
      return;
    }

    this.inflight ??= this.load().finally(() => {
      this.inflight = undefined;
    });

    const loaded = await this.inflight;

    if (loaded) {
      this.loaded = loaded;
    }
  }

  lookup(kind: ProviderKind, modelId: string): CatalogEntry | undefined {
    const models = this.loaded?.byProvider.get(kind);

    if (!models) {
      return undefined;
    }

    const id = modelId.toLowerCase();

    // An id may arrive vendor-prefixed (`anthropic/claude-sonnet-5`) or dated
    // (`claude-sonnet-4-5-20250929`); the catalog keys the bare, undated family id.
    const bare = id.includes('/') ? (id.split('/').pop() ?? id) : id;

    return (
      models.get(bare) ??
      [...models.entries()]
        .filter(([key]) => bare.startsWith(`${key}-`))
        .sort(([a], [b]) => b.length - a.length)[0]?.[1]
    );
  }

  private async load(): Promise<Loaded | undefined> {
    try {
      const response = await this.fetcher(this.url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        this.report(`the model catalog answered ${response.status}`);

        return undefined;
      }

      const parsed = catalog.parse(await response.json());
      const byProvider = new Map<string, Map<string, CatalogEntry>>();

      for (const [provider, body] of Object.entries(parsed)) {
        const models = new Map<string, CatalogEntry>();

        for (const [id, model] of Object.entries(body.models ?? {})) {
          const parsedModel = entry.safeParse(model);

          if (parsedModel.success) {
            models.set(id.toLowerCase(), toEntry(parsedModel.data));
          }
        }

        byProvider.set(provider, models);
      }

      return { byProvider, fetchedAt: this.clock() };
    } catch (error) {
      this.report(error instanceof Error ? error.message : 'erro desconhecido');

      return undefined;
    }
  }
}
