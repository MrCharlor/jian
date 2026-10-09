import type { Approval, ApprovalStatus } from '@jian/contracts';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { approvals } from '../storage/schema.js';

type Row = typeof approvals.$inferSelect;

export function toApproval(row: Row): Approval {
  return {
    id: row.id,
    profileId: row.profileId,
    runId: row.runId,
    sessionId: row.sessionId,
    number: row.number,
    tool: row.tool,
    action: row.action,
    input: row.input,
    summary: row.summary,
    status: row.status,
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.decidedVia ? { decidedVia: row.decidedVia } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function insertApproval(
  db: Queryable,
  approval: Approval & { inputHash: string },
): Promise<void> {
  await db.insert(approvals).values({
    id: approval.id,
    profileId: approval.profileId,
    runId: approval.runId,
    sessionId: approval.sessionId,
    number: approval.number,
    tool: approval.tool,
    action: approval.action,
    input: approval.input ?? null,
    inputHash: approval.inputHash,
    summary: approval.summary,
    status: approval.status,
    decidedAt: approval.decidedAt ? new Date(approval.decidedAt) : null,
    decidedVia: approval.decidedVia ?? null,
    reason: approval.reason ?? null,
    createdAt: new Date(approval.createdAt),
    expiresAt: new Date(approval.expiresAt),
  });
}

/** The next short number of a profile. Read under the profile's transaction, so it never repeats. */
export async function nextApprovalNumber(db: Queryable, profileId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${approvals.number}), 0)` })
    .from(approvals)
    .where(eq(approvals.profileId, profileId));

  return Number(row?.max ?? 0) + 1;
}

export async function listApprovals(
  db: Queryable,
  profileId: string,
  limit = 200,
): Promise<Approval[]> {
  const rows = await db
    .select()
    .from(approvals)
    .where(eq(approvals.profileId, profileId))
    .orderBy(desc(approvals.createdAt))
    .limit(limit);

  return rows.map(toApproval);
}

export async function findApproval(
  db: Queryable,
  profileId: string,
  id: string,
): Promise<Approval | null> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.profileId, profileId), eq(approvals.id, id)))
    .limit(1);

  return row ? toApproval(row) : null;
}

export async function findApprovalByNumber(
  db: Queryable,
  profileId: string,
  number: number,
): Promise<Approval | null> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.profileId, profileId), eq(approvals.number, number)))
    .limit(1);

  return row ? toApproval(row) : null;
}

/**
 * A pending request for the same call in the same conversation: the agent asked once already,
 * and asking again would hand the owner two numbers for one action.
 */
export async function findPendingCall(
  db: Queryable,
  profileId: string,
  sessionId: string,
  tool: string,
  inputHash: string,
): Promise<Approval | null> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.profileId, profileId),
        eq(approvals.sessionId, sessionId),
        eq(approvals.tool, tool),
        eq(approvals.inputHash, inputHash),
        eq(approvals.status, 'pending'),
      ),
    )
    .limit(1);

  return row ? toApproval(row) : null;
}

/** An approval the owner granted for exactly this call, not yet spent. */
export async function findApprovedCall(
  db: Queryable,
  profileId: string,
  sessionId: string,
  tool: string,
  inputHash: string,
): Promise<Approval | null> {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.profileId, profileId),
        eq(approvals.sessionId, sessionId),
        eq(approvals.tool, tool),
        eq(approvals.inputHash, inputHash),
        eq(approvals.status, 'approved'),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(1);

  return row ? toApproval(row) : null;
}

export async function setApprovalStatus(
  db: Queryable,
  id: string,
  status: ApprovalStatus,
  decision?: { at: Date; via: 'panel' | 'channel' | 'api'; reason?: string },
): Promise<void> {
  await db
    .update(approvals)
    .set({
      status,
      ...(decision
        ? { decidedAt: decision.at, decidedVia: decision.via, reason: decision.reason ?? null }
        : {}),
    })
    .where(eq(approvals.id, id));
}

export async function countPending(db: Queryable, profileId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(and(eq(approvals.profileId, profileId), eq(approvals.status, 'pending')));

  return Number(row?.count ?? 0);
}

/** Requests nobody answered in time stop waiting; an old "ok" must not run something stale. */
export async function expireApprovals(db: Queryable, profileId: string, now: Date): Promise<void> {
  await db
    .update(approvals)
    .set({ status: 'expired' })
    .where(
      and(
        eq(approvals.profileId, profileId),
        inArray(approvals.status, ['pending', 'approved']),
        lt(approvals.expiresAt, now),
      ),
    );
}
