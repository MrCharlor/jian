import { z } from 'zod';
import { modelSelectionSchema } from './providers.js';

/**
 * A comment written on the work tracker, as the gateway follows it (B22): filtered by board and
 * author without a model, a cheap triage asks whether it is the owner's to answer, and the
 * agent answers it on the card or, for what is on the high-impact list, asks the owner first.
 */
export const mentionStateSchema = z.enum([
  'received',
  'ignored_scope',
  'not_po',
  'analyzing',
  'answered',
  'waiting',
  'held',
  'owner_answered',
  'owner_ignored',
  'failed',
  /** The author is not on the owner's list of people the agent answers (B25). */
  'ignored_author',
  /** The comment reads like an attempt to steer the agent; nothing went to a model. */
  'blocked',
  /** The author's daily answers, or the card's answers in a row, ran out; the owner answers. */
  'limited',
  /** Not the squad's PO work at all; the fixed reply went on the card. */
  'out_of_scope',
]);

/**
 * comum: answered on the card; tecnica: handed to the tech lead; alto_impacto: the owner first;
 * fora_do_escopo: not the squad's PO work, the fixed reply goes on the card.
 */
export const mentionKindSchema = z.enum(['comum', 'tecnica', 'alto_impacto', 'fora_do_escopo']);

export const mentionRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  commentId: z.string(),
  activityId: z.string(),
  boardId: z.string().optional(),
  cardTitle: z.string().optional(),
  cardUrl: z.string().optional(),
  authorId: z.string(),
  authorName: z.string().optional(),
  body: z.string(),
  state: mentionStateSchema,
  kind: mentionKindSchema.optional(),
  /** Which item of the high-impact list the question falls in, counted from 1. */
  highImpactItem: z.number().int().positive().optional(),
  proposedReply: z.string().optional(),
  /** What went on the card, signature and mentions included. */
  publishedReply: z.string().optional(),
  reason: z.string().optional(),
  /** When the "o Moabe vai responder" note went on the card, for a question left waiting. */
  heldAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const mentionListQuerySchema = z.strictObject({
  state: mentionStateSchema.optional(),
});

export const mentionNumberParamsSchema = z.strictObject({
  number: z.coerce.number().int().positive(),
});

/** The owner on a waiting question: the proposed reply as it is, or the owner's own text. */
export const mentionAnswerSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000).optional(),
});

/** The six items confirmed by the owner on 14/10/2026; the owner edits them in the panel. */
export const MENTION_HIGH_IMPACT = [
  'Fiscal ou financeiro: nota, imposto, valor, Tipos e Natureza, Faturamento (afeta o Zend e a produção).',
  'Dado em produção ou ação irreversível.',
  'Escopo de épico em andamento: entra ou sai algo do que já foi combinado com o Lucas.',
  'Contradiz o Moabe: vai contra regra da base ou decisão registrada.',
  'Fora da Sigma: prazo ou compromisso com cliente, diretoria, suporte ou outra squad.',
  'Falta fato: a resposta depende de número, regra de negócio ou comportamento do sistema que a base não tem; responder seria adivinhar.',
];

export const mentionScopeSchema = z.enum(['sigma', 'workspace']);

export const mentionSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** sigma: only cards on the Entrada, Epics or Tasks of the Sigma; workspace: any card. */
  scope: mentionScopeSchema,
  /** Absent: the cheap model on the provider of the agent's conversation model. */
  triageModel: modelSelectionSchema.optional(),
  /** What every reply starts with, after the mention of who asked. */
  signature: z.string().trim().min(1).max(80),
  /** Hours a question waits for the owner before the card hears "o Moabe vai responder". */
  holdHours: z.number().int().min(1).max(72),
  highImpact: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  /** The owner on the tracker: their comments, and the agent's written with their key, start nothing. */
  ownerUserId: z.uuid(),
  /** The tracker's users the agent answers; anyone else's comment is kept and left alone. */
  responders: z.array(z.string().trim().min(1).max(120)).max(200),
  /** What goes on the card when a question is not the squad's PO work. */
  outOfScopeReply: z.string().trim().min(1).max(400),
  /** Answers one person gets in 24 hours before the owner is asked to step in. */
  dailyLimit: z.number().int().min(1).max(100),
  /** Answers the agent writes in a row on one card before the owner is asked to step in. */
  cardLimit: z.number().int().min(1).max(20),
});

export const mentionSettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  scope: mentionScopeSchema.optional(),
  triageModel: modelSelectionSchema.nullable().optional(),
  signature: z.string().trim().min(1).max(80).optional(),
  holdHours: z.number().int().min(1).max(72).optional(),
  highImpact: z.array(z.string().trim().min(1).max(400)).min(1).max(12).optional(),
  ownerUserId: z.uuid().optional(),
  responders: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
  outOfScopeReply: z.string().trim().min(1).max(400).nullable().optional(),
  dailyLimit: z.number().int().min(1).max(100).nullable().optional(),
  cardLimit: z.number().int().min(1).max(20).nullable().optional(),
});

