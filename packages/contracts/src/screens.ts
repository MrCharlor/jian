import { z } from 'zod';
import { applicationSlugSchema } from './applications.js';
import { prototypePrintSchema } from './prototypes.js';

/**
 * A screen of an application the owner maps: where it sits in the menu, its route, and the
 * sheet an agent writes after walking through it. Listed from the code and the menu, mapped,
 * reviewed by the owner, then published as a document on the board.
 */
export const screenStateSchema = z.enum(['listed', 'mapping', 'draft', 'reviewed', 'published']);

/** Where a line of the sheet comes from. Anything not seen nor read is `unknown`. */
export const screenSourceSchema = z.enum(['screen', 'code', 'unknown']);

export const screenItemSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  source: screenSourceSchema,
});

const items = z.array(screenItemSchema).max(60);

/** The mapping template: what exists today, what it suggests was asked, what is open, what is wrong. */
export const screenSheetSchema = z.strictObject({
  today: items,
  requirements: items,
  questions: items,
  problems: items,
});

export type ScreenSheet = z.infer<typeof screenSheetSchema>;

export const screenRouteSchema = z.string().trim().min(1).max(300);

/** The team the agent thinks owns the screen. A proposal: the owner decides. */
const squadSchema = z.string().trim().min(1).max(80);

export const screenListingSchema = z.strictObject({
  route: screenRouteSchema,
  menuPath: z.string().trim().max(300).default(''),
  title: z.string().trim().min(1).max(200),
  squad: squadSchema.optional(),
});

/** Creates the screens not listed yet and updates the others. Nothing listed before is removed. */
export const screenInventoryInputSchema = z.strictObject({
  application: applicationSlugSchema,
  screens: z.array(screenListingSchema).min(1).max(500),
});

export const screenInventoryResultSchema = z.strictObject({
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

export const screenSheetInputSchema = screenSheetSchema.extend({
  squad: squadSchema.optional(),
});

export const screenPrintsInputSchema = z.strictObject({
  prints: z.array(prototypePrintSchema).min(1).max(6),
});

export const screenListQuerySchema = z.strictObject({
  application: applicationSlugSchema.optional(),
  state: screenStateSchema.optional(),
});

export const screenRecordSchema = z.strictObject({
  id: z.uuid(),
  application: applicationSlugSchema,
  route: z.string(),
  menuPath: z.string(),
  title: z.string(),
  squad: z.string().optional(),
  state: screenStateSchema,
  sheet: screenSheetSchema.optional(),
  /** The document on the board, once published. */
  workUrl: z.string().optional(),
  prints: z.array(z.string()),
  mappedAt: z.iso.datetime().optional(),
  reviewedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ScreenRecord = z.infer<typeof screenRecordSchema>;

export const screenPrintContentSchema = prototypePrintSchema.extend({ data: z.string() });
