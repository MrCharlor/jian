import { z } from 'zod';
import { groupTurnSchema } from './channels.js';
import { agentCallOriginSchema } from './peers.js';
import { contextPolicySchema, modelSchema, profileSchema, sessionSchema } from './profile.js';
import { modelSelectionSchema } from './providers.js';

const uuid = z.uuid();
const timestamp = z.iso.datetime();

export const profileRecordSchema = profileSchema.extend({
  id: uuid,
  version: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const sessionRecordSchema = sessionSchema.extend({
  // Null until the agent has read the first message and named it.
  title: z.string().max(160).nullable(),
  id: uuid,
  profileId: uuid,
  // Only on the session a pair of agents shares: the profile on the other side of it. The
  // session belongs to this profile alone; the peer never reads it.
  peerProfileId: uuid.optional(),
  // On a channel conversation: with one person, or with a group of them.
  scope: z.enum(['direct', 'group']).optional(),
  /**
   * What the conversation held before `summarizedUpTo`, written by the agent's own model when
   * the history outgrew what a request may carry. The turns themselves are kept in the
   * database and stay readable in the panel; only the prompt stops carrying them.
   */
  summary: z.string().max(20_000).optional(),
  summarizedUpTo: timestamp.optional(),
  /** Chosen for this conversation alone; absent, it runs on the profile's model defaults. */
  model: modelSelectionSchema.optional(),
  createdAt: timestamp,
});

/**
 * A session as a list shows it: with the last thing said in it, cut to a line, so the owner
 * reads where each conversation stands without opening it.
 */
export const sessionSummarySchema = sessionRecordSchema.extend({
  lastMessage: z
    .strictObject({
      role: z.enum(['user', 'assistant']),
      text: z.string().max(200),
      at: timestamp,
    })
    .optional(),
});

export const messageRecordSchema = z.strictObject({
  id: uuid,
  profileId: uuid,
  sessionId: uuid,
  // Absent on what the agent read in a group without being called: no run answered it.
  runId: uuid.optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  // Who wrote it, in a room where several people write: their id on the channel and the name
  // they showed. The content still carries the name first, because the agent reads it there.
  author: z.strictObject({ id: z.string(), name: z.string().optional() }).optional(),
  // In an agent conversation this profile started: the other agent's run that answers it, in
  // that agent's own session. The asking agent only carries the message; the other one works.
  call: z.strictObject({ profileId: uuid, sessionId: uuid, runId: uuid }).optional(),
  createdAt: timestamp,
});

/** Someone who wrote in a group conversation, and the picture they show on its channel. */
export const personSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  avatar: z.string().optional(),
});

export const memoryRecordSchema = z.strictObject({
  id: z.string(),
  profileId: uuid,
  key: z.string(),
  content: z.string(),
  version: z.number().int().positive(),
  sourceSessionId: uuid.optional(),
  // The keys of the memories recalled together with this one.
  links: z.array(z.string()).optional(),
  updatedAt: timestamp,
});

/**
 * Counts, not money. `inputTokens` is what was sent and `outputTokens` what came back;
 * `cachedInputTokens` is the part of the input the provider served from its own cache and
 * usually bills differently, so it is kept apart rather than folded into a total. `estimated`
 * marks a run where at least one step reported no usage and the gateway counted the prompt
 * itself — a number to read as an order of magnitude, never as an invoice.
 */
export const usageSchema = z.strictObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().default(0),
  estimated: z.boolean().default(false),
  steps: z.number().int().nonnegative(),
});

/**
 * What the agent is doing right now, while it is doing it. Presentation only: the answer is
 * written to history when the run ends, so nothing here is ever the record of what was said.
 * It is a column rather than an event because a reader wants the latest state, not every one.
 */
export const runProgressSchema = z.strictObject({
  phase: z.enum(['thinking', 'tool', 'writing']),
  /** The tool now running. Chat channels never render it; the panel does. */
  tool: z.string().max(100).optional(),
  /** The current answer segment, reset whenever a tool interrupts it, so it converges. */
  text: z.string().max(8000).default(''),
  steps: z.number().int().nonnegative().default(0),
  updatedAt: timestamp,
});

export const runRecordSchema = z.strictObject({
  id: uuid,
  profileId: uuid,
  sessionId: uuid,
  requestKey: z.string(),
  input: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
  createdAt: timestamp,
  updatedAt: timestamp,
  error: z.string().optional(),
  output: z.string().optional(),
  usage: usageSchema.optional(),
  continuationOf: uuid.optional(),
  model: modelSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  contextPolicy: contextPolicySchema.optional(),
  // Present when another profile asked for this run; it carries the chain's spent budget.
  call: agentCallOriginSchema.optional(),
  // Present when a group message started this run; it carries the room's spent budget.
  group: groupTurnSchema.optional(),
  progress: runProgressSchema.optional(),
  /**
   * What the agent said before the answer, one entry per step that spoke on its way to using a
   * tool. A chat channel sends each as it appears, so the conversation moves while the work
   * happens instead of arriving all at once at the end. The final answer is not in here.
   */
  commentary: z.array(z.string().max(4000)).max(20).optional(),
  /** Set when the agent that asked stopped waiting: where its late answer is to be carried. */
  relayTo: uuid.optional(),
});

