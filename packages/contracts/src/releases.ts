import { z } from 'zod';

/** One release, as its note in docs/releases says it. The body is Markdown. */
export const releaseNoteSchema = z.strictObject({
  version: z.string(),
  date: z.string(),
  summary: z.string().optional(),
  body: z.string(),
  prerelease: z.boolean(),
});

/**
 * What this installation runs and what changed in it. `unseen` is what the owner has not been
 * shown since they last read, and an empty list is the ordinary answer: it is what the panel
 * reads to decide not to open the dialog.
 */
export const releasesSchema = z.strictObject({
  version: z
    .string()
    .optional()
    .describe('Absent on a build with no version stamped on it, which has nothing to announce.'),
  notes: z.array(releaseNoteSchema),
  unseen: z.array(releaseNoteSchema),
  /** Stable releases newer than the running build, when the gateway could reach GitHub. */
  updates: z.array(releaseNoteSchema),
  behind: z.number().int().nonnegative(),
});

/** Where the project lives, and its GitHub stars when GitHub could be reached. */
export const repositorySchema = z.strictObject({
  url: z.url(),
  stars: z.number().int().nonnegative().optional(),
});

export type Repository = z.infer<typeof repositorySchema>;
export type ReleaseNote = z.infer<typeof releaseNoteSchema>;
export type Releases = z.infer<typeof releasesSchema>;
