import { z } from 'zod';
import { epicLabelSchema } from './epics.js';

/**
 * The owner's check of an epic the tester passed: the "done when" as items, what the tester
 * recorded, and the owner's answer per item. A failed item becomes a return card draft.
 */
export const validationResultSchema = z.enum(['passou', 'falhou']);

export const validationItemSchema = z.strictObject({
  text: z.string(),
  result: validationResultSchema.optional(),
  reason: z.string().optional(),
  /** The task a failed item returns to; a return card depends on it. */
  taskId: z.string().optional(),
});

export const validationTaskSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  checklist: z.array(z.strictObject({ text: z.string(), done: z.boolean() })),
});

export const returnDraftSchema = z.strictObject({
  item: z.number().int().nonnegative(),
  taskId: z.string(),
  title: z.string(),
  label: epicLabelSchema,
  description: z.string(),
  criteria: z.array(z.string()),
  problems: z.array(z.string()),
  state: z.enum(['rascunho', 'criado']),
  workId: z.string().optional(),
  error: z.string().optional(),
});

export type ReturnDraft = z.infer<typeof returnDraftSchema>;

export const validationSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  epicWorkId: z.string(),
  epicTitle: z.string(),
  epicUrl: z.string(),
  previewUrl: z.string().optional(),
  prototypeUrl: z.string().optional(),
  pautaId: z.uuid().optional(),
  pauta: z.string().optional(),
  items: z.array(validationItemSchema),
  tasks: z.array(validationTaskSchema),
  /** What the tester and the team wrote lately, newest first. */
  notes: z.array(z.string()),
  state: z.enum(['aberta', 'aprovada', 'reprovada']),
  commented: z.boolean(),
  returns: z.array(returnDraftSchema),
  decidedVia: z.enum(['panel', 'channel', 'api']).optional(),
  decidedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Validation = z.infer<typeof validationSchema>;

export const validationAnswerSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        result: validationResultSchema,
        reason: z.string().trim().max(2000).optional(),
        taskId: z.string().trim().max(80).optional(),
      }),
    )
    .min(1)
    .max(40),
  /** Anything the owner saw beyond the items, kept in the comment. */
  note: z.string().trim().max(4000).optional(),
});

export const returnDraftPatchSchema = z.strictObject({
  taskId: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  label: epicLabelSchema.optional(),
  description: z.string().trim().min(1).max(40_000).optional(),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(40).optional(),
});

/** "validação 3 aprovada", "reprovado: o filtro não limpa" from the owner in a chat. */
export function parseValidationReply(
  text: string,
): { number?: number; approved: boolean; reason?: string } | undefined {
  const match = text
    .trim()
    .match(
      /^(?:valida[cç][aã]o\s+#?(\d{1,6})\s*[:,-]?\s*)?(aprovad[oa]|reprovad[oa])(?:\s+#?(\d{1,6}))?\s*(?:[:,-]\s*([\s\S]{1,2000}))?$/i,
    );

  if (!match) return undefined;

  const number = Number(match[1] ?? match[3]) || undefined;
  const approved = /^aprovad/i.test(match[2] ?? '');

  return {
    ...(number ? { number } : {}),
    approved,
    ...(match[4]?.trim() ? { reason: match[4].trim() } : {}),
  };
}
