import { z } from 'zod';

/** How many schedules one profile keeps: plenty for a person's routines, bounded for a loop. */
export const SCHEDULE_LIMIT = 50;
/** The shortest gap a repeating schedule may leave between two runs, in minutes. */
export const SCHEDULE_MIN_INTERVAL_MINUTES = 5;

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone, such as America/Sao_Paulo. */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isTimeZone, 'Not a time zone; use an IANA name such as America/Sao_Paulo');

/** Five fields, minute to weekday, as cron writes them: `0 8 * * 1-5` is 08:00 on weekdays. */
export const cronSchema = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+$/, 'A cron expression has five fields: minute hour day month weekday');

const scheduleFields = {
  name: z.string().trim().min(1).max(80),
  /** What the agent is asked to do when the time comes, as if the owner wrote it then. */
  instruction: z.string().trim().min(1).max(4_000),
  /** The conversation the agent runs in and answers: a chat, a group, the gateway. */
  sessionId: z.uuid(),
  /** A single time; exclusive with `cron`. */
  at: z.iso.datetime({ offset: true }).optional(),
  /** A repeating time; exclusive with `at`. */
  cron: z.preprocess(
    (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
    cronSchema.optional(),
  ),
  timeZone: timeZoneSchema,
  enabled: z.boolean().default(true),
};

const oneTiming = (value: { at?: string | undefined; cron?: string | undefined }) =>
  Boolean(value.at) !== Boolean(value.cron);

export const scheduleInputSchema = z
  .strictObject(scheduleFields)
  .refine(oneTiming, { message: 'Give either a time (at) or a repetition (cron)', path: ['at'] });

/** Changes to a schedule; setting `at` clears `cron` and the other way round. */
export const schedulePatchSchema = z.strictObject({
  name: scheduleFields.name.optional(),
  instruction: scheduleFields.instruction.optional(),
  sessionId: scheduleFields.sessionId.optional(),
  at: scheduleFields.at,
  cron: scheduleFields.cron,
  timeZone: timeZoneSchema.optional(),
  enabled: z.boolean().optional(),
});

export const scheduleRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  name: z.string(),
  instruction: z.string(),
  sessionId: z.uuid(),
  at: z.string().optional(),
  cron: z.string().optional(),
  timeZone: z.string(),
  enabled: z.boolean(),
  /** When it runs next; absent once a single time has passed, or while switched off. */
  nextRunAt: z.string().optional(),
  lastRunAt: z.string().optional(),
  lastRunId: z.uuid().optional(),
  /** Why the last attempt did not start a run, when it did not. */
  lastError: z.string().optional(),
  createdBy: z.enum(['owner', 'agent']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;
export type SchedulePatch = z.infer<typeof schedulePatchSchema>;
export type Schedule = z.infer<typeof scheduleRecordSchema>;

/** One time a schedule ran, or tried to: what it was due for and how the run went. */
export const scheduleRunSchema = z.strictObject({
  id: z.uuid(),
  dueAt: z.string(),
  /** Started by hand, with Run now, rather than by the clock. */
  manual: z.boolean(),
  runId: z.uuid().optional(),
  status: z.string().optional(),
  /** Why no run started, when none did; or why the run failed. */
  error: z.string().optional(),
  createdAt: z.string(),
});

/** Settings of the whole installation, shared by every profile. */
export const gatewaySettingsSchema = z.strictObject({
  /** The zone the agents read the time in and schedules default to. */
  timeZone: z.string(),
  /** `host` while nobody chose one: the zone of the machine the gateway runs on. */
  timeZoneSource: z.enum(['setting', 'host']),
});

export const gatewaySettingsPatchSchema = z.strictObject({
  // A name sets it; null goes back to the machine's own zone.
  timeZone: timeZoneSchema.nullable(),
});

export type ScheduleRun = z.infer<typeof scheduleRunSchema>;
export type GatewaySettings = z.infer<typeof gatewaySettingsSchema>;
