import { z } from 'zod';

/**
 * A product the owner designs for: the ERP, a mobile app, whatever comes next. Each carries its
 * design system as files in the Claude Design format — a guide, tokens, and one folder per
 * component with its notes, its types and a preview — so a new one is a record, never code.
 */
export const applicationSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/);

export const applicationPlatformSchema = z.enum(['web', 'mobile', 'desktop', 'other']);

export const applicationInputSchema = z.strictObject({
  slug: applicationSlugSchema,
  name: z.string().trim().min(1).max(100),
  url: z.url().max(500).optional(),
  audience: z.string().trim().max(500).optional(),
  platform: applicationPlatformSchema.default('web'),
  /** Where the design system came from, such as the Claude Design artifact it was copied from. */
  source: z.string().trim().max(500).optional(),
  /**
   * The owner's own copy of the design system in Claude Design. Set, prototypes are drawn there,
   * in the cloud, instead of on this machine.
   */
  designUrl: z.url().max(500).optional(),
});

export const applicationPatchSchema = applicationInputSchema.omit({ slug: true }).partial();

export const applicationRecordSchema = z.strictObject({
  id: z.uuid(),
  slug: applicationSlugSchema,
  name: z.string(),
  url: z.string().optional(),
  audience: z.string().optional(),
  platform: applicationPlatformSchema,
  source: z.string().optional(),
  designUrl: z.string().optional(),
  /** Bumps whenever a file of the design system changes. */
  version: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Application = z.infer<typeof applicationRecordSchema>;

/** A design-system path: relative, forward slashes, no way out of the application. */
export const applicationPathSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_./ -]+$/);

export const applicationFileSchema = z.strictObject({
  path: applicationPathSchema,
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export type ApplicationFile = z.infer<typeof applicationFileSchema>;

export const applicationFileQuerySchema = z.strictObject({ path: applicationPathSchema });

/** A text file of the design system, as the panel shows and edits it. */
export const applicationFileContentSchema = z.strictObject({
  path: applicationPathSchema,
  contentType: z.string(),
  text: z.string(),
});

export const applicationFileWriteSchema = z.strictObject({
  text: z.string().max(500_000),
});

/** A short-lived address the panel frames to show a component's preview. */
export const applicationPreviewSchema = z.strictObject({ url: z.string() });

export const applicationPreviewQuerySchema = z.strictObject({
  path: applicationPathSchema,
  exp: z.coerce.number().int().positive(),
  sig: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Files the owner writes by hand in the panel, kept over a re-import from the source. */
export const OWNER_FILES = ['project/preferencias-do-po.md'] as const;
