import { randomUUID } from 'node:crypto';
import {
  type PriorityCriteria,
  type PriorityProposal,
  priorityApplySchema,
  priorityCriteriaInputSchema,
  priorityDiscardSchema,
  priorityProposalInputSchema,
} from '@jian/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Quality } from '../quality/service.js';
import type { Store } from '../storage/database.js';
import { priorityCriteria, priorityProposals } from '../storage/schema.js';
import type { BoardCard, BoardOpener, WorkBoard } from './work-board.js';

type Row = typeof priorityProposals.$inferSelect;
type Via = NonNullable<PriorityProposal['decidedVia']>;
type Titled = { workId: string; title: string };

/** The automation the owner's adjustments are counted against in Quality. */
export const PRIORITY_AUTOMATION = 'priorizacao';

const CRITERIA_ID = 'owner';

function present(row: Row): PriorityProposal {
  return {
    id: row.id,
    number: row.number,
    state: row.state as PriorityProposal['state'],
    workspaceId: row.workspaceId,
    boardId: row.boardId,
    statusId: row.statusId,
    ...(row.sourceStatusId ? { sourceStatusId: row.sourceStatusId } : {}),
    summary: row.summary,
    cards: row.cards,
    current: row.current,
    ...(row.applied ? { applied: row.applied } : {}),
    ...(row.adjusted !== null ? { adjusted: row.adjusted } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.note ? { note: row.note } : {}),
    ...(row.proposedBy ? { proposedBy: row.proposedBy } : {}),
    ...(row.decidedVia ? { decidedVia: row.decidedVia as Via } : {}),
    ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

const numbered = (cards: Titled[]) =>
  cards.map((item, index) => `${index + 1}. ${item.title}`).join('\n');

/**
 * The order of the column the team pulls from. An agent proposes it with a reason per card;
 * the owner adjusts and applies it, and the board is reordered — only that column, and only
 * the cards out of place. What the owner changed is a correction the agent learns from.
 */
export class Priorities {
  private remember?: (profileId: string, key: string, content: string) => Promise<unknown>;
  private notify?: (
    profileId: string,
    sessionId: string,
    text: string,
    key: string,
  ) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private open: BoardOpener,
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(hooks: {
    remember: NonNullable<Priorities['remember']>;
    notify: NonNullable<Priorities['notify']>;
  }) {
    this.remember = hooks.remember;
    this.notify = hooks.notify;
  }

  /** Swaps how boards are reached; tests hand in a board held in memory. */
  useBoards(open: BoardOpener) {
    this.open = open;
  }

  async criteria(): Promise<PriorityCriteria> {
    const [row] = await this.store.db
      .select()
      .from(priorityCriteria)
      .where(eq(priorityCriteria.id, CRITERIA_ID));

    return row ? { text: row.text, updatedAt: row.updatedAt.toISOString() } : { text: '' };
  }

  async setCriteria(input: unknown): Promise<PriorityCriteria> {
    const { text } = priorityCriteriaInputSchema.parse(input);
    const now = new Date(this.clock());

    await this.store.db
      .insert(priorityCriteria)
      .values({ id: CRITERIA_ID, text, updatedAt: now })
      .onConflictDoUpdate({ target: priorityCriteria.id, set: { text, updatedAt: now } });

    return this.criteria();
  }

  async list(): Promise<PriorityProposal[]> {
    const rows = await this.store.db
      .select()
      .from(priorityProposals)
      .orderBy(desc(priorityProposals.createdAt))
      .limit(30);

    return rows.map(present);
  }

  private async row(which: { id: string } | { number: number }): Promise<Row> {
    const [row] = await this.store.db
      .select()
      .from(priorityProposals)
      .where(
        'id' in which
          ? eq(priorityProposals.id, which.id)
          : eq(priorityProposals.number, which.number),
      );

    return assertFound(row, 'Priority proposal');
  }

  async get(which: { id: string } | { number: number }): Promise<PriorityProposal> {
    return present(await this.row(which));
  }

  /**
   * Records an agent's order. The column is read now, so the owner sees today's order beside
   * the proposal; a card of the column the agent left out goes last, without a reason. Opening
   * a new proposal closes the one still open, since only the latest one is current.
   */
  async propose(
    input: unknown,
    by: { profileId: string; sessionId: string; name: string },
  ): Promise<PriorityProposal> {
    const data = priorityProposalInputSchema.parse(input);
    const board = await this.open(by.profileId, data);
    const column = await board.column(data.statusId);
    const source = data.sourceStatusId ? await board.column(data.sourceStatusId) : [];
    const known = new Map([...source, ...column].map((item) => [item.id, item]));
    const seen = new Set<string>();
    const cards: PriorityProposal['cards'] = [];

    for (const item of data.cards) {
      const found = known.get(item.workId);

      if (!found) {
        throw new GatewayError(
          409,
          `Card ${item.workId} is not in the column nor in the source column`,
        );
      }

      if (seen.has(found.id)) continue;
      seen.add(found.id);
      cards.push({
        workId: found.id,
        title: found.title,
        reason: item.reason,
        raise: !column.some((entry) => entry.id === found.id),
      });
    }

    for (const item of column) {
      if (!seen.has(item.id)) cards.push({ workId: item.id, title: item.title, raise: false });
    }

    return this.store.transaction('priority_proposals', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${priorityProposals.number}), 0)` })
        .from(priorityProposals);
      const id = randomUUID();

      await tx
        .update(priorityProposals)
        .set({ state: 'descartada', note: 'Substituída por uma proposta nova.' })
        .where(eq(priorityProposals.state, 'proposta'));

      await tx.insert(priorityProposals).values({
        id,
        number: Number(top?.max ?? 0) + 1,
        state: 'proposta',
        workspaceId: data.workspaceId,
        boardId: data.boardId,
        statusId: data.statusId,
        sourceStatusId: data.sourceStatusId ?? null,
        server: data.server ?? null,
        summary: data.summary,
        cards,
        current: column.map((item) => ({ workId: item.id, title: item.title })),
        proposedBy: by.name,
        profileId: by.profileId,
        sessionId: by.sessionId,
        createdAt: new Date(this.clock()),
      });

      const [row] = await tx.select().from(priorityProposals).where(eq(priorityProposals.id, id));

      return present(assertFound(row, 'Priority proposal'));
    });
  }

  /**
   * Reorders the column as the owner left it. The column is read again: a card that came into
   * it since the proposal goes last, a card that left both columns stops everything before any
   * move. A move that fails leaves the proposal open with the error, to be tried again.
   */
  async apply(
    which: { id: string } | { number: number },
    input: unknown,
    via: Via,
  ): Promise<PriorityProposal> {
    const { order } = priorityApplySchema.parse(input ?? {});
    const row = await this.row(which);

    if (row.state !== 'proposta') {
      throw new GatewayError(409, `Priority proposal #${row.number} is already ${row.state}`);
    }

    if (!row.profileId) {
      throw new GatewayError(409, 'The agent that proposed it no longer exists');
    }

    const board = await this.open(row.profileId, {
      workspaceId: row.workspaceId,
      boardId: row.boardId,
      ...(row.server ? { server: row.server } : {}),
    });
    const wanted = order ?? row.cards.map((item) => item.workId);
    const final = await this.resolve(board, row, wanted);
    const proposed = row.cards.map((item) => item.workId);
    const adjusted = order !== undefined && order.join() !== proposed.join();
    const applied = final.map((item) => ({ workId: item.id, title: item.title }));

    try {
      await this.reorder(board, row, final);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);

      await this.store.db
        .update(priorityProposals)
        .set({ error: message.slice(0, 2000) })
        .where(eq(priorityProposals.id, row.id));
      throw failure;
    }

    const now = new Date(this.clock());

    await this.store.db
      .update(priorityProposals)
      .set({
        state: 'aplicada',
        applied,
        adjusted,
        error: null,
        decidedVia: via,
        decidedAt: now,
      })
      .where(eq(priorityProposals.id, row.id));

    const titles = (ids: string[]) =>
      ids.map((id) => ({
        workId: id,
        title: row.cards.find((item) => item.workId === id)?.title ?? id,
      }));

    if (adjusted) {
      await this.quality?.record(this.store.db, row.profileId, {
        kind: 'edited',
        via: via === 'agent' ? 'api' : via,
        action: PRIORITY_AUTOMATION,
        original: numbered(titles(proposed)),
        corrected: numbered(applied),
      });
      await this.remember?.(
        row.profileId,
        `priorizacao-${row.number}`,
        `Priorização #${row.number} (${now.toISOString().slice(0, 10)}): o Moabe ajustou a ordem antes de aplicar.\nProposta:\n${numbered(titles(proposed))}\nAplicada:\n${numbered(applied)}`,
      ).catch(() => {});
    }

    if (via !== 'agent' && row.sessionId) {
      await this.notify?.(
        row.profileId,
        row.sessionId,
        `[Priorização #${row.number} aplicada pelo Moabe${adjusted ? ', com ajustes' : ''}] Ordem no Work:\n${numbered(applied)}`,
        `priorities:${row.id}`,
      ).catch(() => {});
    }

    return this.get({ id: row.id });
  }

  async discard(id: string, input: unknown, via: Via): Promise<PriorityProposal> {
    const { note } = priorityDiscardSchema.parse(input ?? {});
    const row = await this.row({ id });

    if (row.state !== 'proposta') {
      throw new GatewayError(409, `Priority proposal #${row.number} is already ${row.state}`);
    }

    const now = new Date(this.clock());

    await this.store.db
      .update(priorityProposals)
      .set({ state: 'descartada', note: note ?? null, decidedVia: via, decidedAt: now })
      .where(eq(priorityProposals.id, id));

    if (row.profileId) {
      await this.quality?.record(this.store.db, row.profileId, {
        kind: 'rejected',
        via: via === 'agent' ? 'api' : via,
        action: PRIORITY_AUTOMATION,
        original: numbered(row.cards),
        ...(note ? { note } : {}),
      });

      if (row.sessionId) {
        await this.notify?.(
          row.profileId,
          row.sessionId,
          `[Priorização #${row.number} descartada pelo Moabe]${note ? ` Motivo: ${note}` : ''}`,
          `priorities:${row.id}`,
        ).catch(() => {});
      }
    }

    return this.get({ id });
  }

  /** The cards to place, in order: the owner's, then any that came into the column since. */
  private async resolve(board: WorkBoard, row: Row, wanted: string[]): Promise<BoardCard[]> {
    const column = await board.column(row.statusId);
    const source = row.sourceStatusId ? await board.column(row.sourceStatusId) : [];
    const known = new Map([...source, ...column].map((item) => [item.id, item]));
    const final: BoardCard[] = [];

    for (const id of new Set(wanted)) {
      const found = known.get(id);

      if (!found) {
        const title = row.cards.find((item) => item.workId === id)?.title ?? id;

        throw new GatewayError(409, `"${title}" saiu das colunas desde a proposta`);
      }

      final.push(found);
    }

    for (const item of column) {
      if (!final.some((entry) => entry.id === item.id)) final.push(item);
    }

    return final;
  }

  /** Moves only what is out of place, top to bottom, each card after the one above it. */
  private async reorder(board: WorkBoard, row: Row, final: BoardCard[]) {
    let live = (await board.column(row.statusId)).map((item) => item.id);

    for (const [index, target] of final.entries()) {
      if (live[index] === target.id) continue;

      const above = final[index - 1];
      const placement = above ? { afterId: above.id } : { beforeId: live[0] };

      try {
        await board.move(target, { statusId: row.statusId, ...placement });
      } catch {
        // A move can shift the version of a card not yet moved: read it again and retry once.
        const fresh = [
          ...(await board.column(row.statusId)),
          ...(row.sourceStatusId ? await board.column(row.sourceStatusId) : []),
        ].find((item) => item.id === target.id);

        await board.move(fresh ?? target, { statusId: row.statusId, ...placement });
      }

      live = (await board.column(row.statusId)).map((item) => item.id);
    }
  }
}
