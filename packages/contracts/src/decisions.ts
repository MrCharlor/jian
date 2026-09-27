import { z } from 'zod';
import { secretSchema } from './security.js';

/**
 * The service that answers the gateway's own questions — whether a group message calls an
 * agent, whether an action goes further than it was asked to. It writes no text and runs no
 * conversation, so it chooses no model: without it, every question falls back to the fixed
 * rule the gateway used before.
 */
export const decisionProviderSchema = z.enum(['jev']);

/**
 * What the gateway asks the service about, each switched on or off by the owner. A use that is
 * off decides by its fixed rule, as if there were no key.
 * - actions: commands, file changes, connected-service changes and messages sent to others;
 * - outside: pages, searches and service results that try to give the agent orders;
 * - turn: before each turn, which memories and skill fit it and whether it is light;
 * - memories: a new memory about a subject already kept;
 * - learning: whether finished work holds something worth keeping;
 * - groups: whether a group message is speaking to an agent.
 */
export const decisionUseSchema = z.enum([
  'actions',
  'outside',
  'turn',
  'memories',
  'learning',
  'groups',
]);

export const decisionsInputSchema = z.strictObject({
  provider: decisionProviderSchema,
  apiKey: secretSchema,
});

export const decisionUsesSchema = z.strictObject({
  actions: z.boolean(),
  outside: z.boolean(),
  turn: z.boolean(),
  memories: z.boolean(),
  learning: z.boolean(),
  groups: z.boolean(),
});

/** What the owner chooses about spending: which uses run, and a daily ceiling in tokens. */
export const decisionsSettingsPatchSchema = z.strictObject({
  uses: decisionUsesSchema.partial().optional(),
  /** Tokens sent and received per UTC day, over every use. Null removes the ceiling. */
  dailyTokenLimit: z.number().int().min(1000).max(1_000_000_000).nullable().optional(),
});

/** The spending of one use on one UTC day. An answer served from the cache costs nothing. */
export const decisionUsageSchema = z.strictObject({
  day: z.iso.date(),
  use: decisionUseSchema,
  requests: z.number().int().min(0),
  cached: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

export const decisionsStatusSchema = z.strictObject({
  provider: decisionProviderSchema,
  configured: z.boolean(),
  updatedAt: z.iso.datetime().optional(),
  uses: decisionUsesSchema,
  dailyTokenLimit: z.number().int().min(1).optional(),
  /** The last seven UTC days, most recent first; days and uses with nothing spent are absent. */
  usage: z.array(decisionUsageSchema),
});

export type DecisionUse = z.infer<typeof decisionUseSchema>;
export type DecisionUses = z.infer<typeof decisionUsesSchema>;
export type DecisionUsage = z.infer<typeof decisionUsageSchema>;
export type DecisionsSettingsPatch = z.infer<typeof decisionsSettingsPatchSchema>;
export type DecisionsStatus = z.infer<typeof decisionsStatusSchema>;