/** One person of the tracker's workspace, and whether the agent answers them. */
export const mentionMemberSchema = z.strictObject({
  userId: z.string(),
  name: z.string(),
  email: z.string().optional(),
  answered: z.boolean(),
});

/** What the tracker's automation posts; its field names are read leniently by the gateway. */
export const commentIngressSchema = z.looseObject({});

export const commentIngressResultSchema = z.strictObject({
  accepted: z.boolean(),
  /** Why nothing will happen, when nothing will. */
  reason: z.string().optional(),
});

/** What the triage answers: whether the comment is the owner's to answer. */
export const mentionTriageSchema = z.object({
  forPo: z.boolean(),
  /** Not for the owner and not the squad's PO work either, asked of the agent or the owner. */
  outOfScope: z.boolean().optional(),
  reason: z.string().trim().min(1).max(600),
});

/** What the agent answers after reading the card, its comments and the base. */
export const mentionAnswerToolSchema = z.object({
  kind: mentionKindSchema,
  reply: z.string().trim().min(1).max(3000),
  highImpactItem: z.number().int().min(1).max(12).optional(),
  reason: z.string().trim().min(1).max(1000),
});

export type MentionState = z.infer<typeof mentionStateSchema>;
export type MentionKind = z.infer<typeof mentionKindSchema>;
export type Mention = z.infer<typeof mentionRecordSchema>;
export type MentionSettings = z.infer<typeof mentionSettingsSchema>;
export type MentionMember = z.infer<typeof mentionMemberSchema>;

/** One comment as the gateway reads it from the automation. */
export type CommentIngress = {
  commentId: string;
  activityId: string;
  authorId: string;
  body: string;
  authorName?: string;
  authorBotId?: string;
};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The comment in what the automation sent: camelCase or snake_case, flat or inside `comment`.
 * The first field found wins; without an id, a card, an author or a body there is no comment.
 */
export function parseCommentIngress(payload: unknown): CommentIngress | undefined {
  if (!payload || typeof payload !== 'object') return undefined;

  const outer = payload as Record<string, unknown>;
  const inner =
    outer.comment && typeof outer.comment === 'object'
      ? (outer.comment as Record<string, unknown>)
      : {};
  const read = (...names: string[]) => {
    for (const source of [inner, outer]) {
      for (const name of names) {
        const value = text(source[name]);
        if (value) return value;
      }
    }

    return undefined;
  };
  const commentId = read('commentId', 'comment_id', ...(outer.comment ? ['id'] : []));
  const activityId = read('activityId', 'activity_id');
  const authorId = read('authorId', 'author_id');
  const body = read('body', 'text');
  const authorName = read('authorName', 'author_name');
  const authorBotId = read('authorBotId', 'author_bot_id');

  // The body may be left out: an automation that cannot quote text safely sends only the ids,
  // and the comment is read from the tracker.
  if (!commentId || !activityId || !authorId) return undefined;

  return {
    commentId: commentId.slice(0, 120),
    activityId: activityId.slice(0, 120),
    authorId: authorId.slice(0, 120),
    body: (body ?? '').slice(0, 8000),
    ...(authorName ? { authorName: authorName.slice(0, 120) } : {}),
    ...(authorBotId ? { authorBotId: authorBotId.slice(0, 120) } : {}),
  };
}

export type MentionReply = { number: number; action: 'ok' | 'edit' | 'ignore'; body?: string };

const MENTION = 'men[cç][aã]o';
const MENTION_OK = [
  new RegExp(`^(?:ok|aprovar|aprovado|aprova|publica)\\s+${MENTION}\\s+#?(\\d{1,6})\\.?$`, 'i'),
  new RegExp(`^${MENTION}\\s+#?(\\d{1,6})\\s*[:,-]?\\s*ok\\.?$`, 'i'),
];
const MENTION_IGNORE = new RegExp(
  `^(?:ignora|ignorar|ignore|descarta)\\s+${MENTION}\\s+#?(\\d{1,6})\\.?$`,
  'i',
);
const MENTION_EDIT = new RegExp(`^${MENTION}\\s+#?(\\d{1,6})\\s*:\\s*([\\s\\S]{1,4000})$`, 'i');

/**
 * The owner on a question waiting for them, in a chat: "ok menção 3" publishes the proposed
 * reply, "menção 3: texto" publishes the owner's text, "ignora menção 3" answers nothing.
 */
export function parseMentionReply(text: string): MentionReply | undefined {
  const words = text.trim();

  for (const pattern of MENTION_OK) {
    const match = pattern.exec(words);
    if (match) return { number: Number(match[1]), action: 'ok' };
  }

  const ignored = MENTION_IGNORE.exec(words);
  if (ignored) return { number: Number(ignored[1]), action: 'ignore' };

  const edit = MENTION_EDIT.exec(words);
  const body = edit?.[2]?.trim();

  return edit && body ? { number: Number(edit[1]), action: 'edit', body } : undefined;
}
