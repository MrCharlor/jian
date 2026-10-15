import {
  type EntryMove,
  type EntrySkipped,
  type EntryStale,
  type EntrySync as EntrySyncData,
  type EntrySyncResult,
  entrySyncRunSchema,
  type Plan,
} from '@jian/contracts';
import { desc, inArray } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { EntryTarget } from '../epics/target.js';
import { decidedEntryPlans } from '../plans/repository.js';
import type { WorkClient, WorkClientOpener } from '../priorities/work-board.js';
import {
  type BoardActivity,
  type BoardColumns,
  boardColumns,
  columnCards,
  columnName,
  dependsOn,
  type EntryKey,
  type WorkKey,
} from '../priorities/work-readers.js';
import type { Store } from '../storage/database.js';
import { validations } from '../storage/schema.js';

type Activity = BoardActivity;

type HistoryEvent = {
  event_type: string;
  created_at: string;
  after_data?: { status_id?: string; board_id?: string } | null;
};

/** How the plans module takes a read of the boards. */
export type EntryPlanner = {
  openForEntrySync(input: {
    sync: EntrySyncData;
    requester?: string;
    sessionId?: string;
  }): Promise<{ plan: Plan; unchanged: boolean }>;
  closeEntrySync(note: string): Promise<number>;
};

/** The columns a request moves into, and the ones it may come from. */
const ENTRY_TO: EntryKey[] = ['running', 'blocked', 'done'];
const ENTRY_FROM: EntryKey[] = ['prioritized', 'running'];
/** The only columns an epic is moved into: never Aceito, which is the tech lead's. */
const EPIC_TO: WorkKey[] = ['doing', 'review'];

const DAY = 86_400_000;

const norm = columnName;

type Columns = BoardColumns;

/**
 * The Entrada follows the epic (B20). Each read compares every request of the Entrada with the
 * epics it depends on, and every epic with its tasks, and lists the moves that are missing:
 * an epic goes to Em andamento once a task left A fazer and to Em revisão once every task is
 * Aceito; a request goes to Em execução once its epic left A fazer, to Bloqueado with its
 * epic, and to Concluído once the owner approved the epic in the validation. The moves become
 * a plan; nothing moves until the plan is approved, and every move reads the card again.
 */
export class EntrySync {
  private planner?: EntryPlanner;

  constructor(
    private readonly store: Store,
    private readonly open: WorkClientOpener,
    private readonly keyProfile: () => Promise<string | undefined>,
    private readonly target: EntryTarget,
    private readonly clock: Clock = Date.now,
  ) {}

  usePlanner(planner: EntryPlanner) {
    this.planner = planner;
  }

  private url(id: string, board: string) {
    return `${this.target.webUrl}/w/${this.target.workspaceId}/b/${board}?activity=${id}`;
  }

  private async client(): Promise<WorkClient> {
    const profileId = await this.keyProfile();

    if (!profileId) throw new GatewayError(409, 'No agent reaches the work tracker');

    return this.open(profileId, { workspaceId: this.target.workspaceId });
  }

  private columns(client: WorkClient): Promise<Columns> {
    return boardColumns(client, this.target);
  }

  private column(client: WorkClient, boardId: string, statusId: string) {
    return columnCards(client, boardId, statusId);
  }

  private dependsOn(client: WorkClient, requestId: string, epics: Map<string, Activity>) {
    return dependsOn(client, this.target, requestId, epics);
  }

  /** When the request reached Priorizado: its last move there, or when it reached the board. */
  private async waitingSince(client: WorkClient, request: Activity, prioritized: string) {
    const events = ((await client.call('GET', `/activities/${request.id}/history`)) ??
      []) as HistoryEvent[];
    const sorted = [...events].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const moved = sorted.find((event) => event.after_data?.status_id === prioritized);
    const mirrored = sorted.find(
      (event) =>
        event.event_type === 'activity.mirrored' &&
        (!event.after_data?.board_id || event.after_data.board_id === this.target.entryBoardId),
    );

    return Date.parse(moved?.created_at ?? mirrored?.created_at ?? request.created_at);
  }

