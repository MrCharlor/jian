import { z } from 'zod';

/**
 * An epic and its tasks, written by an agent for the owner to review before anything reaches
 * the board. The owner's click on "create" is the approval; nothing is written before it.
 */
export const epicLabelSchema = z.enum(['feature', 'bugfix', 'refactor', 'style', 'docs', 'hotfix']);

export const epicImageSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  caption: z.string().trim().min(1).max(300),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** Base64, as the panel reads a file. */
  data: z.string().min(1).max(8_000_000),
  /** The epic (absent) or the task, by its position, the image goes in. */
  task: z.number().int().nonnegative().optional(),
});

export const epicTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  label: epicLabelSchema,
  /** Contexto, Hoje, Regras de negócio, Fora de escopo, Referências técnicas: markdown. */
  description: z.string().trim().min(1).max(40_000),
  /** The acceptance criteria, one per line of the card's checklist: "CA-1 (RN-1): …". */
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(40),
});

export const epicDraftInputSchema = z.strictObject({
  pautaId: z.uuid(),
  /** The request on the intake board the epic answers; it will depend on the epic. */
  requestWorkId: z.string().trim().min(1).max(80).optional(),
  title: z.string().trim().min(1).max(200),
  label: epicLabelSchema,
  /** Hoje, Esperado, Decisões, Ordem de execução, Pronto quando: markdown. */
  description: z.string().trim().min(1).max(40_000),
  /** The approved screen in Claude Design, for the card's prototype field. */
  prototypeUrl: z.url().max(500).optional(),
  tasks: z.array(epicTaskSchema).min(1).max(12),
});

export const epicDraftPatchSchema = epicDraftInputSchema
  .omit({ pautaId: true })
  .partial()
  .extend({
    /** Prints added to the ones the draft already has. */
    addImages: z.array(epicImageSchema).max(8).optional(),
  });

export const epicDraftStateSchema = z.enum(['rascunho', 'criado', 'descartado']);

export const epicDraftSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  pautaId: z.uuid(),
  pauta: z.string().optional(),
  state: epicDraftStateSchema,
  requestWorkId: z.string().optional(),
  title: z.string(),
  label: epicLabelSchema,
  description: z.string(),
  prototypeUrl: z.string().optional(),
  tasks: z.array(epicTaskSchema),
  images: z.array(epicImageSchema.omit({ data: true })),
  /** What breaks a rule the owner set, found before the owner reads it. */
  problems: z.array(z.string()),
  /** What exists on the board so far: a create that stopped half way goes on from here. */
  work: z.strictObject({
    epicId: z.string().optional(),
    /** The epic on the board, to open it. */
    epicUrl: z.string().optional(),
    taskIds: z.array(z.string()),
    linked: z.boolean(),
    announced: z.boolean(),
  }),
  error: z.string().optional(),
  proposedBy: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type EpicDraft = z.infer<typeof epicDraftSchema>;
