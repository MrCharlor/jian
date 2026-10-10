import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import type { WorkClientOpener } from '../priorities/work-board.js';

export const flowReportInputSchema = z.object({
  workspaceId: z.string().min(1).max(80),
  epicsBoardId: z.string().min(1).max(80),
  tasksBoardId: z.string().min(1).max(80),
  weeks: z.number().int().min(1).max(26).default(6),
  /** Member names by id, from the tracker's member list; ids are shown otherwise. */
  names: z.record(z.string(), z.string()).default({}),
  server: z.string().min(1).max(80).optional(),
});

export type FlowReportInput = z.input<typeof flowReportInputSchema>;

type Activity = {
  id: string;
  title: string;
  status_id: string;
  assignee_id?: string | null;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
};

type HistoryEvent = {
  event_type: string;
  created_at: string;
  before_data?: { status_id?: string } | null;
  after_data?: { status_id?: string } | null;
};

/** One card with every column change it went through, oldest first. */
export type Timeline = {
  id: string;
  title: string;
  kind: 'epic' | 'task';
  column: string;
  assignee?: string;
  archived: boolean;
  createdAt: number;
  /** When it reached this board, if it is a mirror of a card from another one. */
  arrivedAt?: number;
  moves: Array<{ at: number; from: string; to: string }>;
};

const DAY = 86_400_000;
/** The team works in Brasília time; the day boundaries follow it. */
const OFFSET = -3 * 3_600_000;

/** Working days between two instants, Monday to Friday, fractional. Holidays are not known. */
export function workingDays(from: number, to: number): number {
  let total = 0;
  let cursor = from + OFFSET;
  const end = to + OFFSET;

  while (cursor < end) {
    const next = Math.min(end, Math.floor(cursor / DAY) * DAY + DAY);
    const weekday = new Date(cursor).getUTCDay();

    if (weekday !== 0 && weekday !== 6) total += (next - cursor) / DAY;
    cursor = next;
  }

  return total;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const days = (value: number) => value.toFixed(1).replace('.', ',');

const summary = (values: number[]) =>
  values.length
    ? `mediana ${days(median(values))} · máx ${days(Math.max(...values))} (${values.length})`
    : 'sem dados no período';

const date = (at: number) => {
  const local = new Date(at + OFFSET);

  return `${String(local.getUTCDate()).padStart(2, '0')}/${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
};

const monday = (at: number) => {
  const local = at + OFFSET;
  const weekday = (new Date(local).getUTCDay() + 6) % 7;

  return Math.floor(local / DAY) * DAY - weekday * DAY - OFFSET;
};

const first = (card: Timeline, to: string) => card.moves.find((move) => move.to === to)?.at;
const last = (card: Timeline, to: string) =>
  [...card.moves].reverse().find((move) => move.to === to)?.at;

/**
 * The team's flow in plain numbers: what was accepted each week, how long epics took in each
 * stretch, how often tasks came back from review, and what is standing still today.
 */
export function flowReport(
  cards: Timeline[],
  now: number,
  weeks: number,
  names: Record<string, string>,
): string {
  const since = monday(now) - (weeks - 1) * 7 * DAY;
  const epics = cards.filter((card) => card.kind === 'epic');
  const tasks = cards.filter((card) => card.kind === 'task');
  const who = (id?: string) => (id ? (names[id] ?? id.slice(0, 8)) : 'sem responsável');
  const lines: string[] = [];

  lines.push(
    `# Fluxo da Sigma, ${date(since)} a ${date(now)}`,
    '',
    `Em dias úteis (seg a sex, sem feriados). Épicos: ${epics.length}. Tasks: ${tasks.length}.`,
    '',
    '## Por semana',
    '',
    '| Semana | Tasks aceitas | Épicos aceitos | Voltas de task |',
    '|---|---|---|---|',
  );

  for (let week = since; week <= now; week += 7 * DAY) {
    const inWeek = (list: Timeline[]) =>
      list.filter((card) => {
        const at = last(card, 'Aceito');
        return at !== undefined && at >= week && at < week + 7 * DAY;
      }).length;

    const back = tasks.flatMap((card) =>
      card.moves.filter(
        (move) =>
          move.at >= week &&
          move.at < week + 7 * DAY &&
          ['Em revisão', 'Aceito'].includes(move.from) &&
          ['Em andamento', 'A fazer'].includes(move.to),
      ),
    ).length;

    lines.push(`| ${date(week)} | ${inWeek(tasks)} | ${inWeek(epics)} | ${back} |`);
  }

  const accepted = epics.filter((card) => (last(card, 'Aceito') ?? 0) >= since);
  const stretch = (
    from: (card: Timeline) => number | undefined,
    to: (card: Timeline) => number | undefined,
  ) =>
    accepted.flatMap((card) => {
      const start = from(card);
      const end = to(card);
      return start !== undefined && end !== undefined && end > start
        ? [workingDays(start, end)]
        : [];
    });

  lines.push(
    '',
    '## Épicos aceitos no período',
    '',
    `- Criado até começar: ${summary(
      stretch(
        (card) => card.createdAt,
        (card) => first(card, 'Em andamento'),
      ),
    )}`,
    `- Em andamento até Em revisão: ${summary(
      stretch(
        (card) => first(card, 'Em andamento'),
        (card) => first(card, 'Em revisão'),
      ),
    )}`,
    `- Em revisão até Aceito: ${summary(
      stretch(
        (card) => last(card, 'Em revisão'),
        (card) => last(card, 'Aceito'),
      ),
    )}`,
    `- Criado até Aceito: ${summary(
      stretch(
        (card) => card.createdAt,
        (card) => last(card, 'Aceito'),
      ),
    )}`,
  );

  const returns = tasks.map((card) => ({
    card,
    count: card.moves.filter(
      (move) =>
        move.at >= since &&
        ['Em revisão', 'Aceito'].includes(move.from) &&
        ['Em andamento', 'A fazer'].includes(move.to),
    ).length,
  }));
  const returned = returns.filter((item) => item.count > 0);
  const byPerson = new Map<string, { tasks: number; returns: number }>();

  for (const { card, count } of returned) {
    const person = who(card.assignee);
    const entry = byPerson.get(person) ?? { tasks: 0, returns: 0 };
    byPerson.set(person, { tasks: entry.tasks + 1, returns: entry.returns + count });
  }

  lines.push(
    '',
    '## Retrabalho no período',
    '',
    `- Tasks que voltaram de Em revisão ou Aceito: ${returned.length} de ${tasks.length}, ${returned.reduce((sum, item) => sum + item.count, 0)} voltas.`,
    ...[...byPerson.entries()]
      .sort((a, b) => b[1].returns - a[1].returns)
      .map(([person, entry]) => `- ${person}: ${entry.returns} voltas em ${entry.tasks} tasks.`),
  );

  const standing = (list: Timeline[]) =>
    list
      .filter((card) => !card.archived && card.column !== 'Aceito')
      .map((card) => ({
        card,
        idle: workingDays(card.moves.at(-1)?.at ?? card.arrivedAt ?? card.createdAt, now),
      }))
      .sort((a, b) => b.idle - a.idle)
      .slice(0, 8);

  lines.push('', '## Parado hoje (dias úteis na coluna atual)', '');

  for (const { card, idle } of standing(epics)) {
    lines.push(`- Épico em ${card.column} há ${days(idle)}: ${card.title}`);
  }

  for (const { card, idle } of standing(tasks)) {
    lines.push(`- Task em ${card.column} há ${days(idle)} (${who(card.assignee)}): ${card.title}`);
  }

  return lines.join('\n');
}