  /** Epics the owner approved in the validation (B13), by their latest validation. */
  private async approved(epicIds: string[]) {
    if (!epicIds.length) return new Map<string, number>();

    const rows = await this.store.db
      .select({
        epic: validations.epicWorkId,
        number: validations.number,
        state: validations.state,
      })
      .from(validations)
      .where(inArray(validations.epicWorkId, epicIds))
      .orderBy(desc(validations.createdAt));
    const latest = new Map<string, { number: number; state: string }>();

    for (const row of rows) if (!latest.has(row.epic)) latest.set(row.epic, row);

    return new Map(
      [...latest.entries()]
        .filter(([, row]) => row.state === 'aprovada')
        .map(([epic, row]) => [epic, row.number]),
    );
  }

  /** Reads the three boards and lists what to move, what the owner should hear, and why not. */
  async read(skip = new Map<string, string>()): Promise<EntrySyncData> {
    const client = await this.client();
    const columns = await this.columns(client);
    const work = Object.fromEntries(
      Object.entries(this.target.workColumns).map(([key, name]) => [key, norm(name)]),
    ) as Record<WorkKey, string>;
    const display = (key: WorkKey) => this.target.workColumns[key];
    const onEpics = ((await client.call('GET', `/boards/${this.target.epicsBoardId}/activities`)) ??
      []) as Activity[];
    const onTasks = ((await client.call('GET', `/boards/${this.target.tasksBoardId}/activities`)) ??
      []) as Activity[];
    const epics = new Map(
      onEpics
        .filter((item) => !item.parent_id && item.board_id === this.target.epicsBoardId)
        .map((item) => [item.id, item]),
    );
    // A task's column is the one on the tasks board once it is mirrored there, its own before.
    const tasks = new Map<string, { epic: string; column: string }>();

    for (const item of onEpics) {
      if (item.parent_id && epics.has(item.parent_id)) {
        tasks.set(item.id, { epic: item.parent_id, column: columns.epicName(item.status_id) });
      }
    }
    for (const item of onTasks) {
      if (item.parent_id && epics.has(item.parent_id)) {
        tasks.set(item.id, { epic: item.parent_id, column: columns.taskName(item.status_id) });
      }
    }

    const moves: EntryMove[] = [];
    const projected = new Map<string, string>();
    const keyOf = (column: string) =>
      (Object.keys(work) as WorkKey[]).find((key) => work[key] === column);

    for (const epic of epics.values()) {
      const column = columns.epicName(epic.status_id);
      const own = [...tasks.values()].filter((task) => task.epic === epic.id);

      projected.set(epic.id, column);

      // Bloqueado stays, Em revisão and Aceito are past what the tasks can say.
      if (!own.length || (column !== work.todo && column !== work.doing)) continue;

      const accepted = own.filter((task) => task.column === work.accepted).length;
      const started = own.filter(
        (task) => task.column !== work.todo && task.column !== work.blocked,
      ).length;
      const to: WorkKey | undefined =
        accepted === own.length ? 'review' : column === work.todo && started ? 'doing' : undefined;

      if (!to) continue;

      const from = keyOf(column) as WorkKey;

      moves.push({
        workId: epic.id,
        title: epic.title,
        board: 'epics',
        from: display(from),
        to: display(to),
        fromStatusId: epic.status_id,
        toStatusId: columns.work[to],
        reason:
          to === 'review'
            ? `todas as ${own.length} task(s) em Aceito`
            : `${started} de ${own.length} task(s) saíram de A fazer`,
        url: this.url(epic.id, this.target.epicsBoardId),
      });
      projected.set(epic.id, work[to]);
    }

    const approved = await this.approved([...epics.keys()]);
    const stale: EntryStale[] = [];
    const now = this.clock();
    const requests = [
      ...(await this.column(client, this.target.entryBoardId, columns.entry.prioritized)).map(
        (card) => ({ card, from: 'prioritized' as EntryKey }),
      ),
      ...(await this.column(client, this.target.entryBoardId, columns.entry.running)).map(
        (card) => ({ card, from: 'running' as EntryKey }),
      ),
    ];

    for (const { card, from } of requests) {
      const linked = await this.dependsOn(client, card.id, epics);

      if (!linked.length) {
        if (from !== 'prioritized') continue;

        const days = Math.floor(
          (now - (await this.waitingSince(client, card, columns.entry.prioritized))) / DAY,
        );

        if (days > this.target.staleDays) {
          stale.push({
            workId: card.id,
            title: card.title,
            days,
            url: this.url(card.id, this.target.entryBoardId),
          });
        }
        continue;
      }

      const known = linked.map((item) => epics.get(item.activity_id));

      // An epic of the squad no longer on the board (archived): the owner decides by hand.
      if (known.some((epic) => !epic)) continue;

      const linkedEpics = known as Activity[];
      const open = linkedEpics.filter((epic) => !approved.has(epic.id));
      const where = (epic: Activity) => projected.get(epic.id) ?? '';
      const name = (epic: Activity) => {
        const key = keyOf(where(epic));
        const moved = where(epic) !== columns.epicName(epic.status_id);

        return `épico "${epic.title}" em ${key ? display(key) : where(epic)}${moved ? ' (movido neste plano)' : ''}`;
      };
      let to: EntryKey | undefined;
      let reason = '';

      if (!open.length) {
        to = 'done';
        reason = linkedEpics
          .map(
            (epic) =>
              `épico "${epic.title}" aprovado na validação #${approved.get(epic.id)} do Moabe`,
          )
          .join('; ');
      } else if (open.every((epic) => where(epic) === work.blocked)) {
        to = 'blocked';
        reason = open.map(name).join('; ');
      } else if (from === 'prioritized') {
        const out = open.filter(
          (epic) => where(epic) !== work.todo && where(epic) !== work.blocked,
        );

        if (out.length) {
          to = 'running';
          reason = out.map(name).join('; ');
        }
      }

      if (!to || to === from) continue;

      moves.push({
        workId: card.id,
        title: card.title,
        board: 'entrada',
        from: this.target.entryColumns[from],
        to: this.target.entryColumns[to],
        fromStatusId: columns.entry[from],
        toStatusId: columns.entry[to],
        reason,
        url: this.url(card.id, this.target.entryBoardId),
      });
    }

    return this.leaveOut({ moves, stale, skipped: [], readAt: new Date(now).toISOString() }, skip);
  }

