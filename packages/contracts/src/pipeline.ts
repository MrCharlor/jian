import { z } from 'zod';

/**
 * A request of the Entrada on its way to an epic (B23): it enters Priorizado and walks pauta,
 * plan, prototype and epic draft by itself; the owner only answers at the gates, in the inbox.
 */
export const pipelineStageSchema = z.enum([
  /** Seen in Priorizado before the chain was switched on; it waits for the owner to let it in. */
  'fora',
  /** Waiting for a free place: at most a few walk at once. */
  'fila',
  /** The author finds or opens the pauta and says whether the screen needs a prototype. */
  'pauta',
  /** Plan, Reviewer, owner, cloud drawing and the owner's OK of the drawing. */
  'prototipo',
  /** The author writes the epic and its tasks as a draft. */
  'epico',
  /** The draft is ready: the owner's OK creates it on the board. */
  'aguardando_epico',
  'criado',
  /** Stopped: the request left Priorizado, the owner refused, or a fact is missing. */
  'parado',
  'falhou',
]);

export const pipelineRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  requestWorkId: z.string(),
  requestTitle: z.string(),
  requestUrl: z.string().optional(),
  stage: pipelineStageSchema,
  pautaId: z.uuid().optional(),
  pautaTitle: z.string().optional(),
  needsPrototype: z.boolean().optional(),
  prototypeId: z.uuid().optional(),
  epicDraftId: z.uuid().optional(),
  epicDraftNumber: z.number().int().positive().optional(),
  epicWorkId: z.string().optional(),
  /** Why it stopped, or what it waits for. */
  note: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const pipelineSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  /** At most this many requests walk at once; the rest wait in line. */
  maxActive: z.number().int().min(1).max(10),
  /** The agent that writes the pauta, the plan and the draft; the one named Subaru when absent. */
  authorProfileId: z.uuid().optional(),
  /** Times a draft with problems goes back to the author before it reaches the owner as it is. */
  maxRounds: z.number().int().min(0).max(5),
});

export const pipelineSettingsPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  maxActive: z.number().int().min(1).max(10).optional(),
  authorProfileId: z.uuid().nullable().optional(),
  maxRounds: z.number().int().min(0).max(5).optional(),
});

export const pipelineIdParamsSchema = z.strictObject({ id: z.uuid() });

/** What the author reports after reading the request: the pauta, and whether a drawing is due. */
export const pipelineReportSchema = z.strictObject({
  pautaId: z.uuid().optional(),
  /** A screen that is new or visibly changes needs a prototype; a rule or backend fix does not. */
  needsPrototype: z.boolean().optional(),
  /** Slug of the application the screen is in, for the prototype. */
  application: z.string().trim().min(1).max(80).optional(),
  /** What to draw, for the prototype: the screen, the change, the rules that matter. */
  brief: z.string().trim().min(1).max(6000).optional(),
  /** Why, in one or two sentences: the owner reads it. */
  reason: z.string().trim().min(1).max(1000),
  /** The origin or the screen is unknown: the chain stops and a decision goes to the owner. */
  missing: z.string().trim().min(1).max(1000).optional(),
});

export type PipelineStage = z.infer<typeof pipelineStageSchema>;
export type Pipeline = z.infer<typeof pipelineRecordSchema>;
export type PipelineSettings = z.infer<typeof pipelineSettingsSchema>;
export type PipelineReport = z.infer<typeof pipelineReportSchema>;
