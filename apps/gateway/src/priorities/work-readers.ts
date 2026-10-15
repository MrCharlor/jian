import { GatewayError } from '../core/errors.js';
import type { EntryTarget } from '../epics/target.js';
import type { WorkClient } from './work-board.js';

/** A card as the boards list it. */
export type BoardActivity = {
  id: string;
  title: string;
  status_id: string;
  board_id: string;
  version: number;
  parent_id?: string | null;
  created_at: string;
};

export type Relationship = {
  activity_id: string;
  board_id?: string | null;
  relation_type: string;
  direction: string;
};

export type EntryKey = keyof EntryTarget['entryColumns'];
export type WorkKey = keyof EntryTarget['workColumns'];

export type BoardColumns = {
  entry: Record<EntryKey, string>;
  work: Record<WorkKey, string>;
  /** A column name on the epics or the tasks board, normalized, by status id. */
  epicName(statusId: string): string;
  taskName(statusId: string): string;
};

export const columnName = (name: string) => name.normalize('NFC').trim().toLowerCase();

/**
 * The columns of the squad's boards as they are named now. A column missing, or an Entrada
 * column whose id does not start as the team recorded, stops the read: the board changed under
 * the names.
 */
export async function boardColumns(client: WorkClient, target: EntryTarget): Promise<BoardColumns> {
  const read = async (boardId: string) => {
    const answer = (await client.call('GET', `/boards/${boardId}/statuses`)) as {
      statuses: Array<{ id: string; name: string }> | null;
    };
    const list = answer.statuses ?? [];

    return {
      byName: new Map(list.map((item) => [columnName(item.name), item.id])),
      byId: new Map(list.map((item) => [item.id, columnName(item.name)])),
    };
  };
  const [entry, epics, tasks] = await Promise.all([
    read(target.entryBoardId),
    read(target.epicsBoardId),
    read(target.tasksBoardId),
  ]);
  const pick = (
    map: Map<string, string>,
    name: string,
    board: string,
    expected?: (id: string) => boolean,
  ) => {
    const id = map.get(columnName(name));

    if (!id) throw new GatewayError(409, `The ${board} board has no column "${name}"`);
    if (expected && !expected(id)) {
      throw new GatewayError(
        409,
        `The ${board} column "${name}" is ${id}, not the one recorded for it; check the target`,
      );
    }

    return id;
  };
  const entryIds = Object.fromEntries(
    (Object.keys(target.entryColumns) as EntryKey[]).map((key) => {
      const prefix = target.entryColumnIds[key];

      return [
        key,
        pick(
          entry.byName,
          target.entryColumns[key],
          'Entrada',
          prefix ? (id) => id.startsWith(prefix) : undefined,
        ),
      ];
    }),
  ) as Record<EntryKey, string>;
  const workIds = Object.fromEntries(
    (Object.keys(target.workColumns) as WorkKey[]).map((key) => [
      key,
      pick(
        epics.byName,
        target.workColumns[key],
        'Epics',
        key === 'todo' && target.todoStatusId ? (id) => id === target.todoStatusId : undefined,
      ),
    ]),
  ) as Record<WorkKey, string>;

  return {
    entry: entryIds,
    work: workIds,
    epicName: (id) => epics.byId.get(id) ?? id,
    taskName: (id) => tasks.byId.get(id) ?? epics.byId.get(id) ?? id,
  };
}

/** Every card of one column, page by page, up to 500. */
export async function columnCards(
  client: WorkClient,
  boardId: string,
  statusId: string,
): Promise<BoardActivity[]> {
  const cards: BoardActivity[] = [];
  let cursor = '';

  do {
    const page = (await client.call(
      'GET',
      `/boards/${boardId}/activities/column?status_id=${statusId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    )) as { items: BoardActivity[] | null; next_cursor?: string | null };

    cards.push(...(page.items ?? []));
    cursor = page.next_cursor ?? '';
  } while (cursor && cards.length < 500);

  return cards;
}

/** The epics of the squad a request depends on: "depende de" pointing to the epics board. */
export async function dependsOn(
  client: WorkClient,
  target: Pick<EntryTarget, 'epicsBoardId'>,
  requestId: string,
  epics: Map<string, unknown>,
): Promise<Relationship[]> {
  const answer = (await client.call('GET', `/activities/${requestId}/relationships`)) as {
    relationships: Relationship[] | null;
  };

  return (answer.relationships ?? []).filter(
    (item) =>
      item.relation_type === 'depends_on' &&
      item.direction === 'out' &&
      (item.board_id === target.epicsBoardId || epics.has(item.activity_id)),
  );
}