  /**
   * What the author was told not to move, and what the owner refused in the last days, stays
   * out; a request standing still the owner already heard of is not repeated.
   */
  private async leaveOut(sync: EntrySyncData, skip: Map<string, string>): Promise<EntrySyncData> {
    const since = new Date(this.clock() - this.target.staleDays * DAY);
    const decided = await decidedEntryPlans(this.store.db, since);
    const refused = new Map<string, number>();
    const heard = new Set<string>();

    for (const row of decided) {
      for (const item of row.entrySync?.stale ?? []) heard.add(item.workId);
      if (row.state !== 'recusado' || row.approvedBy) continue;
      for (const move of row.entrySync?.moves ?? []) {
        const key = `${move.workId}:${move.toStatusId}`;
        if (!refused.has(key)) refused.set(key, row.number);
      }
    }

    const skipped: EntrySkipped[] = [];
    const moves = sync.moves.filter((move) => {
      const asked = skip.get(move.workId);
      const number = refused.get(`${move.workId}:${move.toStatusId}`);
      const reason = asked ?? (number ? `recusado pelo Moabe no plano #${number}` : undefined);

      if (reason) {
        skipped.push({ workId: move.workId, title: move.title, to: move.to, reason });
      }

      return !reason;
    });

    return {
      ...sync,
      moves,
      stale: sync.stale.filter((item) => !heard.has(item.workId)),
      skipped,
    };
  }

  /**
   * One read of the boards turned into a plan: kept when the open plan already says the same,
   * none when there is nothing to move and no one to tell about.
   */
  async run(
    input: unknown,
    by?: { profileId: string; sessionId?: string },
  ): Promise<EntrySyncResult> {
    const { skip } = entrySyncRunSchema.parse(input ?? {});

    if (!this.planner) throw new GatewayError(409, 'Plans are not available');

    const sync = await this.read(new Map(skip.map((item) => [item.workId, item.reason])));
    const counts = {
      moves: sync.moves.length,
      stale: sync.stale.length,
      skipped: sync.skipped.length,
    };

    if (!sync.moves.length && !sync.stale.length) {
      const closed = await this.planner.closeEntrySync(
        'A leitura mais nova da Entrada não tem nada a mover.',
      );

      return {
        ...counts,
        unchanged: false,
        message: `Nada a mover: a Entrada e os épicos estão em dia.${closed ? ` ${closed} plano(s) aberto(s) encerrado(s).` : ''}`,
      };
    }

    const { plan, unchanged } = await this.planner.openForEntrySync({
      sync,
      ...(by ? { requester: by.profileId } : {}),
      ...(by?.sessionId ? { sessionId: by.sessionId } : {}),
    });

    return {
      ...counts,
      unchanged,
      plan,
      message: unchanged
        ? `O plano #${plan.number} aberto já diz o mesmo; nada novo.`
        : `Plano #${plan.number}: ${counts.moves} movimento(s), ${counts.stale} pedido(s) parado(s). Nada se move antes do plano ser aprovado.`,
    };
  }

