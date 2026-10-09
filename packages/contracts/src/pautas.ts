import { z } from 'zod';
import { applicationSlugSchema } from './applications.js';
import { workStatusSchema } from './work.js';

/**
 * A product topic the owner carries: why it exists, which screens it touches, where it stands,
 * and what was decided. The cards it produces live on the board; the topic lives here.
 */
export const pautaStateSchema = z.enum([
  'descoberta',
  'pronta-para-epico',
  'em-execucao',
  'em-teste',
  'em-producao',
  'pausada',
  'concluida',
  'descartada',
]);

export const pautaPrioritySchema = z.enum(['alta', 'media', 'baixa', 'a-definir']);

export const pautaScreenSchema = z.strictObject({
  route: z.string().trim().max(300).optional(),
  name: z.string().trim().min(1).max(160),
});

/** A card on the board the topic depends on, with the column it was last read in. */
export const pautaLinkSchema = z.strictObject({
  kind: z.enum(['pedido', 'epico', 'task']),
  workId: z.string().trim().min(1).max(80),
  title: z.string().trim().max(300).optional(),
  column: z.string().trim().max(80).optional(),
  /** The column before the last reading, when it changed. */
  previousColumn: z.string().trim().max(80).optional(),
  readAt: z.iso.datetime().optional(),
});

export const pautaInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  application: applicationSlugSchema.optional(),
  state: pautaStateSchema.default('descoberta'),
  priority: pautaPrioritySchema.default('a-definir'),
  context: z.string().trim().max(20_000).default(''),
  screens: z.array(pautaScreenSchema).max(30).default([]),
  links: z.array(pautaLinkSchema).max(60).default([]),
  nextSteps: z.string().trim().max(4000).default(''),
  /** Who the topic is waiting on now: the owner, the tech lead, an area. */
  waitingOn: z.string().trim().max(200).default(''),
});

export const pautaPatchSchema = pautaInputSchema.partial();

export const decisionStateSchema = z.enum(['proposta', 'decidida', 'descartada']);

export const decisionInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  options: z.array(z.string().trim().min(1).max(1000)).min(2).max(4),
  counterpoint: z.string().trim().min(1).max(4000),
  recommendation: z.string().trim().min(1).max(2000),
  /** The decision this one replaces, when the owner changes their mind. */
  replaces: z.number().int().positive().optional(),
});

export const decisionChoiceSchema = z.strictObject({
  choice: z.string().trim().min(1).max(1000),
  reason: z.string().trim().max(2000).optional(),
});

export const decisionRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  pautaId: z.uuid(),
  question: z.string(),
  options: z.array(z.string()),
  counterpoint: z.string(),
  recommendation: z.string(),
  state: decisionStateSchema,
  choice: z.string().optional(),
  reason: z.string().optional(),
  decidedVia: z.enum(['panel', 'channel', 'api']).optional(),
  decidedAt: z.iso.datetime().optional(),
  replaces: z.number().int().positive().optional(),
  proposedBy: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export type Decision = z.infer<typeof decisionRecordSchema>;

export const pautaRecordSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  application: z.string().optional(),
  state: pautaStateSchema,
  priority: pautaPrioritySchema,
  context: z.string(),
  screens: z.array(pautaScreenSchema),
  links: z.array(pautaLinkSchema),
  nextSteps: z.string(),
  waitingOn: z.string(),
  decisions: z.array(decisionRecordSchema),
  prototypes: z.array(
    z.strictObject({ id: z.uuid(), title: z.string(), approvedVersion: z.number().optional() }),
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Pauta = z.infer<typeof pautaRecordSchema>;

/** One task of one agent on the shared board, with how long it has been where it is. */
export const boardCardSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  status: workStatusSchema,
  profileId: z.uuid(),
  agent: z.string(),
  pautaId: z.uuid().optional(),
  pauta: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** When it entered the column it is in now. */
  statusSince: z.iso.datetime(),
  /** Milliseconds from the first move out of "todo" to "done", once done. */
  workedMs: z.number().int().nonnegative().optional(),
  /** Milliseconds spent in each column so far. */
  byStatus: z.record(z.string(), z.number().int().nonnegative()),
});

export type BoardCard = z.infer<typeof boardCardSchema>;

/** "decisão 4: B, porque …" from the owner in a chat. */
export const DECISION_REPLY = /^decis[aã]o\s+#?(\d{1,6})\s*[:,-]\s*([\s\S]{1,3000})$/i;

export function parseDecisionReply(
  text: string,
): { number: number; choice: string; reason?: string } | undefined {
  const match = DECISION_REPLY.exec(text.trim());

  if (!match) return undefined;

  const body = (match[2] ?? '').trim();
  const split = body.match(/^(.+?)(?:[,;.]\s*(?:porque|pq|motivo:?)\s+|\s+-\s+)([\s\S]+)$/i);

  return {
    number: Number(match[1]),
    choice: (split?.[1] ?? body).trim(),
    ...(split?.[2] ? { reason: split[2].trim() } : {}),
  };
}
