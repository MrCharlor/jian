import type {
  InboxAction,
  InboxItem,
  InboxKind,
  InboxOutcome,
  InboxReply,
  InboxStat,
} from '@jian/contracts';
import { inboxDecisionSchema } from '@jian/contracts';
import { and, eq, gte, inArray, isNotNull, isNull, notInArray, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { inbox } from '../storage/schema.js';

export type InboxVia = 'panel' | 'channel' | 'api';

/** One thing waiting for the owner, as its own queue tells it. */
export type InboxPending = {
  refId: string;
  refNumber: number;
  title: string;
  summary?: string;
  link?: string;
  highImpact?: boolean;
  /** Defaults to the source's own: what is decided and what matters for it. */
  question?: string;
  details?: string[];
  createdAt: string;
};

/**
 * A queue the inbox reads and answers through: what waits in it, and the three answers, each
 * calling the same decision the queue's own page and old command call. Each answer returns the
 * line the owner reads about it.
 */
export type InboxSource = {
  kind: InboxKind;
  /** How the owner calls one of these: "Plano", "Regra". */
  label: string;
  /** What the owner decides on one of these, when the item does not say it better. */
  question: string;
  ifOk: string;
  ifNo: string;
  ifText?: string;
  okLabel: string;
  noLabel: string;
  pending(): Promise<InboxPending[]>;
  /** `chat`: the owner answered in a conversation, which the agent reads next on its own. */
  ok(item: InboxPending, via: InboxVia, chat: boolean): Promise<string>;
  no(item: InboxPending, reason: string | undefined, via: InboxVia, chat: boolean): Promise<string>;
  /** Absent when the queue has nothing to do with the owner's own words. */
  text?(item: InboxPending, text: string, via: InboxVia, chat: boolean): Promise<string>;
};

type Row = typeof inbox.$inferSelect;

const DAY = 86_400_000;

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const STATS_DAYS = 30;

const failure = (error: unknown) =>
  error instanceof Error ? error.message.replace(/^The board answered \d+: /, '') : String(error);

/** The commands, as every notice and the page end with them. */
export const INBOX_COMMANDS =
  'Responda "ok N", "não N: motivo" ou "N: texto" (N é o número da caixa).';

/**
 * The owner's inbox (B26). Each queue keeps its items; the inbox gives each one a number that
 * never repeats across queues, and answers "ok N", "não N: motivo" and "N: texto" by calling the
 * queue's own decision. Whatever decided an item, here or in its queue, closes it here.
 */
export class Inbox {
  private readonly sources = new Map<InboxKind, InboxSource>();

  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  use(source: InboxSource) {
    this.sources.set(source.kind, source);
  }

  /**
   * Reads what waits in the queues and brings the numbers up to date: a new item is numbered,
   * one no longer waiting is closed, one waiting again is opened again. A queue that fails to
   * answer keeps its rows as they were.
   */
  private async sync(kinds?: InboxKind[]): Promise<Map<string, InboxPending>> {
    const found = new Map<string, InboxPending>();
    const now = new Date(this.clock());

    for (const source of this.sources.values()) {
      if (kinds && !kinds.includes(source.kind)) continue;

      let pending: InboxPending[];

      try {
        pending = await source.pending();
      } catch (error) {
        console.error(`jian: the inbox could not read the ${source.kind} queue`, error);
        continue;
      }

      for (const item of pending) {
        found.set(`${source.kind}:${item.refId}`, item);
        await this.keep(source.kind, item);
      }

      const waiting = pending.map((item) => item.refId);

      await this.store.db
        .update(inbox)
        .set({ closedAt: now })
        .where(
          and(
            eq(inbox.kind, source.kind),
            isNull(inbox.closedAt),
            ...(waiting.length ? [notInArray(inbox.refId, waiting)] : []),
          ),
        );
    }

    return found;
  }

  /**
   * The item numbered once: a new one takes the next number, counted without gaps; one seen
   * before keeps its number, and opens again if it waits again.
   */
  private async keep(kind: InboxKind, item: InboxPending) {
    await this.store.transaction('inbox', async (tx) => {
      const [seen] = await tx
        .select({ number: inbox.number })
        .from(inbox)
        .where(and(eq(inbox.kind, kind), eq(inbox.refId, item.refId)))
        .limit(1);
      const title = item.title.slice(0, 500);
      const highImpact = Boolean(item.highImpact);

      if (seen) {
        await tx
          .update(inbox)
          .set({ title, highImpact, closedAt: null, decidedVia: null })
          .where(eq(inbox.number, seen.number));
        return;
      }

      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${inbox.number}), 0)` })
        .from(inbox);

      await tx.insert(inbox).values({
        number: Number(top?.max ?? 0) + 1,
        kind,
        refId: item.refId,
        refNumber: item.refNumber,
        title,
        highImpact,
        openedAt: new Date(item.createdAt),
      });
    });
  }

  private present(row: Row, item: InboxPending): InboxItem {
    const source = this.sources.get(row.kind as InboxKind);

    return {
      number: row.number,
      kind: row.kind as InboxKind,
      refId: row.refId,
      refNumber: row.refNumber,
      title: item.title,
      ...(item.summary ? { summary: item.summary } : {}),
      ...(item.link ? { link: item.link } : {}),
      highImpact: row.highImpact,
      acceptsText: Boolean(source?.text),
      question: item.question ?? source?.question ?? '',
      details: (item.details ?? []).filter(Boolean).slice(0, 12),
      ifOk: source?.ifOk ?? '',
      ifNo: source?.ifNo ?? '',
      ...(source?.text && source.ifText ? { ifText: source.ifText } : {}),
      okLabel: source?.okLabel ?? 'Aceitar',
      noLabel: source?.noLabel ?? 'Recusar',
      createdAt: row.openedAt.toISOString(),
    };
  }

  private async open(kinds?: InboxKind[]) {
    const found = await this.sync(kinds);
    const rows = await this.store.db
      .select()
      .from(inbox)
      .where(and(isNull(inbox.closedAt), ...(kinds ? [inArray(inbox.kind, kinds)] : [])));

    return rows
      .map((row) => ({ row, item: found.get(`${row.kind}:${row.refId}`) }))
      .filter((entry): entry is { row: Row; item: InboxPending } => Boolean(entry.item));
  }

  /** What waits for the owner: the high-impact first, then the oldest. */
  async list(): Promise<{ items: InboxItem[]; stats: InboxStat[] }> {
    const open = await this.open();
    const items = open
      .map(({ row, item }) => this.present(row, item))
      .sort(
        (a, b) =>
          Number(b.highImpact) - Number(a.highImpact) || a.createdAt.localeCompare(b.createdAt),
      );

    return { items, stats: await this.stats() };
  }

  /** The number the owner answers an item with; it is numbered now if it was not yet. */
  async numberFor(kind: InboxKind, refId: string): Promise<number | undefined> {
    await this.sync([kind]);

    const [row] = await this.store.db
      .select({ number: inbox.number })
      .from(inbox)
      .where(and(eq(inbox.kind, kind), eq(inbox.refId, refId)))
      .limit(1);

    return row?.number;
  }

  /**
   * The open items of these kinds the owner has not been told the number of yet, marked told:
   * `panel` is a block that follows the full notice; `chat` stands in for the notice on a phone,
   * one line per item. Both empty when there is none.
   */
  async announce(kinds: InboxKind[]): Promise<{ panel: string; chat: string }> {
    const open = (await this.open(kinds)).filter(({ row }) => !row.announcedAt);

    if (!open.length) return { panel: '', chat: '' };

    await this.store.db
      .update(inbox)
      .set({ announcedAt: new Date(this.clock()) })
      .where(
        inArray(
          inbox.number,
          open.map(({ row }) => row.number),
        ),
      );

    const sorted = open.sort((a, b) => a.row.number - b.row.number);
    const labels = [
      ...new Set(
        sorted.map(({ row }) => this.sources.get(row.kind as InboxKind)?.label ?? row.kind),
      ),
    ];
    const numbers = sorted.map(({ row }) => row.number);
    const first = numbers[0] ?? 0;
    const last = numbers.at(-1) ?? 0;
    const together = numbers.length > 1 && last - first === numbers.length - 1;
    const head =
      labels.length === 1
        ? `${labels[0]}: ${numbers.length} esperando você`
        : `${numbers.length} itens esperando você`;
    const lines = sorted.map(({ row, item }) => `#${row.number} · ${clip(item.title, 90)}`);
    const commands = together
      ? `Tudo: ok ${first}-${last} · Uma: ok N, não N: motivo, N: texto`
      : 'Responda: ok N, não N: motivo, N: texto';

    return {
      panel: [`Na caixa: ${lines.join('; ')}.`, INBOX_COMMANDS].join('\n'),
      chat: [head, ...lines, commands].join('\n'),
    };
  }

  /**
   * Whether a reply is for the inbox at all: some number in it exists here. A number the inbox
   * never gave stays the owner's words, and an older command of the same shape can still take it.
   */
  async knows(numbers: number[]): Promise<boolean> {
    if (!numbers.length) return false;

    await this.sync();

    const rows = await this.store.db
      .select({ number: inbox.number })
      .from(inbox)
      .where(inArray(inbox.number, numbers))
      .limit(1);

    return rows.length > 0;
  }

  /** One number from the panel's buttons. */
  async decideOne(number: number, input: unknown, via: InboxVia): Promise<InboxOutcome> {
    const { action, text } = inboxDecisionSchema.parse(input ?? {});
    const [outcome] = await this.decide(
      { numbers: [number], action, ...(text ? { text } : {}) },
      via,
      false,
    );

    if (!outcome) throw new GatewayError(404, `Nothing #${number} in the inbox`);
    if (!outcome.ok) throw new GatewayError(409, outcome.text);

    return outcome;
  }

  /** "ok 3-7", "não 4: motivo" or "5: texto": each number answered by its own queue, in order. */
  async decide(reply: InboxReply, via: InboxVia, chat = true): Promise<InboxOutcome[]> {
    const outcomes: InboxOutcome[] = [];

    for (const number of reply.numbers) {
      outcomes.push(await this.decideNumber(number, reply.action, reply.text, via, chat));
    }

    return outcomes;
  }

  private async decideNumber(
    number: number,
    action: InboxAction,
    text: string | undefined,
    via: InboxVia,
    chat: boolean,
  ): Promise<InboxOutcome> {
    const [row] = await this.store.db.select().from(inbox).where(eq(inbox.number, number));

    if (!row) return { number, ok: false, text: `#${number}: não existe na caixa.` };

    const source = this.sources.get(row.kind as InboxKind);
    const label = `#${number} (${source?.label ?? row.kind} ${row.refNumber}, ${row.title})`;

    if (!source) return { number, ok: false, text: `${label}: este tipo não se decide aqui.` };

    const item = (await this.sync([source.kind])).get(`${row.kind}:${row.refId}`);

    if (!item) return { number, ok: false, text: `${label}: já foi decidido.` };

    if (action === 'text' && !source.text) {
      return {
        number,
        ok: false,
        text: `${label}: aqui não cabe texto. Responda "ok ${number}" ou "não ${number}: motivo".`,
      };
    }

    try {
      const said =
        action === 'ok'
          ? await source.ok(item, via, chat)
          : action === 'no'
            ? await source.no(item, text, via, chat)
            : await (source.text as NonNullable<InboxSource['text']>)(item, text ?? '', via, chat);

      await this.store.db
        .update(inbox)
        .set({ closedAt: new Date(this.clock()), decidedVia: via })
        .where(eq(inbox.number, number));

      return { number, ok: true, text: `${label}: ${said}` };
    } catch (error) {
      return { number, ok: false, text: `${label}: não deu certo. ${failure(error)}` };
    }
  }

  /** Minutes from waiting to decided, by kind, for what the owner decided in 30 days. */
  async stats(): Promise<InboxStat[]> {
    const since = new Date(this.clock() - STATS_DAYS * DAY);
    const rows = await this.store.db
      .select({
        kind: inbox.kind,
        decided: sql<number>`count(*)`,
        median: sql<
          number | null
        >`percentile_cont(0.5) within group (order by extract(epoch from (${inbox.closedAt} - ${inbox.openedAt})) / 60)`,
      })
      .from(inbox)
      .where(and(isNotNull(inbox.decidedVia), gte(inbox.closedAt, since)))
      .groupBy(inbox.kind);

    return rows.map((row) => ({
      kind: row.kind as InboxKind,
      decided: Number(row.decided),
      ...(row.median === null || row.median === undefined
        ? {}
        : { medianMinutes: Math.round(Number(row.median)) }),
    }));
  }

  /** What the agent reads when the owner answered the inbox in a chat. */
  static notice(outcomes: InboxOutcome[]) {
    return [
      '[Caixa] O Moabe respondeu:',
      ...outcomes.map((outcome) => `- ${outcome.text}`),
      'Confirme em uma linha o que foi feito e o que não deu certo.',
    ].join('\n');
  }
}
