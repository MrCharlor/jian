import type { ActivityDay, Checkpoint, Profile, Run, RunProgress } from '@jian/contracts';
import { profileRecordSchema } from '@jian/contracts';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { checkpoints, profileRevisions, runs } from '../storage/schema.js';

type RunRow = typeof runs.$inferSelect;
type CheckpointRow = typeof checkpoints.$inferSelect;

/** Queued and running hold the session and count against the profile's cap; nothing else does. */
const activeStatuses: Run['status'][] = ['queued', 'running'];

/** Terminal task workers still waiting for an atomic handoff to their principal. */
export async function listUnreportedTaskWorkers(db: Queryable, limit: number) {
  return db
    .select({ id: runs.id, profileId: runs.profileId })
    .from(runs)
    .where(
      and(
        isNotNull(runs.subagent),
        isNull(runs.subagentReportedAt),
        inArray(runs.status, ['completed', 'failed', 'interrupted']),
      ),
    )
    .orderBy(asc(runs.updatedAt))
    .limit(limit);
}

/**
 * A run keeps the profile version it froze, and the document itself lives once in the revision
 * it came from. Reading puts the two back together, so `Run.profile` still carries the profile
 * exactly as the run saw it and no consumer learns that it is now a reference.
 */
function toRun(row: RunRow, document: Profile): Run {
  return {
    id: row.id,
    profileId: row.profileId,
    sessionId: row.sessionId,
    ...(row.workItemId ? { workItemId: row.workItemId } : {}),
    ...(row.subagent ? { subagent: row.subagent } : {}),
    requestKey: row.requestKey,
    input: row.input,
    status: row.status,
    profile: profileRecordSchema.parse(document),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.usage ? { usage: row.usage } : {}),
    ...(row.continuationOf ? { continuationOf: row.continuationOf } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.modelSelection ? { modelSelection: row.modelSelection } : {}),
    ...(row.contextPolicy ? { contextPolicy: row.contextPolicy } : {}),
    ...(row.call ? { call: row.call } : {}),
    ...(row.group ? { group: row.group } : {}),
    ...(row.progress ? { progress: row.progress } : {}),
    ...(row.commentary?.length ? { commentary: row.commentary } : {}),
    ...(row.relayTo ? { relayTo: row.relayTo } : {}),
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Writing stores the version and never the document: the revision already holds it. */
function toRow(run: Run): typeof runs.$inferInsert {
  return {
    id: run.id,
    profileId: run.profileId,
    sessionId: run.sessionId,
    workItemId: run.workItemId ?? null,
    subagent: run.subagent ?? null,
    profileVersion: run.profile.version,
    requestKey: run.requestKey,
    input: run.input,
    status: run.status,
    output: run.output ?? null,
    error: run.error ?? null,
    usage: run.usage ?? null,
    continuationOf: run.continuationOf ?? null,
    model: run.model ?? null,
    modelSelection: run.modelSelection ?? null,
    contextPolicy: run.contextPolicy ?? null,
    call: run.call ?? null,
    group: run.group ?? null,
    progress: run.progress ?? null,
    commentary: run.commentary ?? null,
    relayTo: run.relayTo ?? null,
    leaseOwner: run.leaseOwner ?? null,
    leaseUntil: run.leaseUntil ?? null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

/** The join that hydrates `profile`. Every read that returns a `Run` starts here. */
function hydrated(db: Queryable) {
  return db
    .select({ run: runs, document: profileRevisions.document })
    .from(runs)
    .innerJoin(
      profileRevisions,
      and(
        eq(profileRevisions.profileId, runs.profileId),
        eq(profileRevisions.version, runs.profileVersion),
      ),
    );
}

export async function findRun(
  db: Queryable,
  profileId: string,
  runId: string,
): Promise<Run | null> {
  const [row] = await hydrated(db)
    .where(and(eq(runs.id, runId), eq(runs.profileId, profileId)))
    .limit(1);

  return row ? toRun(row.run, row.document) : null;
}

/** The first run stored under a request key, which the unique index guarantees is the only one. */
export async function findRunByRequestKey(
  db: Queryable,
  profileId: string,
  sessionId: string,
  requestKey: string,
): Promise<Run | null> {
  const [row] = await hydrated(db)
    .where(
      and(
        eq(runs.profileId, profileId),
        eq(runs.sessionId, sessionId),
        eq(runs.requestKey, requestKey),
      ),
    )
    .limit(1);

  return row ? toRun(row.run, row.document) : null;
}

/**
 * Stores the run unless its request key is already taken, in which case the run that took it
 * comes back. The read before this one is the happy path; this is the same answer under a race
 * the profile lock did not cover, and it leaves the caller's transaction usable.
 */
export async function insertRun(db: Queryable, run: Run): Promise<Run | null> {
  const inserted = await db
    .insert(runs)
    .values(toRow(run))
    .onConflictDoNothing({ target: [runs.profileId, runs.sessionId, runs.requestKey] })
    .returning({ id: runs.id });

  if (inserted.length > 0) {
    return null;
  }

  return findRunByRequestKey(db, run.profileId, run.sessionId, run.requestKey);
}

export async function updateRun(db: Queryable, run: Run): Promise<void> {
  await db.update(runs).set(toRow(run)).where(eq(runs.id, run.id));
}

/**
 * Appends what the person said while the run was already going. Read and write both happen
 * under the profile lock the caller holds, so two messages arriving together keep both.
 */
export async function appendSteer(
  db: Queryable,
  runId: string,
  text: string,
): Promise<string | null> {
  const [current] = await db
    .select({ steer: runs.steer })
    .from(runs)
    .where(and(eq(runs.id, runId), inArray(runs.status, activeStatuses)))
    .limit(1);

  if (!current) {
    return null;
  }

  const steer = current.steer ? `${current.steer}\n\n${text}` : text;

  await db.update(runs).set({ steer }).where(eq(runs.id, runId));

  return steer;
}

/** Takes what is waiting and leaves the slot empty, so a step reads each message once. */
export async function takeSteer(
  db: Queryable,
  runId: string,
  owner: string,
): Promise<string | null> {
  const [current] = await db
    .select({ steer: runs.steer })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner), isNotNull(runs.steer)))
    .limit(1);

  if (!current?.steer) {
    return null;
  }

  // Cleared only if it still holds exactly what was read. A message that landed in between
  // fails this and stays for the next step, which is the side to err on.
  await db
    .update(runs)
    .set({ steer: null })
    .where(and(eq(runs.id, runId), eq(runs.steer, current.steer)));

  return current.steer;
}

