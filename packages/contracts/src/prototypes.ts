import { z } from 'zod';
import { applicationSlugSchema } from './applications.js';

export const prototypeStatusSchema = z.enum(['queued', 'generating', 'ready', 'failed']);

/** A picture the owner attaches to show what the screen is about: today's screen, a sketch. */
export const prototypePrintSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** Base64, as the panel reads a file. */
  data: z.string().min(1).max(8_000_000),
});

export const prototypeInputSchema = z.strictObject({
  application: applicationSlugSchema,
  title: z.string().trim().min(1).max(160),
  /** The request in the board this screen answers, so the chain Pauta → Tela → Demanda holds. */
  requestUrl: z.url().max(500).optional(),
  /** What the screen has to do, in the owner's words. */
  brief: z.string().trim().min(1).max(20_000),
  prints: z.array(prototypePrintSchema).max(6).default([]),
  /** The topic this screen answers. */
  pautaId: z.uuid().optional(),
});

export const prototypeRedoSchema = z.strictObject({
  comments: z.string().trim().min(1).max(20_000),
});

export const prototypeVersionSchema = z.strictObject({
  number: z.number().int().positive(),
  status: prototypeStatusSchema,
  /** The owner's comments that asked for this version; absent on the first. */
  comments: z.string().optional(),
  error: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
});

export const prototypeRecordSchema = z.strictObject({
  id: z.uuid(),
  application: applicationSlugSchema,
  title: z.string(),
  requestUrl: z.string().optional(),
  brief: z.string(),
  prints: z.array(z.string()),
  createdBy: z.enum(['owner', 'agent']),
  approvedVersion: z.number().int().positive().optional(),
  pautaId: z.uuid().optional(),
  /** The canvas in Claude Design the screen lives in, when it was drawn there. */
  designUrl: z.string().optional(),
  versions: z.array(prototypeVersionSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Prototype = z.infer<typeof prototypeRecordSchema>;
export type PrototypeVersion = z.infer<typeof prototypeVersionSchema>;

/** Where a version's screen opens: the same signed, sandboxed address as a component preview. */
export const prototypeVersionPath = (id: string, number: number) =>
  `prototypes/${id}/v${number}.html`;

export const PROTOTYPE_PATH = /^prototypes\/([0-9a-f-]{36})\/v(\d{1,4})\.html$/;
