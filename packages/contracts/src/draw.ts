import { z } from 'zod';

/** A link that opens the drawing board for the owner, valid for a short while. */
export const drawLinkSchema = z.strictObject({ url: z.url() });

export const drawEnterQuerySchema = z.strictObject({
  exp: z.string().regex(/^\d{10,13}$/),
  sig: z.string().regex(/^[0-9a-f]{64}$/),
});

export const drawCheckSchema = z.strictObject({ ok: z.literal(true) });
