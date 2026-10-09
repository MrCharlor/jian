import { z } from 'zod';

/**
 * The owner's ordering of a board column (the requests the team pulls first), proposed by an
 * agent with a reason per card, adjusted and applied by the owner — or by the agent, at the
 * autonomy level the owner gave it.
 */
export const priorityCriteriaSchema = z.strictObject({
  text: z.string().max(8000),
  updatedAt: z.iso.datetime().optional(),
});

export type PriorityCriteria = z.infer<typeof priorityCriteriaSchema>;

export const priorityCriteriaInputSchema = z.strictObject({ text: z.string().trim().max(8000) });

const workId = z.string().trim().min(1).max(80);

export const priorityProposalInputSchema = z.strictObject({
  workspaceId: workId,
  boardId: workId,
  /** The column being ordered. */
  statusId: workId,
  /** The column cards may be raised from, such as the approved requests. */
  sourceStatusId: workId.optional(),
  /** The connected server whose key reaches the board; the one at `/v1/mcp` when omitted. */
  server: z.string().trim().min(1).max(80).optional(),
  summary: z.string().trim().min(1).max(4000),
  cards: z
    .array(
      z.strictObject({
        workId,
        reason: z.string().trim().min(1).max(1000),
        /** The card waits in the source column and should come up into this one. */
        raise: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(100),
});

export const priorityCardSchema = z.strictObject({
  workId: z.string(),
  title: z.string(),
  reason: z.string().optional(),
  raise: z.boolean(),
});

export type PriorityCard = z.infer<typeof priorityCardSchema>;

export const priorityProposalStateSchema = z.enum(['proposta', 'aplicada', 'descartada']);

export const priorityProposalSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  state: priorityProposalStateSchema,
  workspaceId: z.string(),
  boardId: z.string(),
  statusId: z.string(),
  sourceStatusId: z.string().optional(),
  summary: z.string(),
  /** The proposed order. */
  cards: z.array(priorityCardSchema),
  /** The column as it was when the proposal was made. */
  current: z.array(z.strictObject({ workId: z.string(), title: z.string() })),
  /** The order applied on the board, once applied. */
  applied: z.array(z.strictObject({ workId: z.string(), title: z.string() })).optional(),
  /** Whether the owner changed the order or the raised cards before applying. */
  adjusted: z.boolean().optional(),
  error: z.string().optional(),
  note: z.string().optional(),
  proposedBy: z.string().optional(),
  decidedVia: z.enum(['panel', 'channel', 'api', 'agent']).optional(),
  decidedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});

export type PriorityProposal = z.infer<typeof priorityProposalSchema>;

export const priorityApplySchema = z.strictObject({
  /** The final order, by card id; the proposed one when omitted. */
  order: z.array(workId).max(100).optional(),
});

export const priorityDiscardSchema = z.strictObject({
  note: z.string().trim().max(2000).optional(),
});
