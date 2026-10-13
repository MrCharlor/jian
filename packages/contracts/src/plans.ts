import { z } from 'zod';
import { modelSelectionSchema } from './providers.js';
import { scheduleRecordSchema } from './schedules.js';

/**
 * A plan written before an action runs, read by the Reviewer and, unless the action is
 * automatic, approved by the owner. Only prototypes plan for now; prioritization comes next.
 */
export const planActionSchema = z.enum(['prototype']);

export const planStateSchema = z.enum([
  'escrevendo',
  'em_revisao',
  'devolvido',
  'aguardando_po',
  'aprovado',
  'executado',
  'recusado',
]);

/**
 * What the Reviewer found: `divergencia` contradicts a rule, a decision or the request;
 * `regra_sensivel` touches billing, tax, customer data, price, permission or production data;
 * `lacuna` is information missing to act without inventing.
 */
export const planFindingKindSchema = z.enum(['divergencia', 'regra_sensivel', 'lacuna']);

export const planFindingSchema = z.strictObject({
  kind: planFindingKindSchema,
  text: z.string().trim().min(1).max(2000),
  /** The rule, memory, decision or line of the request the finding rests on. */
  source: z.string().trim().max(500).default(''),
});

/** The author's plan: what it will do, where each thing came from, what it assumed, what it delivers. */
export const planWriteSchema = z.strictObject({
  text: z.string().trim().min(1).max(20_000),
});

/** The Reviewer's answer. Any finding means not approved, whatever `approved` says. */
export const planReviewSchema = z.strictObject({
  revised: z.string().trim().min(1).max(20_000),
  findings: z.array(planFindingSchema).max(30).default([]),
  approved: z.boolean(),
});

export const planReturnSchema = z.strictObject({
  reason: z.string().trim().min(1).max(4000),
});

export const planRejectSchema = z.strictObject({
  reason: z.string().trim().max(4000).optional(),
});

export const planListQuerySchema = z.strictObject({
  state: planStateSchema.optional(),
});

export const planRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  action: planActionSchema,
  prototypeId: z.uuid().optional(),
  prototypeVersion: z.number().int().positive().optional(),
  title: z.string(),
  application: z.string().optional(),
  pautaId: z.uuid().optional(),
  authorProfileId: z.uuid().optional(),
  authorName: z.string().optional(),
  reviewerProfileId: z.uuid().optional(),
  reviewerName: z.string().optional(),
  original: z.string().optional(),
  revised: z.string().optional(),
  findings: z.array(planFindingSchema),
  /** Reviews done since the plan was opened or the owner last gave it back. */
  rounds: z.number().int().nonnegative(),
  state: planStateSchema,
  /** The owner's last word on it: why it went back, or why it was refused. */
  note: z.string().optional(),
  approvedBy: z.enum(['owner', 'automatico']).optional(),
  decidedVia: z.enum(['panel', 'channel', 'api', 'automatico']).optional(),
  decidedAt: z.iso.datetime().optional(),
  executedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Per action. Without a Reviewer the action runs as before, with no plan. */
export const planSettingsSchema = z.strictObject({
  action: planActionSchema,
  /** On: a plan the Reviewer approved runs without the owner's OK. */
  automatic: z.boolean(),
  /** Times a plan goes back to its author before it waits for the owner with the findings. */
  maxRounds: z.number().int().min(0).max(5),
  /** Absent: the agent that asked for the action, or Subaru. */
  authorProfileId: z.uuid().optional(),
  reviewerProfileId: z.uuid().optional(),
  /** Absent: the Reviewer's own model, as its profile sets it. */
  reviewerModel: modelSelectionSchema.optional(),
});

export const planSettingsPatchSchema = z.strictObject({
  automatic: z.boolean().optional(),
  maxRounds: z.number().int().min(0).max(5).optional(),
  authorProfileId: z.uuid().nullable().optional(),
  reviewerProfileId: z.uuid().nullable().optional(),
  reviewerModel: modelSelectionSchema.nullable().optional(),
});

export const planActionParamsSchema = z.strictObject({ action: planActionSchema });

/** Every routine the installation runs, with the plans waiting and how each action is doing. */
export const routinesSchema = z.strictObject({
  schedules: z.array(scheduleRecordSchema.extend({ profileName: z.string() })),
  waiting: z.array(planRecordSchema),
  actions: z.array(
    z.strictObject({
      action: planActionSchema,
      automatic: z.boolean(),
      reviewer: z.boolean(),
      executed: z.number().int().nonnegative(),
      /** Plans executed since the owner's last correction of this action. */
      clean: z.number().int().nonnegative(),
      lastCorrectionAt: z.iso.datetime().optional(),
    }),
  ),
});

export type PlanAction = z.infer<typeof planActionSchema>;
export type PlanState = z.infer<typeof planStateSchema>;
export type PlanFinding = z.infer<typeof planFindingSchema>;
export type Plan = z.infer<typeof planRecordSchema>;
export type PlanSettings = z.infer<typeof planSettingsSchema>;
export type Routines = z.infer<typeof routinesSchema>;

export type PlanReply = { number: number; approve: boolean; reason?: string };

const PLAN_OK = [
  /^(?:ok|aprovar|aprovado|aprova)\s+plano\s+#?(\d{1,6})\.?$/i,
  /^plano\s+#?(\d{1,6})\s*[:,-]?\s*(?:ok|aprovado|aprovar|aprova)\.?$/i,
];

const PLAN_BACK = [
  /^(?:corrig(?:e|ir|a)|devolv(?:e|er|a))\s+plano\s+#?(\d{1,6})\s*[:,-]\s*([\s\S]{1,4000})$/i,
  /^plano\s+#?(\d{1,6})\s*[:,-]\s*(?:corrig(?:e|ir|a)|devolv(?:e|er|a))\s*[:,-]?\s*([\s\S]{1,4000})$/i,
];

/**
 * The owner's answer to a plan in a chat: "ok plano 3", "plano 3: ok", "corrige plano 3: …".
 * Read before the text reaches the agent, so the decision is the owner's.
 */
export function parsePlanReply(text: string): PlanReply | undefined {
  const words = text.trim();

  for (const pattern of PLAN_OK) {
    const match = pattern.exec(words);
    if (match) return { number: Number(match[1]), approve: true };
  }

  for (const pattern of PLAN_BACK) {
    const match = pattern.exec(words);
    const reason = match?.[2]?.trim();
    if (match && reason) return { number: Number(match[1]), approve: false, reason };
  }

  return undefined;
}