/**
 * How much a profile ran on one day. Days with nothing are left out, because a year of zeroes
 * is the shape of the calendar rather than anything the profile did.
 */
/**
 * Which midnight ends a day. A calendar drawn in UTC puts an evening in Brazil on tomorrow's
 * square, so the reader is told the wrong day about their own work. Absent means UTC.
 */
export const activityQuerySchema = z.strictObject({
  zone: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+)*$/)
    .max(64)
    .optional(),
});

export const activityDaySchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

const tokenMixSchema = z.strictObject({
  // Input read fresh, input served from the provider's cache, and output written.
  input: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

/**
 * How the model was paid for: per token at list price, inside a subscription (a Claude token or
 * a ChatGPT sign-in, where a token has no price), or at a price the catalog does not know.
 */
export const billingSchema = z.enum(['metered', 'subscription', 'unknown']);

export const statsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(3660).default(30),
});

const subscriptionWindowSchema = z.strictObject({
  usedPercent: z.number().finite().nonnegative(),
  resetsAt: timestamp.nullable(),
});

export const subscriptionUsageSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']),
  status: z.enum(['available', 'unavailable']),
  fiveHour: subscriptionWindowSchema.nullable(),
  weekly: subscriptionWindowSchema.nullable(),
});

export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

/** What a profile has done: since it was created, and over the period asked for. */
export const profileStatsSchema = z.strictObject({
  since: timestamp,
  subscriptions: z.array(subscriptionUsageSchema),
  totals: z.strictObject({
    turns: z.number().int().nonnegative(),
    // Time its turns took, start to finish, added up.
    workedMs: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    skillsWritten: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
  }),
  period: z.strictObject({
    days: z.number().int().positive(),
    from: timestamp,
    turns: z.number().int().nonnegative(),
    tokens: tokenMixSchema,
    // Estimated from list prices; null when nothing in the period had a known price.
    cost: z.number().nonnegative().nullable(),
    // Part of the tokens used inside a subscription or at an unknown price, left out of cost.
    unpricedTokens: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
    daily: z.array(z.strictObject({ day: z.string(), tokens: z.number().int().nonnegative() })),
  }),
  models: z.array(
    z.strictObject({
      provider: z.string(),
      modelId: z.string(),
      billing: billingSchema,
      turns: z.number().int().nonnegative(),
      tokens: tokenMixSchema,
      cost: z.number().nonnegative().nullable(),
    }),
  ),
  channels: z.array(
    z.strictObject({
      channel: z.string(),
      conversations: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      calls: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  ),
});

export type ProfileStats = z.infer<typeof profileStatsSchema>;

export const revisionRecordSchema = z.strictObject({
  id: z.string(),
  profileId: uuid,
  profile: profileRecordSchema,
  createdAt: timestamp,
});

export const eventSchema = z.strictObject({
  id: z.number().int(),
  profileId: uuid,
  runId: uuid.optional(),
  type: z.string(),
  data: z.unknown(),
  createdAt: timestamp,
});

export type Usage = z.infer<typeof usageSchema>;

export type ModelConfig = z.infer<typeof profileSchema>['model'];

export type Profile = z.infer<typeof profileRecordSchema>;

export type Session = z.infer<typeof sessionRecordSchema>;

export type Message = z.infer<typeof messageRecordSchema>;
export type Person = z.infer<typeof personSchema>;

export type Memory = z.infer<typeof memoryRecordSchema>;

export type RunProgress = z.infer<typeof runProgressSchema>;

export type Run = z.infer<typeof runRecordSchema> & {
  profile: Profile;
  leaseOwner?: string;
  leaseUntil?: number;
};

export type ActivityDay = z.infer<typeof activityDaySchema>;

export type ProfileRevision = z.infer<typeof revisionRecordSchema>;

export type GatewayEvent = z.infer<typeof eventSchema>;

export const checkpointSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  runId: z.uuid(),
  data: z.unknown(),
  createdAt: z.iso.datetime(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * One tool the agent used during a turn, as the owner's timeline shows it: what it was, how long
 * it took and how it ended. `stopped` is a tool that started in a turn that ended before it came
 * back. What it received and returned stays in the run's checkpoints.
 */
export const toolStepSchema = z.strictObject({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['running', 'done', 'failed', 'refused', 'uncertain', 'stopped']),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  error: z.string().optional(),
});

export const runTimelineSchema = z.strictObject({
  runId: uuid,
  steps: z.array(toolStepSchema),
});

export type ToolStep = z.infer<typeof toolStepSchema>;
export type RunTimeline = z.infer<typeof runTimelineSchema>;

export const continuationSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  requestKey: z.string().min(1).max(120),
  reconciliation: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      'Describe which external effects completed or were verified absent before continuing.',
    ),
});
