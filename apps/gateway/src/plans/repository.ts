import type { Plan } from '@jian/contracts';
import { and, desc, eq, gt, like, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { applications, corrections, plans, profiles, prototypes } from '../storage/schema.js';

export type PlanRow = typeof plans.$inferSelect;

export async function insertPlan(db: Queryable, row: Omit<typeof plans.$inferInsert, 'number'>) {
  const [top] = await db
    .select({ max: sql<number>`coalesce(max(${plans.number}), 0)` })
    .from(plans);
  const number = Number(top?.max ?? 0) + 1;

  await db.insert(plans).values({ ...row, number });

  return number;
}

export async function updatePlan(
  db: Queryable,
  id: string,
  patch: Partial<typeof plans.$inferInsert>,
) {
  await db.update(plans).set(patch).where(eq(plans.id, id));
}

export async function findPlan(db: Queryable, which: { id: string } | { number: number }) {
  const [row] = await db
    .select()
    .from(plans)
    .where('id' in which ? eq(plans.id, which.id) : eq(plans.number, which.number))
    .limit(1);

  return row ?? null;
}

export async function listPlanRows(db: Queryable, state?: string) {
  return db
    .select()
    .from(plans)
    .where(state ? eq(plans.state, state) : undefined)
    .orderBy(desc(plans.updatedAt))
    .limit(200);
}

/** The plan a version was made from, once it ran: what the generator adds to the request. */
export async function executedPlanFor(db: Queryable, prototypeId: string, version: number) {
  const [row] = await db
    .select({ revised: plans.revised, original: plans.original, number: plans.number })
    .from(plans)
    .where(
      and(
        eq(plans.prototypeId, prototypeId),
        eq(plans.prototypeVersion, version),
        eq(plans.state, 'executado'),
      ),
    )
    .orderBy(desc(plans.updatedAt))
    .limit(1);

  return row ?? null;
}

/** The prototype a plan is about, with its application, for the plan's view and its messages. */
export async function prototypeOf(db: Queryable, prototypeId: string) {
  const [row] = await db
    .select({
      id: prototypes.id,
      title: prototypes.title,
      brief: prototypes.brief,
      requestUrl: prototypes.requestUrl,
      pautaId: prototypes.pautaId,
      application: applications.slug,
      applicationName: applications.name,
    })
    .from(prototypes)
    .innerJoin(applications, eq(applications.id, prototypes.applicationId))
    .where(eq(prototypes.id, prototypeId))
    .limit(1);

  return row ?? null;
}

export async function profileNames(db: Queryable) {
  const rows = await db.select({ id: profiles.id, name: profiles.name }).from(profiles);

  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * The owner's latest corrections of an automation family (`prototipo:` covers every
 * application), whichever profile they were recorded on: what the Reviewer must not let pass.
 */
export async function recentCorrections(db: Queryable, prefix: string, limit = 10) {
  return db
    .select({
      automation: corrections.automation,
      kind: corrections.kind,
      note: corrections.note,
      createdAt: corrections.createdAt,
    })
    .from(corrections)
    .where(like(corrections.automation, `${prefix}%`))
    .orderBy(desc(corrections.createdAt))
    .limit(limit);
}

export async function countExecuted(db: Queryable, action: string, after?: Date) {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(plans)
    .where(
      and(
        eq(plans.action, action),
        eq(plans.state, 'executado'),
        after ? gt(plans.executedAt, after) : undefined,
      ),
    );

  return Number(row?.count ?? 0);
}

export type { Plan };
