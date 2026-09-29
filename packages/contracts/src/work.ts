import { z } from 'zod';

export const workStatusSchema = z.enum(['todo', 'in_progress', 'review', 'blocked', 'done']);

export const subagentRoleSchema = z.enum(['execute', 'review']);

export const spawnSubagentSchema = z.strictObject({
  taskId: z.uuid(),
  role: subagentRoleSchema,
  name: z.string().trim().min(1).max(80),
  identity: z.string().trim().min(1).max(4000),
  brief: z.string().trim().min(1).max(3000),
});

export const subagentSchema = spawnSubagentSchema
  .pick({ role: true, name: true, identity: true })
  .extend({
    parentRunId: z.uuid(),
    spawnKey: z.string().min(1).max(120),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  });
export type Subagent = z.infer<typeof subagentSchema>;

export const workExecutionSchema = z.array(
  z.strictObject({
    runId: z.uuid(),
    sessionId: z.uuid(),
    role: subagentRoleSchema,
    name: z.string(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']),
    input: z.string(),
    output: z.string().optional(),
    error: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  }),
);

export const workInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(4000),
  mediaIds: z.array(z.uuid()).max(4).optional(),
});

export const workPatchSchema = z
  .strictObject({
    status: workStatusSchema.optional(),
    note: z.string().trim().max(2000).optional(),
    expectedVersion: z.number().int().positive(),
  })
  .refine((patch) => patch.status !== undefined || patch.note !== undefined, {
    message: 'Change the status or note',
  });

export const workItemSchema = workInputSchema.extend({
  mediaIds: z.array(z.uuid()),
  id: z.uuid(),
  profileId: z.uuid(),
  sourceSessionId: z.uuid().nullable(),
  status: workStatusSchema,
  note: z.string(),
  version: z.number().int().positive(),
  updatedBy: z.enum(['agent', 'owner']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type WorkItem = z.infer<typeof workItemSchema>;

export const workHistorySchema = z.array(
  z.strictObject({
    id: z.number().int().positive(),
    type: z.enum(['work.created', 'work.updated']),
    status: workStatusSchema,
    note: z.string(),
    createdAt: z.iso.datetime(),
  }),
);