/**
 * Appends one thing the agent said on its way to a tool. Read and write under the caller's
 * profile lock, with the lease as the ownership check, so a worker that lost the run cannot
 * put words in the mouth of the one that took it over.
 */
export async function appendCommentary(
  db: Queryable,
  runId: string,
  owner: string,
  text: string,
): Promise<void> {
  const [current] = await db
    .select({ commentary: runs.commentary })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner), eq(runs.status, 'running')))
    .limit(1);

  if (!current) {
    return;
  }

  await db
    .update(runs)
    .set({ commentary: [...(current.commentary ?? []), text].slice(-20) })
    .where(eq(runs.id, runId));
}

/**
 * One column, no read and no lock: progress is overwritten several times a second and owns
 * nothing else on the row. The lease predicate is the ownership check — a worker that lost the
 * run updates zero rows instead of overwriting the state of the one that took it over.
 */
export async function writeProgress(
  db: Queryable,
  runId: string,
  owner: string,
  progress: RunProgress | null,
): Promise<void> {
  await db
    .update(runs)
    .set({ progress })
    .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner), eq(runs.status, 'running')));
}

/** A session admits one run at a time, and `runs_activity` answers without reading the rest. */
export async function findActiveSessionRun(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<Run | null> {
  const [row] = await hydrated(db)
    .where(
      and(
        eq(runs.profileId, profileId),
        eq(runs.sessionId, sessionId),
        inArray(runs.status, activeStatuses),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);

  return row ? toRun(row.run, row.document) : null;
}

/** What the profile owes work on right now; the cap is a count, not a page of rows. */
export async function countActiveRuns(db: Queryable, profileId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, activeStatuses)));

  return row?.total ?? 0;
}

export async function listActiveRuns(
  db: Queryable,
  profileId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await hydrated(db)
    .where(and(eq(runs.profileId, profileId), inArray(runs.status, activeStatuses)))
    .orderBy(asc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => toRun(row.run, row.document));
}

/**
 * The last runs of a profile, whatever became of them. `listActiveRuns` answers what is in
 * flight; this answers what has been done, which is what a reader of the panel is looking at.
 */