/** Reads both boards of the team from the tracker and writes the report. */
export class Flow {
  constructor(
    private readonly open: WorkClientOpener,
    private readonly clock: Clock = Date.now,
  ) {}

  async report(profileId: string, input: FlowReportInput): Promise<string> {
    const data = flowReportInputSchema.parse(input);
    const client = await this.open(profileId, data);
    const now = this.clock();
    const since = monday(now) - data.weeks * 7 * DAY;
    const cards: Timeline[] = [];

    for (const [kind, boardId] of [
      ['epic', data.epicsBoardId],
      ['task', data.tasksBoardId],
    ] as const) {
      const statuses = (await client.call('GET', `/boards/${boardId}/statuses`)) as {
        statuses: Array<{ id: string; name: string }>;
      };
      const column = new Map(statuses.statuses.map((item) => [item.id, item.name]));
      const name = (id?: string) => (id ? (column.get(id) ?? id.slice(0, 8)) : '');
      const active = (await client.call('GET', `/boards/${boardId}/activities`)) as Activity[];
      const archived = (await client.call(
        'GET',
        `/boards/${boardId}/activities/archived`,
      )) as Activity[];
      const wanted = [
        ...active.map((item) => ({ item, archived: false })),
        ...archived
          .filter((item) => Date.parse(item.updated_at) >= since)
          .map((item) => ({ item, archived: true })),
      ].filter(({ item }) => kind === 'task' || !item.parent_id);

      // A few at a time: the tracker answers each history on its own.
      for (let index = 0; index < wanted.length; index += 5) {
        const batch = wanted.slice(index, index + 5);
        const histories = await Promise.all(
          batch.map(
            ({ item }) =>
              client.call('GET', `/activities/${item.id}/history`) as Promise<HistoryEvent[]>,
          ),
        );

        batch.forEach(({ item, archived: gone }, position) => {
          const events = [...(histories[position] ?? [])].sort(
            (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
          );
          const mirrored = events.find((event) => event.event_type === 'activity.mirrored');

          cards.push({
            id: item.id,
            title: item.title,
            kind,
            column: name(item.status_id),
            ...(item.assignee_id ? { assignee: item.assignee_id } : {}),
            archived: gone,
            createdAt: Date.parse(item.created_at),
            ...(mirrored ? { arrivedAt: Date.parse(mirrored.created_at) } : {}),
            moves: events.flatMap((event) => {
              const from = event.before_data?.status_id;
              const to = event.after_data?.status_id;

              return event.event_type === 'activity.moved' && to && from !== to
                ? [{ at: Date.parse(event.created_at), from: name(from), to: name(to) }]
                : [];
            }),
          });
        });
      }
    }

    return flowReport(cards, now, data.weeks, data.names);
  }
}
