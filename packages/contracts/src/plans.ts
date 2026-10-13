import { z } from 'zod';
import { priorityCardSchema } from './priorities.js';
import { modelSelectionSchema } from './providers.js';
import { scheduleRecordSchema } from './schedules.js';

/**
 * A plan written before an action runs, read by the Reviewer and, unless the action is
 * automatic, approved by the owner: a prototype before it is drawn, the order of the column
 * the team pulls from before it is applied on the board, and the moves that keep the requests
 * of the Entrada and the epics in step with the work (`entry_sync`).
 */
export const planActionSchema = z.enum(['prototype', 'priority', 'entry_sync']);

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
  /**
   * The questions to the owner, also written in the text. At most three, only what changes the
   * work and has no reasonable default; one that touches a sensitive rule counts past three.
   */
  questions: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
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

/**
 * One card moved by an entry sync: an epic by its tasks, or a request of the Entrada by its
 * epic. The column names are the board's; the ids are read on the board when the plan is made.
 */
export const entryMoveSchema = z.strictObject({
  workId: z.string().min(1).max(80),
  title: z.string(),
  board: z.enum(['entrada', 'epics']),
  from: z.string(),
  to: z.string(),
  fromStatusId: z.string().min(1).max(80),
  toStatusId: z.string().min(1).max(80),
  reason: z.string(),
  url: z.string(),
  /** What happened when the plan ran: moved, left alone (and why), or the board's error. */
  result: z.enum(['feito', 'pulado', 'falhou']).optional(),
  resultNote: z.string().optional(),
});

/** A request in Priorizado with no epic of the squad linked, for longer than the limit. */
export const entryStaleSchema = z.strictObject({
  workId: z.string().min(1).max(80),
  title: z.string(),
  days: z.number().int().nonnegative(),
  url: z.string(),
});

/** A move the author or an earlier refusal of the owner left out of the plan, with why. */
export const entrySkippedSchema = z.strictObject({
  workId: z.string().min(1).max(80),
  title: z.string(),
  to: z.string(),
  reason: z.string(),
});

export const entrySyncSchema = z.strictObject({
  moves: z.array(entryMoveSchema),
  stale: z.array(entryStaleSchema),
  skipped: z.array(entrySkippedSchema),
  /** When the boards were read. */
  readAt: z.iso.datetime(),
});

/** Moves the author leaves out when it reads again, as the Reviewer or the owner asked. */
export const entrySyncRunSchema = z.strictObject({
  skip: z
    .array(
      z.strictObject({
        workId: z.string().min(1).max(80),
        reason: z.string().trim().min(1).max(500),
      }),
    )
    .max(50)
    .default([]),
});

export const planRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  action: planActionSchema,
  prototypeId: z.uuid().optional(),
  prototypeVersion: z.number().int().positive().optional(),
  title: z.string(),
  application: z.string().optional(),
  /** The proposed order a prioritization plan applies once approved. */
  priorityProposalId: z.uuid().optional(),
  priority: z
    .strictObject({
      number: z.number().int().positive(),
      summary: z.string(),
      cards: z.array(priorityCardSchema),
    })
    .optional(),
  /** The moves an entry sync makes once approved, and the requests standing still. */
  entrySync: entrySyncSchema.optional(),
  pautaId: z.uuid().optional(),
  authorProfileId: z.uuid().optional(),
  authorName: z.string().optional(),
  reviewerProfileId: z.uuid().optional(),
  reviewerName: z.string().optional(),
  original: z.string().optional(),
  revised: z.string().optional(),
  findings: z.array(planFindingSchema),
  /** What the author asked the owner in its last version; absent before it wrote one. */
  questions: z.array(z.string()).optional(),
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

/**
 * Per action. Without a Reviewer a prototype or a prioritization runs as before, with no plan;
 * an entry sync still makes its plan, which goes straight to the owner and never runs alone.
 */
export const planSettingsSchema = z.strictObject({
  action: planActionSchema,
  /** On: a plan the Reviewer approved runs without the owner's OK. */
  automatic: z.boolean(),
  /** Times a plan goes back to its author before it waits for the owner with the findings. */
  maxRounds: z.number().int().min(0).max(5),
  /** Absent: the agent that asked for the action or proposed the order, or Subaru. */
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
  /** Questions per written plan, by the week the plan was opened (Monday), oldest first. */
  questionsPerWeek: z.array(
    z.strictObject({
      week: z.iso.date(),
      plans: z.number().int().nonnegative(),
      questions: z.number().int().nonnegative(),
      average: z.number().nonnegative(),
    }),
  ),
});

/** What a read of the boards gave: the plan it opened or kept, or nothing to do. */
export const entrySyncResultSchema = z.strictObject({
  moves: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** The open plan already says the same; no new one was made. */
  unchanged: z.boolean(),
  plan: planRecordSchema.optional(),
  message: z.string(),
});

export type PlanAction = z.infer<typeof planActionSchema>;
export type EntryMove = z.infer<typeof entryMoveSchema>;
export type EntryStale = z.infer<typeof entryStaleSchema>;
export type EntrySkipped = z.infer<typeof entrySkippedSchema>;
export type EntrySync = z.infer<typeof entrySyncSchema>;
export type EntrySyncResult = z.infer<typeof entrySyncResultSchema>;
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
