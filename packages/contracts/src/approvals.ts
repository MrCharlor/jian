import { z } from 'zod';

/**
 * How far an agent may go on its own with one kind of action. The owner raises a level once
 * the agent has earned it, action by action; nothing here is fixed in code.
 *
 * - `1`: the agent only proposes. It describes the action and the owner performs it.
 * - `2`: the agent prepares the action and waits for the owner's approval before it runs.
 * - `3`: the agent acts and reports. A judge may still hold what looks destructive.
 */
export const autonomyLevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export type AutonomyLevel = z.infer<typeof autonomyLevelSchema>;

/**
 * The key an action is configured under: the gateway's own tool name (`run_command`), or a
 * connected server's tool as `server.tool`, which outlives the hashed name the model calls.
 */
export const actionKeySchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,239}$/);

/**
 * What the agent may do by itself, by where the action lands and then by exact action. A
 * profile starts at level 3, acting as it always did; the owner lowers a kind or an exact
 * action to 2 to see each change before it happens, or to 1 to keep the deed for themselves.
 */
export const actionPolicySchema = z.strictObject({
  machine: autonomyLevelSchema.default(3),
  service: autonomyLevelSchema.default(3),
  message: autonomyLevelSchema.default(3),
  tools: z.record(actionKeySchema, autonomyLevelSchema).default({}),
});

export type ActionPolicy = z.infer<typeof actionPolicySchema>;

export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'used', 'expired']);

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Where the owner took the decision, kept so a review can tell a tap on a phone from a click. */
export const approvalDecidedViaSchema = z.enum(['panel', 'channel', 'api']);

/** Pending approvals a profile may hold at once; beyond this the agent is asked to slow down. */
export const APPROVAL_LIMIT = 50;

/** Days a pending approval waits before it expires on its own. */
export const APPROVAL_DAYS = 7;

export const approvalRecordSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  runId: z.uuid(),
  sessionId: z.uuid(),
  /** Short, per profile, so the owner can answer "ok 3" instead of quoting an id. */
  number: z.number().int().positive(),
  /** The name the model called, so a continuation can match the same tool. */
  tool: z.string().min(1).max(200),
  /** The configured key the level was read from: `server.tool` for a connected server. */
  action: z.string().min(1).max(240),
  input: z.unknown(),
  /** The agent's own words on what the action does, for the owner to read before deciding. */
  summary: z.string().max(2000),
  status: approvalStatusSchema,
  decidedAt: z.iso.datetime().optional(),
  decidedVia: approvalDecidedViaSchema.optional(),
  reason: z.string().max(2000).optional(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

export type Approval = z.infer<typeof approvalRecordSchema>;

export const approvalDecisionSchema = z.strictObject({
  reason: z.string().trim().max(2000).optional(),
});

/**
 * An owner's answer typed in a conversation: `ok 3`, `não 3: motivo`, `no #3`. Read before the
 * text reaches the agent, so the decision is the owner's and not the model's reading of it.
 */
export const APPROVAL_REPLY =
  /^(ok|sim|yes|approve|aprovar|não|nao|no|reject|recusar)\s+#?(\d{1,6})(?:\s*[:,-]\s*(.{0,2000}))?$/i;

export type ApprovalReply = { number: number; approve: boolean; reason?: string };

export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const match = APPROVAL_REPLY.exec(text.trim());

  if (!match) return undefined;

  const [, verb, number, reason] = match;
  const approve = /^(ok|sim|yes|approve|aprovar)$/i.test(verb ?? '');

  return { number: Number(number), approve, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
}
