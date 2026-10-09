import { randomUUID } from 'node:crypto';
import {
  type BoardCard,
  type Decision,
  decisionChoiceSchema,
  decisionInputSchema,
  type Pauta,
  pautaInputSchema,
  pautaPatchSchema,
} from '@jian/contracts';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  applications,
  decisions,
  events,
  pautas,
  profiles,
  prototypes,
  workItems,
} from '../storage/schema.js';

type PautaRow = typeof pautas.$inferSelect;
type DecisionRow = typeof decisions.$inferSelect;
type Via = 'panel' | 'channel' | 'api';

function toDecision(row: DecisionRow): Decision {
  return {
    id: row.id,
    number: row.number,
    pautaId: row.pautaId,
    question: row.question,
    options: row.options,
    counterpoint: row.counterpoint,
    recommendation: row.recommendation,
    state: row.state as Decision['state'],
    ...(row.choice ? { choice: row.choice } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.decidedVia ? { decidedVia: row.decidedVia as Via } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    ...(row.replaces ? { replaces: row.replaces } : {}),
    ...(row.proposedBy ? { proposedBy: row.proposedBy } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The owner's topics and what was decided about them. Agents create and update topics freely —
 * it is the owner's notebook, kept for them — and propose decisions; only the owner decides.
 */
export class Pautas {
  private remember?: (profileId: string, key: string, content: string) => Promise<unknown>;
  private notify?: (
    profileId: string,
    sessionId: string,
    text: string,
    key: string,
  ) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  /** Wired after construction: memories and runs are built alongside this service. */
  useAgents(hooks: {
    remember: NonNullable<Pautas['remember']>;
    notify: NonNullable<Pautas['notify']>;
  }) {
    this.remember = hooks.remember;
    this.notify = hooks.notify;
  }

  private async present(row: PautaRow, db: Queryable = this.store.db): Promise<Pauta> {
    const [app] = row.applicationId
      ? await db
          .select({ slug: applications.slug })
          .from(applications)
          .where(eq(applications.id, row.applicationId))
      : [];
    const decided = await db
      .select()
      .from(decisions)
      .where(eq(decisions.pautaId, row.id))
      .orderBy(asc(decisions.number));
    const drawn = await db
      .select({
        id: prototypes.id,
        title: prototypes.title,
        approvedVersion: prototypes.approvedVersion,
      })
      .from(prototypes)
      .where(eq(prototypes.pautaId, row.id))
      .orderBy(desc(prototypes.updatedAt));

    return {
      id: row.id,
      title: row.title,
      ...(app ? { application: app.slug } : {}),
      state: row.state as Pauta['state'],
      priority: row.priority as Pauta['priority'],
      context: row.context,
      screens: row.screens,
      links: row.links,
      nextSteps: row.nextSteps,
      waitingOn: row.waitingOn,
      decisions: decided.map(toDecision),
      prototypes: drawn.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.approvedVersion ? { approvedVersion: item.approvedVersion } : {}),
      })),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async applicationId(slug: string | undefined, db: Queryable) {
    if (!slug) return null;

    const [app] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(eq(applications.slug, slug));

    return assertFound(app, 'Application').id;
  }

  async list(): Promise<Pauta[]> {
    const rows = await this.store.db
      .select()
      .from(pautas)
      .orderBy(desc(pautas.updatedAt))
      .limit(300);

    return Promise.all(rows.map((row) => this.present(row)));
  }

  async get(id: string): Promise<Pauta> {
    const [row] = await this.store.db.select().from(pautas).where(eq(pautas.id, id));

    return this.present(assertFound(row, 'Pauta'));
  }

  async create(input: unknown): Promise<Pauta> {
    const data = pautaInputSchema.parse(input);
    const now = new Date(this.clock());
    const id = randomUUID();

    await this.store.db.insert(pautas).values({
      id,
      title: data.title,
      applicationId: await this.applicationId(data.application, this.store.db),
      state: data.state,
      priority: data.priority,
      context: data.context,
      screens: data.screens,
      links: data.links,
      nextSteps: data.nextSteps,
      waitingOn: data.waitingOn,
      createdAt: now,
      updatedAt: now,
    });

    return this.get(id);
  }

  /**
   * Changes a topic. A link read again keeps the column it had as `previousColumn` when the
   * column moved, so the owner sees what changed since the last reading.
   */
  async update(id: string, input: unknown): Promise<Pauta> {
    const data = pautaPatchSchema.parse(input);
    const current = await this.get(id);
    const now = new Date(this.clock());
    const links = data.links?.map((link) => {
      const before = current.links.find(
        (item) => item.kind === link.kind && item.workId === link.workId,
      );
      const moved = before?.column && link.column && before.column !== link.column;

      return {
        ...before,
        ...link,
        ...(moved ? { previousColumn: before.column } : {}),
        ...(link.column ? { readAt: now.toISOString() } : {}),
      };
    });

    await this.store.db
      .update(pautas)
      .set({
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.application !== undefined
          ? { applicationId: await this.applicationId(data.application, this.store.db) }
          : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.priority !== undefined ? { priority: data.priority } : {}),
        ...(data.context !== undefined ? { context: data.context } : {}),
        ...(data.screens !== undefined ? { screens: data.screens } : {}),
        ...(links !== undefined ? { links } : {}),
        ...(data.nextSteps !== undefined ? { nextSteps: data.nextSteps } : {}),
        ...(data.waitingOn !== undefined ? { waitingOn: data.waitingOn } : {}),
        updatedAt: now,
      })
      .where(eq(pautas.id, id));

    return this.get(id);
  }

  /** An agent's proposal, numbered for the owner to answer to; it decides nothing. */
  async propose(
    pautaId: string,
    input: unknown,
    by?: { profileId: string; sessionId: string; name: string },
  ): Promise<Decision> {
    const data = decisionInputSchema.parse(input);

    await this.get(pautaId);

    return this.store.transaction('decisions', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${decisions.number}), 0)` })
        .from(decisions);
      const id = randomUUID();

      await tx.insert(decisions).values({
        id,
        number: Number(top?.max ?? 0) + 1,
        pautaId,
        question: data.question,
        options: data.options,
        counterpoint: data.counterpoint,
        recommendation: data.recommendation,
        state: 'proposta',
        replaces: data.replaces ?? null,
        proposedBy: by?.name ?? null,
        profileId: by?.profileId ?? null,
        sessionId: by?.sessionId ?? null,
        createdAt: new Date(this.clock()),
      });

      const [row] = await tx.select().from(decisions).where(eq(decisions.id, id));

      return toDecision(assertFound(row, 'Decision'));
    });
  }

  /**
   * The owner's choice. A decided one never changes: changing one's mind is a new decision that
   * replaces it. The choice becomes a memory of the agent that proposed it, and it is told.
   */
  async decide(
    which: { id: string } | { number: number },
    input: unknown,
    via: Via,
  ): Promise<Decision> {
    const { choice, reason } = decisionChoiceSchema.parse(input);
    const [row] = await this.store.db
      .select()
      .from(decisions)
      .where('id' in which ? eq(decisions.id, which.id) : eq(decisions.number, which.number));
    const current = assertFound(row, 'Decision');

    if (current.state !== 'proposta') {
      throw new GatewayError(409, `Decision #${current.number} is already ${current.state}`);
    }

    const now = new Date(this.clock());

    await this.store.db
      .update(decisions)
      .set({ state: 'decidida', choice, reason: reason ?? null, decidedVia: via, decidedAt: now })
      .where(eq(decisions.id, current.id));

    if (current.replaces) {
      await this.store.db
        .update(decisions)
        .set({ state: 'descartada' })
        .where(and(eq(decisions.number, current.replaces), eq(decisions.state, 'decidida')));
    }

    await this.store.db
      .update(pautas)
      .set({ updatedAt: now })
      .where(eq(pautas.id, current.pautaId));

    const pauta = await this.get(current.pautaId);
    const decided = assertFound(
      pauta.decisions.find((item) => item.id === current.id),
      'Decision',
    );
    const memory = `Pauta "${pauta.title}": ${current.question} Decisão do Moabe (${now.toISOString().slice(0, 10)}): ${choice}.${reason ? ` Motivo: ${reason}.` : ''}`;

    if (current.profileId) {
      await this.remember?.(current.profileId, `decisao-${current.number}`, memory).catch(() => {});

      if (current.sessionId && via !== 'channel') {
        await this.notify?.(
          current.profileId,
          current.sessionId,
          `[Decisão #${current.number} tomada pelo Moabe] ${choice}${reason ? `. Motivo: ${reason}` : ''}. Siga a partir dela.`,
          `decision:${current.id}`,
        ).catch(() => {});
      }
    }

    return decided;
  }

  async discard(id: string): Promise<Decision> {
    const [row] = await this.store.db.select().from(decisions).where(eq(decisions.id, id));
    const current = assertFound(row, 'Decision');

    if (current.state !== 'proposta') {
      throw new GatewayError(409, `Decision #${current.number} is already ${current.state}`);
    }

    await this.store.db.update(decisions).set({ state: 'descartada' }).where(eq(decisions.id, id));

    return toDecision({ ...current, state: 'descartada' });
  }

  /** What an agent reads when the owner answered in a chat. */
  static notice(decision: Decision) {
    return `[Decisão #${decision.number} tomada pelo Moabe] ${decision.choice}${decision.reason ? `. Motivo: ${decision.reason}` : ''}. Siga a partir dela.`;
  }

  /**
   * Every agent's tasks on one board: which agent, which topic, how long in the column it is in,
   * and, once done, how long it took — read from the moves each task recorded.
   */
  async board(): Promise<BoardCard[]> {
    const rows = await this.store.db
      .select({ item: workItems, agent: profiles.name, pauta: pautas.title })
      .from(workItems)
      .innerJoin(profiles, eq(profiles.id, workItems.profileId))
      .leftJoin(pautas, eq(pautas.id, workItems.pautaId))
      .orderBy(desc(workItems.updatedAt))
      .limit(500);

    if (!rows.length) return [];

    const ids = rows.map(({ item }) => item.id);
    const moves = await this.store.db
      .select({ data: events.data, createdAt: events.createdAt })
      .from(events)
      .where(
        and(
          sql`${events.type} in ('work.created', 'work.updated')`,
          inArray(sql`${events.data}->>'id'`, ids),
        ),
      )
      .orderBy(asc(events.id));
    const now = this.clock();

    return rows.map(({ item, agent, pauta }) => {
      const timeline = moves
        .filter((move) => (move.data as { id?: string }).id === item.id)
        .map((move) => ({
          status: (move.data as { status?: string }).status ?? 'todo',
          at: move.createdAt.getTime(),
        }));

      if (!timeline.length) timeline.push({ status: 'todo', at: item.createdAt.getTime() });

      const byStatus: Record<string, number> = {};
      let since = timeline[0]?.at ?? item.createdAt.getTime();
      let status = timeline[0]?.status ?? 'todo';
      let started: number | undefined;
      let finished: number | undefined;

      for (const move of timeline.slice(1)) {
        if (move.status === status) continue;
        byStatus[status] = (byStatus[status] ?? 0) + (move.at - since);
        if (started === undefined && move.status !== 'todo') started = move.at;
        if (move.status === 'done') finished = move.at;
        status = move.status;
        since = move.at;
      }

      if (status !== 'done') byStatus[status] = (byStatus[status] ?? 0) + (now - since);

      return {
        id: item.id,
        title: item.title,
        status: item.status,
        profileId: item.profileId,
        agent,
        ...(item.pautaId ? { pautaId: item.pautaId } : {}),
        ...(pauta ? { pauta } : {}),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        statusSince: new Date(since).toISOString(),
        ...(started !== undefined && finished !== undefined
          ? { workedMs: finished - started }
          : {}),
        byStatus,
      };
    });
  }
}
