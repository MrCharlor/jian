import { createHash } from 'node:crypto';
import type { DecisionsStatus, DecisionUsage, DecisionUse, DecisionUses } from '@jian/contracts';
import {
  decisionsInputSchema,
  decisionsSettingsPatchSchema,
  decisionUseSchema,
} from '@jian/contracts';
import { desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { decisionUsage, gatewaySecrets, gatewaySettings } from '../storage/schema.js';

/** Where the installation's Jev key lives in the gateway vault. */
const SECRET = 'decisions:jev';
/** Where the owner's choices about which questions to ask live. */
const SETTINGS = 'decisions';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
/** Jev answers in 70–500 ms. Past this the fixed rule answers instead of the caller waiting. */
const DEFAULT_TIMEOUT_MS = 3000;
/**
 * A question is about a message, an action or a short excerpt, never a whole transcript.
 * Jev reads far more than this; the bound is on what leaves the machine.
 */
const MAX_STATE_CHARS = 24_000;
/**
 * The same questions over the same state get the same answers, so a repeat within this window
 * is not paid again: the command run twice in a row, the page read again. Short, because the
 * answers are advice about the moment, and a restart simply starts with an empty cache.
 */
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_ENTRIES = 500;
/**
 * Settings are read at most this often.
 */
const REFRESH_MS = 30_000;
/** What a day of usage shows in the panel. */
const USAGE_DAYS = 7;
/** Without a usage report, a token is taken as four characters sent. */
const CHARS_PER_TOKEN = 4;

const ALL_ON: DecisionUses = {
  actions: true,
  outside: true,
  turn: true,
  memories: true,
  learning: true,
  groups: true,
};

/** The three kinds of question Jev answers. The id a question is filed under is never sent. */
export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number };

const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({ type: z.literal('score'), score: z.number(), confidence: z.number() }),
]);

// An answer of an unknown shape is dropped, not fatal: the others in the request still count.
const responseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  usage: z
    .object({ input_tokens: z.number().min(0), output_tokens: z.number().min(0) })
    .optional()
    .catch(undefined),
});

const storedSettingsSchema = z
  .object({
    uses: z.record(z.string(), z.boolean()).optional(),
  })
  .catch({});

type StoredSettings = { uses: DecisionUses };

/** `use` says what the question is for: the owner can switch each use off, and it is billed to it. */
export type JudgeOptions = { use: DecisionUse; timeoutMs?: number; signal?: AbortSignal };

/**
 * Several questions over one state, in one request: they are answered in parallel and none
 * sees another's answer. Resolves to the answers by the ids given, or `undefined` when Jev
 * could not be asked — the caller then decides by its own rule.
 */
export type Judge = (
  state: unknown,
  questions: Record<string, Question>,
  options: JudgeOptions,
) => Promise<Partial<Record<string, Answer>> | undefined>;

/** A yes-or-no question: the probability, from 0 to 1, that the answer is yes. */
export type Ask = (
  question: { state: Record<string, unknown>; instructions: string; yes: string; no: string },
  options: JudgeOptions,
) => Promise<number | undefined>;

/** The probability of yes, when the answer is there and is a yes-or-no one. */
export function noul(answer: Answer | undefined): number | undefined {
  return answer?.type === 'noul' ? answer.noul : undefined;
}

/**
 * The gateway's questions to Jev. Every answer is advice: `undefined` — no key, a refused key,
 * an outage, a slow answer, a use the owner switched off — means the
 * caller decides by its own rule, so a missing or broken service changes nothing that worked
 * without it. What is sent is the one message, action or short excerpt being judged; the service
 * keeps no conversation.
 */
