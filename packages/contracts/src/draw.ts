import { z } from 'zod';

/** A link that opens the drawing board for the owner, valid for a short while. */
export const drawLinkSchema = z.strictObject({ url: z.url() });

/** Where on the board the link lands, such as a drawing's room (`/#room=…`). */
export const drawLinkInputSchema = z.strictObject({ to: z.string().max(500).optional() });

export const drawEnterQuerySchema = z.strictObject({
  exp: z.string().regex(/^\d{10,13}$/),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
  to: z.string().max(500).optional(),
});

export const drawCheckSchema = z.strictObject({ ok: z.literal(true) });

/** A drawing kept on the list, by the owner or by an agent that drew it. */
export const drawingSchema = z.strictObject({
  id: z.uuid(),
  title: z.string(),
  url: z.string(),
  pautaId: z.uuid().optional(),
  pauta: z.string().optional(),
  createdBy: z.string().optional(),
  /** An agent can draw it again: it lives in a room the gateway holds the key of. */
  editable: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Drawing = z.infer<typeof drawingSchema>;

export const drawingInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  url: z.url().max(500),
  pautaId: z.uuid().optional(),
});
