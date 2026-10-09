import type { Prototype, PrototypeVersion } from '@jian/contracts';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { applications, prototypePrints, prototypes, prototypeVersions } from '../storage/schema.js';

type VersionRow = typeof prototypeVersions.$inferSelect;

export function toVersion(row: VersionRow): PrototypeVersion {
  return {
    number: row.number,
    status: row.status as PrototypeVersion['status'],
    ...(row.comments ? { comments: row.comments } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
  };
}

export async function insertPrototype(db: Queryable, row: typeof prototypes.$inferInsert) {
  await db.insert(prototypes).values(row);
}

export async function insertPrint(db: Queryable, row: typeof prototypePrints.$inferInsert) {
  await db.insert(prototypePrints).values(row);
}

export async function insertVersion(db: Queryable, row: typeof prototypeVersions.$inferInsert) {
  await db.insert(prototypeVersions).values(row);
}

export async function updatePrototype(
  db: Queryable,
  id: string,
  patch: Partial<typeof prototypes.$inferInsert>,
) {
  await db.update(prototypes).set(patch).where(eq(prototypes.id, id));
}

export async function updateVersion(
  db: Queryable,
  id: string,
  number: number,
  patch: Partial<typeof prototypeVersions.$inferInsert>,
) {
  await db
    .update(prototypeVersions)
    .set(patch)
    .where(and(eq(prototypeVersions.prototypeId, id), eq(prototypeVersions.number, number)));
}

export async function findPrototypeRow(db: Queryable, id: string) {
  const [row] = await db
    .select({ prototype: prototypes, slug: applications.slug })
    .from(prototypes)
    .innerJoin(applications, eq(applications.id, prototypes.applicationId))
    .where(eq(prototypes.id, id))
    .limit(1);

  return row ?? null;
}

export async function listVersions(db: Queryable, id: string) {
  return db
    .select()
    .from(prototypeVersions)
    .where(eq(prototypeVersions.prototypeId, id))
    .orderBy(asc(prototypeVersions.number));
}

export async function listPrints(db: Queryable, id: string) {
  return db
    .select()
    .from(prototypePrints)
    .where(eq(prototypePrints.prototypeId, id))
    .orderBy(asc(prototypePrints.name));
}

export async function listPrototypeRows(db: Queryable, applicationId?: string) {
  return db
    .select({ prototype: prototypes, slug: applications.slug })
    .from(prototypes)
    .innerJoin(applications, eq(applications.id, prototypes.applicationId))
    .where(applicationId ? eq(prototypes.applicationId, applicationId) : undefined)
    .orderBy(desc(prototypes.updatedAt))
    .limit(200);
}

export async function versionHtml(db: Queryable, id: string, number: number) {
  const [row] = await db
    .select({ html: prototypeVersions.html })
    .from(prototypeVersions)
    .where(and(eq(prototypeVersions.prototypeId, id), eq(prototypeVersions.number, number)))
    .limit(1);

  return row?.html ?? null;
}

/**
 * Takes the oldest waiting version and marks it as being generated, in one statement, so two
 * workers never take the same one.
 */
export async function claimNext(
  db: Queryable,
  now: Date,
): Promise<{ prototypeId: string; number: number } | null> {
  const result = await db.execute(sql`
    update ${prototypeVersions} set status = 'generating', started_at = ${now}
    where (prototype_id, number) = (
      select prototype_id, number from ${prototypeVersions}
      where status = 'queued' order by created_at limit 1 for update skip locked
    )
    returning prototype_id, number`);
  const rows =
    (result as unknown as { rows?: Array<{ prototype_id: string; number: number }> }).rows ??
    (result as unknown as Array<{ prototype_id: string; number: number }>);
  const row = Array.isArray(rows) ? rows[0] : undefined;

  return row ? { prototypeId: row.prototype_id, number: Number(row.number) } : null;
}

/** A version left half-made by a process that stopped: it failed, and says so. */
export async function failAbandoned(db: Queryable, now: Date) {
  await db
    .update(prototypeVersions)
    .set({
      status: 'failed',
      error: 'Interrupted: the gateway restarted during the generation.',
      finishedAt: now,
    })
    .where(eq(prototypeVersions.status, 'generating'));
}

export type { Prototype };
