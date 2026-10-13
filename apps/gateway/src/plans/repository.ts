import type { Plan } from '@jian/contracts';
import { and, desc, eq, gt, inArray, isNotNull, like, ne, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import {
  applications,
  corrections,
  plans,
  priorityCriteria,
  priorityProposals,
  profiles,
  prototypes,
} from '../storage/schema.js';

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
      corrected: corrections.corrected,
      createdAt: corrections.createdAt,
    })
    .from(corrections)
    .where(like(corrections.automation, `${prefix}%`))
    .orderBy(desc(corrections.createdAt))
    .limit(limit);
}

/** The proposed order a prioritization plan is about. */
export async function proposalOf(db: Queryable, proposalId: string) {
  const [row] = await db
    .select()
    .from(priorityProposals)
    .where(eq(priorityProposals.id, proposalId))
    .limit(1);

  return row ?? null;
}

/**
 * What the Reviewer weighs a proposed order against: the owner's criteria and the latest
 * proposals the owner decided, with what was applied and why one was discarded.
 */
export async function priorityHistory(db: Queryable, exceptId: string, limit = 4) {
  const [criteria] = await db.select().from(priorityCriteria).limit(1);
  const past = await db
    .select()
    .from(priorityProposals)
    .where(and(ne(priorityProposals.id, exceptId), ne(priorityProposals.state, 'proposta')))
    .orderBy(desc(priorityProposals.createdAt))
    .limit(limit);

  return { criteria: criteria?.text ?? '', past };
}

/** The plans open on these proposals, and the number of the latest one of each. */
export async function plansOfProposals(db: Queryable, proposalIds: string[]) {
  if (!proposalIds.length) return new Map<string, PlanRow>();

  const rows = await db
    .select()
    .from(plans)
    .where(inArray(plans.priorityProposalId, proposalIds))
    .orderBy(desc(plans.createdAt));
  const found = new Map<string, PlanRow>();

  for (const row of rows) {
    if (row.priorityProposalId && !found.has(row.priorityProposalId)) {
      found.set(row.priorityProposalId, row);
    }
  }

  return found;
}

/** Prioritization plans still open: a new proposal ends or takes over them. */
export async function openPriorityPlans(db: Queryable) {
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.action, 'priority'),
        inArray(plans.state, ['escrevendo', 'em_revisao', 'devolvido', 'aguardando_po']),
      ),
    )
    .orderBy(desc(plans.createdAt));
}

/** Entry sync plans still open: a new read of the boards keeps, takes over or ends them. */
export async function openEntryPlans(db: Queryable) {
  return db
    .select()
    .from(plans)
    .where(
      and(
        eq(plans.action, 'entry_sync'),
        inArray(plans.state, ['escrevendo', 'em_revisao', 'devolvido', 'aguardando_po']),
      ),
    )
    .orderBy(desc(plans.createdAt));
}

/**
 * Entry sync plans decided since then, by the owner or the automatic switch: what the owner
 * already saw, and the moves the owner refused.
 */
export async function decidedEntryPlans(db: Queryable, since: Date) {
  return db
    .select()
    .from(plans)
    .where(and(eq(plans.action, 'entry_sync'), gt(plans.decidedAt, since)))
    .orderBy(desc(plans.decidedAt));
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

/** Plans whose author counted its questions (B19), opened since a moment: the weekly metric. */
export async function questionedPlans(db: Queryable, since: Date) {
  return db
    .select({ createdAt: plans.createdAt, questions: plans.questions })
    .from(plans)
    .where(and(isNotNull(plans.questions), gt(plans.createdAt, since)));
}