export class Decisions {
  private settingsRead?: { at: number; value: StoredSettings };
  private readonly cache = new Map<
    string,
    { at: number; answers: Partial<Record<string, Answer>> }
  >();

  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
    private readonly report: (line: string) => void = (line) => console.warn(line),
    private readonly clock: Clock = Date.now,
  ) {}

  async status(): Promise<DecisionsStatus> {
    const [row] = await this.store.db
      .select({ updatedAt: gatewaySecrets.updatedAt })
      .from(gatewaySecrets)
      .where(eq(gatewaySecrets.name, SECRET))
      .limit(1);
    const settings = await this.readSettings();
    const since = utcDay(this.clock() - (USAGE_DAYS - 1) * 86_400_000);
    const usage = await this.store.db
      .select()
      .from(decisionUsage)
      .where(gte(decisionUsage.day, since))
      .orderBy(desc(decisionUsage.day), decisionUsage.use);

    return {
      provider: 'jev',
      configured: row !== undefined,
      ...(row ? { updatedAt: row.updatedAt.toISOString() } : {}),
      uses: settings.uses,
      usage: usage.flatMap((item): DecisionUsage[] => {
        const use = decisionUseSchema.safeParse(item.use);

        return use.success ? [{ ...item, use: use.data }] : [];
      }),
    };
  }

  async configure(input: unknown): Promise<DecisionsStatus> {
    const { apiKey } = decisionsInputSchema.parse(input);

    await this.vault.put(SECRET, apiKey.trim());

    return this.status();
  }

  async remove(): Promise<DecisionsStatus> {
    await this.vault.discard(SECRET);

    return this.status();
  }

  /** Which uses run. What the patch leaves out stays as it was. */
  async updateSettings(input: unknown): Promise<DecisionsStatus> {
    const patch = decisionsSettingsPatchSchema.parse(input);
    const current = await this.readSettings();
    const value = { uses: { ...current.uses, ...patch.uses } };

    await this.store.db
      .insert(gatewaySettings)
      .values({ key: SETTINGS, value })
      .onConflictDoUpdate({ target: gatewaySettings.key, set: { value, updatedAt: new Date() } });
    this.settingsRead = undefined;

    return this.status();
  }

  judge: Judge = async (state, questions, options) => {
    if (Object.keys(questions).length === 0) {
      return {};
    }

    try {
      const settings = await this.settings();

      if (!settings.uses[options.use]) {
        return undefined;
      }

      // A removed key stops every answer, the remembered ones too.
      const key = await this.vault.read(SECRET);

      if (!key) {
        return undefined;
      }

      const sent = (typeof state === 'string' ? state : JSON.stringify(state)).slice(
        0,
        MAX_STATE_CHARS,
      );
      const id = createHash('sha256')
        .update(JSON.stringify([sent, questions]))
        .digest('hex');
      const cached = this.cached(id);

      if (cached) {
        await this.record(options.use, { cached: 1 });

        return cached;
      }

      const body = JSON.stringify({ model: MODEL, state: sent, questions });
      const response = await this.fetcher(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([
          ...(options.signal ? [options.signal] : []),
          AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        ]),
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        // The body may echo the question; only the status is logged.
        this.report(`jian: Jev answered ${response.status}; the fixed rule decided instead`);

        return undefined;
      }

      const { answers, usage } = responseSchema.parse(await response.json());
      const read: Partial<Record<string, Answer>> = {};

      for (const question of Object.keys(questions)) {
        const parsed = answerSchema.safeParse(answers[question]);

        if (parsed.success) {
          read[question] = parsed.data;
        }
      }

      await this.record(options.use, {
        requests: 1,
        inputTokens: Math.round(usage?.input_tokens ?? body.length / CHARS_PER_TOKEN),
        outputTokens: Math.round(usage?.output_tokens ?? 0),
      });
      this.remember(id, read);

      return read;
    } catch (error) {
      this.report(
        `jian: Jev did not answer (${error instanceof Error ? error.name : 'error'}); the fixed rule decided instead`,
      );

      return undefined;
    }
  };

  ask: Ask = async ({ state, instructions, yes, no }, options) =>
    noul(
      (
        await this.judge(
          state,
          { answer: { type: 'noul', instructions, criteria: { true: yes, false: no } } },
          options,
        )
      )?.answer,
    );

  private async readSettings(): Promise<StoredSettings> {
    const [row] = await this.store.db
      .select({ value: gatewaySettings.value })
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, SETTINGS))
      .limit(1);
    const stored = storedSettingsSchema.parse(row?.value ?? {});
    const uses = { ...ALL_ON };

    for (const use of decisionUseSchema.options) {
      const on = stored.uses?.[use];

      if (typeof on === 'boolean') {
        uses[use] = on;
      }
    }

    return { uses };
  }

  private async settings(): Promise<StoredSettings> {
    const now = this.clock();

    if (!this.settingsRead || now - this.settingsRead.at >= REFRESH_MS) {
      this.settingsRead = { at: now, value: await this.readSettings() };
    }

    return this.settingsRead.value;
  }

  /** Counts only. A failure to count never costs the answer it is counting. */
  private async record(
    use: DecisionUse,
    spent: { requests?: number; cached?: number; inputTokens?: number; outputTokens?: number },
  ): Promise<void> {
    const day = utcDay(this.clock());
    const values = {
      requests: spent.requests ?? 0,
      cached: spent.cached ?? 0,
      inputTokens: spent.inputTokens ?? 0,
      outputTokens: spent.outputTokens ?? 0,
    };

    try {
      await this.store.db
        .insert(decisionUsage)
        .values({ day, use, ...values })
        .onConflictDoUpdate({
          target: [decisionUsage.day, decisionUsage.use],
          set: {
            requests: sql`${decisionUsage.requests} + ${values.requests}`,
            cached: sql`${decisionUsage.cached} + ${values.cached}`,
            inputTokens: sql`${decisionUsage.inputTokens} + ${values.inputTokens}`,
            outputTokens: sql`${decisionUsage.outputTokens} + ${values.outputTokens}`,
          },
        });
    } catch (error) {
      this.report(
        `jian: Jev usage was not counted (${error instanceof Error ? error.name : 'error'})`,
      );
    }
  }

  private cached(id: string): Partial<Record<string, Answer>> | undefined {
    const entry = this.cache.get(id);

    if (!entry) {
      return undefined;
    }

    this.cache.delete(id);

    if (this.clock() - entry.at >= CACHE_TTL_MS) {
      return undefined;
    }

    // Read again, it is the most recent: the oldest entry is the first to go.
    this.cache.set(id, entry);

    return structuredClone(entry.answers);
  }

  private remember(id: string, answers: Partial<Record<string, Answer>>): void {
    this.cache.set(id, { at: this.clock(), answers: structuredClone(answers) });

    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= CACHE_ENTRIES) {
        break;
      }

      this.cache.delete(oldest);
    }
  }
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}
