import type { Correction } from '@jian/contracts';
import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import {
  applications,
  approvals,
  corrections,
  priorityProposals,
  prototypes,
  prototypeVersions,
  runs,
} from '../storage/schema.js';

type Row = typeof corrections.$inferSelect;

export function toCorrection(row: Row): Correction {
  return {
    id: row.id,
    profileId: row.profileId,
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.approvalId ? { approvalId: row.approvalId } : {}),
    automation: row.automation,
    kind: row.kind,
    ...(row.original !== null ? { original: row.original } : {}),
    ...(row.corrected !== null ? { corrected: row.corrected } : {}),
    ...(row.note ? { note: row.note } : {}),
    via: row.via,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertCorrection(db: Queryable, correction: Correction): Promise<void> {
  await db.insert(corrections).values({
    id: correction.id,
    profileId: correction.profileId,
    runId: correction.runId ?? null,
    approvalId: correction.approvalId ?? null,
    automation: correction.automation,
    kind: correction.kind,
    original: correction.original ?? null,
    corrected: correction.corrected ?? null,
    note: correction.note ?? null,
    via: correction.via,
    createdAt: new Date(correction.createdAt),
  });
}

export async function listCorrections(
  db: Queryable,
  profileId: string,
  options: { since?: Date; limit?: number } = {},
): Promise<Correction[]> {
  const rows = await db
    .select()
    .from(corrections)
    .where(
      and(
        eq(corrections.profileId, profileId),
        options.since ? gte(corrections.createdAt, options.since) : undefined,
      ),
    )
    .orderBy(desc(corrections.createdAt))
    .limit(options.limit ?? 500);

  return rows.map(toCorrection);
}

/** One round of an automation: when it happened. Corrections are matched against these. */
export type Round = { automation: string; action?: string; at: Date };

/**
 * Every round the owner could have corrected: each run a schedule started, and each decided
 * request for an action that was not part of a scheduled run — that one is counted with its
 * schedule instead, so a scheduled routine is one automation however many actions it takes.
 */
export async function listRounds(db: Queryable, profileId: string): Promise<Round[]> {
  const scheduled = await db
    .select({ origin: runs.origin, at: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), isNotNull(runs.origin)))
    .orderBy(desc(runs.createdAt))
    .limit(5000);

  const decided = await db
    .select({ action: approvals.action, at: approvals.createdAt })
    .from(approvals)
    .leftJoin(runs, eq(runs.id, approvals.runId))
    .where(
      and(
        eq(approvals.profileId, profileId),
        inArray(approvals.status, ['approved', 'rejected', 'used']),
        sql`${runs.origin} IS NULL`,
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(5000);

  // Each screen a prototype generation delivered is one round of `prototipo:<app>`.
  const drawn = await db
    .select({ slug: applications.slug, at: prototypeVersions.createdAt })
    .from(prototypeVersions)
    .innerJoin(prototypes, eq(prototypes.id, prototypeVersions.prototypeId))
    .innerJoin(applications, eq(applications.id, prototypes.applicationId))
    .where(and(eq(prototypes.profileId, profileId), eq(prototypeVersions.status, 'ready')))
    .orderBy(desc(prototypeVersions.createdAt))
    .limit(5000);

  // Each order the owner applied or discarded is one round of the prioritization.
  const ordered = await db
    .select({ at: priorityProposals.decidedAt })
    .from(priorityProposals)
    .where(
      and(
        eq(priorityProposals.profileId, profileId),
        inArray(priorityProposals.state, ['aplicada', 'descartada']),
        isNotNull(priorityProposals.decidedAt),
      ),
    )
    .orderBy(desc(priorityProposals.decidedAt))
    .limit(5000);

  return [
    ...ordered.map((row) => ({ automation: 'priorizacao', at: row.at as Date })),
    ...drawn.map((row) => ({ automation: `prototipo:${row.slug}`, at: row.at })),
    ...scheduled.map((row) => ({ automation: String(row.origin), at: row.at })),
    ...decided.map((row) => ({ automation: row.action, action: row.action, at: row.at })),
  ];
}

/** The origin of a run, read when a correction is written so it names the right automation. */
export async function runOrigin(db: Queryable, runId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ origin: runs.origin })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);

  return row?.origin ?? undefined;
}

/** The last answer of a conversation the owner can be correcting. */
export async function lastAnswered(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<{ id: string; origin: string | null; output: string | null } | undefined> {
  const [row] = await db
    .select({ id: runs.id, origin: runs.origin, output: runs.output })
    .from(runs)
    .where(
      and(
        eq(runs.profileId, profileId),
        eq(runs.sessionId, sessionId),
        eq(runs.status, 'completed'),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);

  return row;
}