  /**
   * Makes the moves of an approved plan, each against the card as it is now: a card that moved
   * meanwhile, lost its epic or left the squad is left alone with the reason. A move already
   * made is not made again, so an approval after a failure only finishes what is left.
   */
  async apply(sync: EntrySyncData): Promise<EntrySyncData> {
    const client = await this.client();
    const columns = await this.columns(client);
    const moves: EntryMove[] = [];

    for (const move of sync.moves) {
      if (move.result === 'feito') {
        moves.push(move);
        continue;
      }

      const { result: _r, resultNote: _n, ...plain } = move;

      try {
        const why = await this.refuse(client, columns, move);

        if (why) {
          moves.push({ ...plain, result: 'pulado', resultNote: why });
          continue;
        }

        await this.move(client, move);
        moves.push({ ...plain, result: 'feito' });
      } catch (failure) {
        moves.push({
          ...plain,
          result: 'falhou',
          resultNote: (failure instanceof Error ? failure.message : String(failure)).slice(0, 500),
        });
      }
    }

    return { ...sync, moves };
  }

  /** Why a move must not be made now, or nothing. The rules are checked again on every move. */
  private async refuse(client: WorkClient, columns: Columns, move: EntryMove) {
    if (move.board === 'epics') {
      if (
        !EPIC_TO.some((key) => columns.work[key] === move.toStatusId) ||
        move.toStatusId === columns.work.accepted
      ) {
        return 'regra: um épico só vai para Em andamento ou Em revisão';
      }
      if (move.fromStatusId === columns.work.blocked) {
        return 'regra: um épico em Bloqueado não sai de lá';
      }

      const epic = (await client.call('GET', `/activities/${move.workId}`)) as Activity;

      if (epic.board_id !== this.target.epicsBoardId || epic.parent_id) {
        return 'não é um épico do board Epics da Sigma';
      }
      if (epic.status_id !== move.fromStatusId) {
        return `já não está em ${move.from} (está em ${columns.epicName(epic.status_id)})`;
      }

      return undefined;
    }

    if (
      !ENTRY_TO.some((key) => columns.entry[key] === move.toStatusId) ||
      !ENTRY_FROM.some((key) => columns.entry[key] === move.fromStatusId)
    ) {
      return 'regra: um pedido só sai de Priorizado ou Em execução para Em execução, Bloqueado ou Concluído';
    }

    const here = await this.column(client, this.target.entryBoardId, move.fromStatusId);

    if (!here.some((card) => card.id === move.workId)) {
      return `já não está em ${move.from} na Entrada`;
    }

    const epics = new Map<string, Activity>();
    const linked = await this.dependsOn(client, move.workId, epics);

    if (!linked.length) return 'regra: o pedido não depende mais de um épico da Sigma';

    return undefined;
  }

  /** Moves the card to the top of its new column, with the version read just now. */
  private async move(client: WorkClient, move: EntryMove) {
    const board = move.board === 'epics' ? this.target.epicsBoardId : this.target.entryBoardId;

    // The tasks board is never written to; a move aimed at it is a bug.
    if (board === this.target.tasksBoardId) throw new GatewayError(409, 'Tasks are never moved');

    const card = (await client.call('GET', `/activities/${move.workId}`)) as Activity;
    const top = (
      (await client.call(
        'GET',
        `/boards/${board}/activities/column?status_id=${move.toStatusId}&limit=1`,
      )) as { items: Activity[] | null }
    ).items?.find((item) => item.id !== move.workId);
    const mirror = card.board_id !== board;

    await client.call(
      'POST',
      mirror
        ? `/activities/${move.workId}/boards/${board}/move`
        : `/activities/${move.workId}/move`,
      {
        status_id: move.toStatusId,
        expected_version: card.version,
        before_activity_id: null,
        after_activity_id: top?.id ?? null,
      },
    );
  }
}