export async function listRecentRuns(
  db: Queryable,
  profileId: string,
  limit: number,
): Promise<Run[]> {
  const rows = await hydrated(db)
    .where(eq(runs.profileId, profileId))
    .orderBy(desc(runs.createdAt))
    .limit(limit);

  return rows.map((row) => toRun(row.run, row.document));
}

/**
 * One row per day this profile ran anything, for the last `days` days. Counted in SQL because
 * a year of runs is far more than any page the panel would otherwise have to read.
 */
export async function countRunsByDay(
  db: Queryable,
  profileId: string,
  days: number,
  zone = 'UTC',
): Promise<ActivityDay[]> {
  const rows = await db
    .select({
      day: sql<string>`to_char(${runs.createdAt} at time zone ${zone}, 'YYYY-MM-DD')`.as('day'),
      total: count(),
      // A run that never reached the model carries no usage at all, so the sum is coalesced
      // rather than left null, and comes back as text from the driver.
      tokens: sql<string>`coalesce(sum(
        coalesce((${runs.usage} ->> 'inputTokens')::bigint, 0)
        + coalesce((${runs.usage} ->> 'outputTokens')::bigint, 0)
      ), 0)`.as('tokens'),
    })
    .from(runs)
    .where(
      and(
        eq(runs.profileId, profileId),
        gte(runs.createdAt, sql`now() - make_interval(days => ${days})`),
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  return rows.map((row) => ({ day: row.day, runs: row.total, tokens: Number(row.tokens) }));
}

/** Addresses a late answer to the conversation that asked, or clears that address. */
export async function setRelayTo(
  db: Queryable,
  runId: string,
  sessionId: string | null,
): Promise<void> {
  await db.update(runs).set({ relayTo: sessionId }).where(eq(runs.id, runId));
}

/** Dispatch and recovery need the address of a run, not the run: no revision is joined. */
export type RunAddress = { id: string; profileId: string };

export async function listQueuedRuns(db: Queryable, limit: number): Promise<RunAddress[]> {
  return db
    .select({ id: runs.id, profileId: runs.profileId })
    .from(runs)
    .where(eq(runs.status, 'queued'))
    .orderBy(asc(runs.createdAt))
    .limit(limit);
}

/**
 * Running rows whose lease has already run out, across every profile — the partial index
 * `runs_running` is why this stays a lookup rather than a sweep of the table. A running row
 * without a lease at all is owned by nobody, so it is expired too.
 */
export async function listExpiredRuns(
  db: Queryable,
  now: number,
  limit: number,
): Promise<RunAddress[]> {
  return db
    .select({ id: runs.id, profileId: runs.profileId })
    .from(runs)
    .where(and(eq(runs.status, 'running'), or(isNull(runs.leaseUntil), lte(runs.leaseUntil, now))))
    .orderBy(asc(runs.createdAt))
    .limit(limit);
}

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    profileId: row.profileId,
    runId: row.runId,
    data: row.data,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertCheckpoint(db: Queryable, checkpoint: Checkpoint): Promise<void> {
  await db.insert(checkpoints).values({
    id: checkpoint.id,
    profileId: checkpoint.profileId,
    runId: checkpoint.runId,
    data: checkpoint.data,
    createdAt: new Date(checkpoint.createdAt),
  });
}

export async function listCheckpoints(
  db: Queryable,
  profileId: string,
  runId: string,
  limit: number,
): Promise<Checkpoint[]> {
  const rows = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.profileId, profileId), eq(checkpoints.runId, runId)))
    .orderBy(desc(checkpoints.createdAt))
    .limit(limit);

  return rows.map(toCheckpoint);
}

/** Tool evidence for turns still present in a session's uncompact history. */
export async function listContextToolCheckpoints(
  db: Queryable,
  profileId: string,
  runIds: string[],
): Promise<Array<{ runId: string; createdAt: Date; data: unknown }>> {
  if (!runIds.length) return [];
  return db
    .select({ runId: checkpoints.runId, createdAt: checkpoints.createdAt, data: checkpoints.data })
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.profileId, profileId),
        inArray(checkpoints.runId, runIds),
        inArray(sql<string>`${checkpoints.data}->>'phase'`, [
          'tool-started',
          'step-completed',
          'tool-failed',
          'tool-refused',
          'tool-uncertain',
          'context-compacted',
        ]),
      ),
    )
    .orderBy(asc(checkpoints.createdAt), asc(checkpoints.id));
}
