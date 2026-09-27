import type { DecisionsStatus } from '@jian/contracts';
import { decisionsInputSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { gatewaySecrets } from '../storage/schema.js';

/** Where the installation's Jev key lives in the gateway vault. */
const SECRET = 'decisions:jev';
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = 'jev-latest';
/** Jev answers in 70–500 ms. Past this the fixed rule answers instead of the caller waiting. */
const DEFAULT_TIMEOUT_MS = 3000;
/**
 * A question is about a message, an action or a short list of candidates, never a whole
 * transcript. Jev reads far more than this; the bound is on what leaves the machine.
 */
const MAX_STATE_CHARS = 24_000;

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
const responseSchema = z.object({ answers: z.record(z.string(), z.unknown()) });

export type JudgeOptions = { timeoutMs?: number; signal?: AbortSignal };

/**
 * Several questions over one state, in one request: they are answered in parallel and none
 * sees another's answer. Resolves to the answers by the ids given, or `undefined` when Jev
 * could not be asked — the caller then decides by its own rule.
 */
export type Judge = (
  state: unknown,
  questions: Record<string, Question>,
  options?: JudgeOptions,
) => Promise<Partial<Record<string, Answer>> | undefined>;

/** A yes-or-no question: the probability, from 0 to 1, that the answer is yes. */
export type Ask = (
  question: { state: Record<string, unknown>; instructions: string; yes: string; no: string },
  options?: JudgeOptions,
) => Promise<number | undefined>;

/** The probability of yes, when the answer is there and is a yes-or-no one. */
export function noul(answer: Answer | undefined): number | undefined {
  return answer?.type === 'noul' ? answer.noul : undefined;
}

/**
 * The gateway's questions to Jev. Every answer is advice: `undefined` — no key, a refused key,
 * an outage, a slow answer — means the caller decides by its own rule, so a missing or broken
 * service changes nothing that worked without it. What is sent is the one message, action or
 * short list being judged; the service keeps no conversation.
 */
export class Decisions {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly fetcher: typeof fetch,
    private readonly report: (line: string) => void = (line) => console.warn(line),
  ) {}

  async status(): Promise<DecisionsStatus> {
    const [row] = await this.store.db
      .select({ updatedAt: gatewaySecrets.updatedAt })
      .from(gatewaySecrets)
      .where(eq(gatewaySecrets.name, SECRET))
      .limit(1);

    return {
      provider: 'jev',
      configured: row !== undefined,
      ...(row ? { updatedAt: row.updatedAt.toISOString() } : {}),
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

  judge: Judge = async (state, questions, options = {}) => {
    if (Object.keys(questions).length === 0) {
      return {};
    }

    try {
      const key = await this.vault.read(SECRET);

      if (!key) {
        return undefined;
      }

      const response = await this.fetcher(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          state: (typeof state === 'string' ? state : JSON.stringify(state)).slice(
            0,
            MAX_STATE_CHARS,
          ),
          questions,
        }),
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

      const { answers } = responseSchema.parse(await response.json());
      const read: Partial<Record<string, Answer>> = {};

      for (const id of Object.keys(questions)) {
        const parsed = answerSchema.safeParse(answers[id]);

        if (parsed.success) {
          read[id] = parsed.data;
        }
      }

      return read;
    } catch (error) {
      this.report(
        `jian: Jev did not answer (${error instanceof Error ? error.name : 'error'}); the fixed rule decided instead`,
      );

      return undefined;
    }
  };

  ask: Ask = async ({ state, instructions, yes, no }, options = {}) =>
    noul(
      (
        await this.judge(
          state,
          { answer: { type: 'noul', instructions, criteria: { true: yes, false: no } } },
          options,
        )
      )?.answer,
    );
}
