import { z } from 'zod';

/**
 * The owner's inbox (B26): everything that waits for the owner, from any queue, under one
 * number that never repeats across them, answered with the same three commands.
 */
export const inboxKindSchema = z.enum([
  'aprovacao',
  'plano',
  'regra',
  'decisao',
  'validacao',
  'comentario',
  'mencao',
  'roadmap',
  'priorizacao',
]);

export const inboxItemSchema = z.strictObject({
  number: z.number().int().positive(),
  kind: inboxKindSchema,
  /** The item in its own queue: its id, and the number that queue gives it. */
  refId: z.string(),
  refNumber: z.number().int().positive(),
  title: z.string(),
  summary: z.string().optional(),
  link: z.string().optional(),
  highImpact: z.boolean(),
  /** Whether "N: texto" means something for this kind. */
  acceptsText: z.boolean(),
  /** What the owner is deciding, as a question. */
  question: z.string(),
  /** What to read before deciding: the criteria, the reason, the counterpoint. */
  details: z.array(z.string()),
  /** What each answer does, in the owner's words, and the button that does it. */
  ifOk: z.string(),
  ifNo: z.string(),
  ifText: z.string().optional(),
  okLabel: z.string(),
  noLabel: z.string(),
  createdAt: z.iso.datetime(),
});

/** Minutes from the notice to the owner's decision, by kind, over the last 30 days. */
export const inboxStatSchema = z.strictObject({
  kind: inboxKindSchema,
  decided: z.number().int().nonnegative(),
  medianMinutes: z.number().nonnegative().optional(),
});

export const inboxListSchema = z.strictObject({
  items: z.array(inboxItemSchema),
  stats: z.array(inboxStatSchema),
});

export const inboxActionSchema = z.enum(['ok', 'no', 'text']);

export const inboxDecisionSchema = z.strictObject({
  action: inboxActionSchema,
  text: z.string().trim().min(1).max(4000).optional(),
});

export const inboxNumberParamsSchema = z.strictObject({
  number: z.coerce.number().int().positive(),
});

/** What each number in a reply came to: done, or why not, in the owner's words. */
export const inboxOutcomeSchema = z.strictObject({
  number: z.number().int().positive(),
  ok: z.boolean(),
  text: z.string(),
});

export type InboxKind = z.infer<typeof inboxKindSchema>;
export type InboxItem = z.infer<typeof inboxItemSchema>;
export type InboxStat = z.infer<typeof inboxStatSchema>;
export type InboxAction = z.infer<typeof inboxActionSchema>;
export type InboxOutcome = z.infer<typeof inboxOutcomeSchema>;

export type InboxReply = { numbers: number[]; action: InboxAction; text?: string };

/** The most numbers one "ok 1-50" decides. */
export const INBOX_BATCH = 50;

const ONE = '#?\\d{1,6}(?:\\s*(?:-|a|até)\\s*#?\\d{1,6})?';
const LIST = `(${ONE}(?:\\s*(?:,|;|\\be\\b)\\s*${ONE})*)`;
const OK = new RegExp(`^(?:ok|sim|aprova|aprovado|aceita)\\s+${LIST}\\s*\\.?$`, 'i');
const NO = new RegExp(
  `^(?:n[aã]o|recusa|recusado)\\s+${LIST}\\s*(?:[:,-]\\s*([\\s\\S]{1,4000}))?$`,
  'i',
);
const TEXT = /^#?(\d{1,6})\s*:\s*([\s\S]{1,4000})$/;

/** "3", "3-7", "3 a 7", "3, 5 e 8" as numbers in order, none repeated; nothing past the batch. */
function numbers(list: string): number[] | undefined {
  const found: number[] = [];

  for (const part of list.split(/\s*(?:,|;|\be\b)\s*/i)) {
    const [from, to] = part
      .split(/\s*(?:-|\ba\b|até)\s*/i)
      .map((value) => Number(value.replace('#', '')));

    if (!from) continue;

    const last = to ?? from;

    if (last < from || last - from > INBOX_BATCH) return undefined;

    for (let value = from; value <= last; value += 1) {
      if (!found.includes(value)) found.push(value);
    }
  }

  return found.length && found.length <= INBOX_BATCH ? found : undefined;
}

/**
 * The owner on the inbox, in a chat: "ok 3", "ok 3-7", "ok 3, 5 e 8" accept; "não 3: motivo"
 * refuses; "3: texto" answers in the owner's own words. Anything else is not for the inbox.
 */
export function parseInboxReply(text: string): InboxReply | undefined {
  const words = text.trim();
  const ok = OK.exec(words);

  if (ok?.[1]) {
    const list = numbers(ok[1]);
    return list ? { numbers: list, action: 'ok' } : undefined;
  }

  const no = NO.exec(words);

  if (no?.[1]) {
    const list = numbers(no[1]);
    const reason = no[2]?.trim();

    return list ? { numbers: list, action: 'no', ...(reason ? { text: reason } : {}) } : undefined;
  }

  const answered = TEXT.exec(words);
  const body = answered?.[2]?.trim();

  return answered && body
    ? { numbers: [Number(answered[1])], action: 'text', text: body }
    : undefined;
}
