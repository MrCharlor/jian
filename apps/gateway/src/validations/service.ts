import { randomUUID } from 'node:crypto';
import {
  type ReturnDraft,
  returnDraftPatchSchema,
  type Validation,
  validationAnswerSchema,
} from '@jian/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { lintReturn, lintTask } from '../epics/lint.js';
import type { EpicTarget } from '../epics/target.js';
import type { WorkClient, WorkClientOpener } from '../priorities/work-board.js';
import type { Quality } from '../quality/service.js';
import type { Store } from '../storage/database.js';
import { pautas, returnReviews, validations } from '../storage/schema.js';

type Row = typeof validations.$inferSelect;
type Via = 'panel' | 'channel' | 'api';
type StoredReturn = ReturnDraft & { original: string; linked?: boolean; mirrored?: boolean };

/** What the validation reads besides the epic board. */
export type ValidationTarget = EpicTarget & {
  tasksBoardId: string;
  awaitingLabel: string;
  returnedLabel: string;
  previewFieldId: string;
};

type Activity = {
  id: string;
  title: string;
  description?: string;
  version: number;
  updated_at: string;
  created_at: string;
  labels: Array<{ id: string; name: string }>;
  custom_field_values?: Array<{ field_id: string; value: unknown }>;
  parent_id?: string | null;
};

/** The automation the owner's checks are counted in. */
export const VALIDATION_AUTOMATION = 'validacao';

const HOUR = 3_600_000;

/** The items of a "## Pronto quando" section: one per list line, or the whole text. */
export function doneWhen(description: string): string[] {
  const lines = description.split('\n');
  const start = lines.findIndex((line) => /^##\s+pronto quando/i.test(line.trim()));

  if (start < 0) return [];

  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.trim());
  const items = body
    .filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim());

  return items.length ? items : body.length ? [body.join(' ').trim()] : [];
}

const fieldText = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object' && 'url' in value
      ? String((value as { url: unknown }).url)
      : undefined;

/**
 * The owner's check of what the tester passed. Ready epics are found on the board, their "done
 * when" turned into items, and the owner's answer becomes a comment on the epic and, for each
 * failed item, a return card the owner creates on the board.
 */
export class Validations {
  private notify?: (text: string) => Promise<unknown>;
  private lastScan = 0;
  private scanning?: Promise<{ prepared: number[]; reviewed: number }>;

  constructor(
    private readonly store: Store,
    private readonly open: WorkClientOpener,
    private readonly keyProfile: () => Promise<string | undefined>,
    private readonly target: ValidationTarget,
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useOwner(notify: (text: string) => Promise<unknown>) {
    this.notify = notify;
  }

  private cardUrl(id: string, board = this.target.boardId) {
    return `${this.target.webUrl}/w/${this.target.workspaceId}/b/${board}?activity=${id}`;
  }

  private present(row: Row, pauta?: string | null): Validation {
    return {
      id: row.id,
      number: row.number,
      epicWorkId: row.epicWorkId,
      epicTitle: row.epicTitle,
      epicUrl: this.cardUrl(row.epicWorkId),
      ...(row.previewUrl ? { previewUrl: row.previewUrl } : {}),
      ...(row.prototypeUrl ? { prototypeUrl: row.prototypeUrl } : {}),
      ...(row.pautaId ? { pautaId: row.pautaId } : {}),
      ...(pauta ? { pauta } : {}),
      items: row.items,
      tasks: row.tasks,
      notes: row.notes,
      state: row.state as Validation['state'],
      commented: row.commented,
      returns: row.returns.map(({ original: _o, linked: _l, mirrored: _m, ...draft }) => draft),
      ...(row.decidedVia ? { decidedVia: row.decidedVia as Via } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async row(which: { id: string } | { number: number }) {
    const [row] = await this.store.db
      .select()
      .from(validations)
      .where('id' in which ? eq(validations.id, which.id) : eq(validations.number, which.number));

    return assertFound(row, 'Validation');
  }

  async get(which: { id: string } | { number: number }): Promise<Validation> {
    const row = await this.row(which);
    const [pauta] = row.pautaId
      ? await this.store.db
          .select({ title: pautas.title })
          .from(pautas)
          .where(eq(pautas.id, row.pautaId))
      : [];

    return this.present(row, pauta?.title);
  }

  async list(): Promise<Validation[]> {
    const rows = await this.store.db
      .select({ row: validations, pauta: pautas.title })
      .from(validations)
      .leftJoin(pautas, eq(pautas.id, validations.pautaId))
      .orderBy(desc(validations.createdAt))
      .limit(60);

    return rows.map(({ row, pauta }) => this.present(row, pauta));
  }

  private async client(): Promise<WorkClient> {
    const profileId = await this.keyProfile();

    if (!profileId) throw new GatewayError(409, 'No agent reaches the work tracker');

    return this.open(profileId, { workspaceId: this.target.workspaceId });
  }

  /** On the worker's tick: at most once an hour, from 8h to 19h in Brasília. */
  async tick(): Promise<void> {
    const now = this.clock();
    const hour = new Date(now - 3 * HOUR).getUTCHours();

    if (hour < 8 || hour >= 19 || now - this.lastScan < HOUR) return;

    this.lastScan = now;
    await this.scan();
  }

  /** Finds epics waiting for the owner and return cards to check; tells the owner once. */
  scan(): Promise<{ prepared: number[]; reviewed: number }> {
    // The hourly look and a look the owner asked for share one run, so nothing opens twice.
    this.scanning ??= this.look().finally(() => {
      this.scanning = undefined;
    });

    return this.scanning;
  }

  private async look(): Promise<{ prepared: number[]; reviewed: number }> {
    const client = await this.client();
    const epics = (await client.call(
      'GET',
      `/boards/${this.target.boardId}/activities`,
    )) as Activity[];
    const prepared: number[] = [];

    for (const epic of epics) {
      if (!epic.labels.some((label) => label.id === this.target.awaitingLabel)) continue;

      const [latest] = await this.store.db
        .select()
        .from(validations)
        .where(eq(validations.epicWorkId, epic.id))
        .orderBy(desc(validations.createdAt))
        .limit(1);
      const again =
        latest?.state !== 'aberta' &&
        latest?.decidedAt &&
        Date.parse(epic.updated_at) > latest.decidedAt.getTime() + 60_000;

      if (latest && !again) continue;

      prepared.push((await this.prepare(client, epic.id)).number);
    }

    const problems = await this.reviewReturns(client);
    const lines = [
      ...(prepared.length
        ? [
            `${prepared.length} épico(s) prontos para a sua validação (validação ${prepared.map((number) => `#${number}`).join(', ')}). Abra em Validações, no painel.`,
          ]
        : []),
      ...problems,
    ];

    if (lines.length) {
      await this.notify?.(`[Validação] ${lines.join('\n')}`).catch(() => {});
    }

    return { prepared, reviewed: problems.length };
  }

  /** The return cards on the tasks board not seen yet; the first look only takes note of them. */
  private async reviewReturns(client: WorkClient): Promise<string[]> {
    const cards = (
      (await client.call('GET', `/boards/${this.target.tasksBoardId}/activities`)) as Activity[]
    ).filter((card) => card.labels.some((label) => label.id === this.target.returnedLabel));
    const seen = new Set(
      (await this.store.db.select({ id: returnReviews.workId }).from(returnReviews)).map(
        (row) => row.id,
      ),
    );
    const baseline = seen.size === 0;
    const lines: string[] = [];

    for (const card of cards) {
      if (seen.has(card.id)) continue;

      let problems: string[] = [];

      if (!baseline) {
        const full = (await client.call('GET', `/activities/${card.id}`)) as Activity;
        const checklist = (await client.call('GET', `/activities/${card.id}/checklist`)) as Array<{
          text: string;
        }>;
        const relations = (await client.call('GET', `/activities/${card.id}/relationships`)) as {
          relationships: Array<{ relation_type: string; direction: string }>;
        };

        problems = lintReturn({
          title: full.title,
          description: full.description ?? '',
          criteria: checklist.map((item) => item.text),
          labels: full.labels.map((label) => label.name),
          dependsOn: relations.relationships.some(
            (relation) => relation.relation_type === 'depends_on' && relation.direction === 'out',
          ),
        });

        if (problems.length) {
          lines.push(
            `Retorno do Tester fora do modelo: "${full.title}" (${this.cardUrl(card.id, this.target.tasksBoardId)}): ${problems.join(' ')}`,
          );
        }
      }

      await this.store.db
        .insert(returnReviews)
        .values({ workId: card.id, problems, createdAt: new Date(this.clock()) })
        .onConflictDoNothing();
    }

    return lines;
  }

  /** Reads the epic, its tasks and what was said about them, and opens a validation. */
  async prepare(client: WorkClient, epicId: string): Promise<Validation> {
    const epic = (await client.call('GET', `/activities/${epicId}`)) as Activity;
    const subtasks = (await client.call('GET', `/activities/${epicId}/subtasks`)) as
      | Activity[]
      | { subtasks: Activity[] };
    const tasks = Array.isArray(subtasks) ? subtasks : subtasks.subtasks;
    const field = (id: string) =>
      fieldText(epic.custom_field_values?.find((value) => value.field_id === id)?.value);
    const notes: Array<{ at: string; text: string }> = [];
    const taskViews: Validation['tasks'] = [];

    for (const card of [epic, ...tasks]) {
      const comments = (await client.call('GET', `/activities/${card.id}/comments`)) as
        | Array<{ body: string; created_at: string }>
        | { comments: Array<{ body: string; created_at: string }> };
      const list = Array.isArray(comments) ? comments : comments.comments;

      for (const comment of list.slice(-3)) {
        notes.push({
          at: comment.created_at,
          text: `${card.title}: ${comment.body}`.slice(0, 600),
        });
      }
    }

    for (const task of tasks) {
      const checklist = (await client.call('GET', `/activities/${task.id}/checklist`)) as Array<{
        text: string;
        done: boolean;
      }>;

      taskViews.push({
        id: task.id,
        title: task.title,
        checklist: checklist.map(({ text, done }) => ({ text, done })),
      });
    }

    const all = await this.store.db.select({ id: pautas.id, links: pautas.links }).from(pautas);
    const pauta = all.find((item) => item.links.some((link) => link.workId === epicId));
    const items = doneWhen(epic.description ?? '');
    const now = new Date(this.clock());
    const id = randomUUID();

    await this.store.transaction('validations', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${validations.number}), 0)` })
        .from(validations);

      await tx.insert(validations).values({
        id,
        number: Number(top?.max ?? 0) + 1,
        epicWorkId: epicId,
        epicTitle: epic.title,
        previewUrl: field(this.target.previewFieldId) ?? null,
        prototypeUrl: field(this.target.prototypeFieldId) ?? null,
        pautaId: pauta?.id ?? null,
        items: (items.length ? items : [epic.title]).map((text) => ({ text })),
        tasks: taskViews,
        notes: notes
          .sort((a, b) => b.at.localeCompare(a.at))
          .slice(0, 12)
          .map((note) => note.text),
        state: 'aberta',
        commented: false,
        returns: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    return this.get({ id });
  }

  /**
   * The owner's answer. It goes on the epic as a comment at once, since the answer is the
   * approval; each failed item gets a return card draft, created only when the owner says so.
   */
  async answer(which: { id: string } | { number: number }, input: unknown, via: Via) {
    const data = validationAnswerSchema.parse(input);
    const row = await this.row(which);

    if (row.state !== 'aberta') {
      throw new GatewayError(409, `Validation #${row.number} is already ${row.state}`);
    }

    const items = row.items.map((item, index) => {
      const answer = data.items[index];
      return answer
        ? {
            ...item,
            result: answer.result,
            ...(answer.reason ? { reason: answer.reason } : {}),
            ...(answer.taskId ? { taskId: answer.taskId } : {}),
          }
        : item;
    });
    const failed = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => item.result === 'falhou');
    const approved = failed.length === 0;
    const now = new Date(this.clock());
    const comment = approved
      ? [
          'Aprovado na validação do PO. Verifiquei no preview:',
          ...items.map((item) => `- ${item.text}`),
          ...(data.note ? ['', data.note] : []),
        ].join('\n')
      : [
          'Reprovado na validação do PO:',
          ...failed.map(({ item }) => `- ${item.text}: ${item.reason ?? 'não passou'}`),
          ...(data.note ? ['', data.note] : []),
          '',
          'Os cards de retorno vêm em seguida.',
        ].join('\n');
    const returns: StoredReturn[] = failed.map(({ item, index }) =>
      this.returnDraft(row, item, index),
    );

    await this.store.db
      .update(validations)
      .set({
        items,
        state: approved ? 'aprovada' : 'reprovada',
        returns,
        decidedVia: via,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(validations.id, row.id));

    const client = await this.client();

    await client.call('POST', `/activities/${row.epicWorkId}/comments`, { body: comment });
    await this.store.db
      .update(validations)
      .set({ commented: true })
      .where(eq(validations.id, row.id));

    return this.get({ id: row.id });
  }

  private returnDraft(
    row: Row,
    item: { text: string; reason?: string; taskId?: string },
    index: number,
  ): StoredReturn {
    const taskId = item.taskId ?? row.tasks[0]?.id ?? '';
    const task = row.tasks.find((entry) => entry.id === taskId);
    const short = item.text.replace(/\.$/, '').slice(0, 90);
    const description = [
      '## Contexto',
      `Retorno da validação do PO no épico "${row.epicTitle}". O item do Pronto quando que não passou: ${item.text}`,
      '',
      '## Hoje',
      `**Preview:** ${row.previewUrl ?? 'não informado no épico'}`,
      '',
      `**Aconteceu:** ${item.reason ?? 'não passou na validação'}`,
      '',
      `**Esperado:** ${item.text}`,
      '',
      '## Regras de negócio',
      `1. **RN-1**: ${item.text}`,
      '',
      '## Referências técnicas',
      `- **Épico:** ${this.cardUrl(row.epicWorkId)}`,
      `- **Retorno de:** ${task ? `${task.title} (${this.cardUrl(task.id)})` : 'escolha a task original'}`,
    ].join('\n');
    const draft = {
      item: index,
      taskId,
      title: `Corrigir: ${short}`,
      label: 'bugfix' as const,
      description,
      criteria: [`CA-1 (RN-1): ${item.text}`, 'make test-web passa'],
      state: 'rascunho' as const,
    };

    return {
      ...draft,
      problems: this.returnProblems(draft),
      original: JSON.stringify([draft.title, draft.description, draft.criteria]),
    };
  }

  private returnProblems(draft: {
    taskId: string;
    title: string;
    description: string;
    criteria: string[];
  }) {
    return [
      ...lintTask(draft, 'Retorno'),
      ...(draft.taskId ? [] : ['Escolha a task original do retorno.']),
    ];
  }

  async updateReturn(id: string, index: number, input: unknown): Promise<Validation> {
    const data = returnDraftPatchSchema.parse(input);
    const row = await this.row({ id });
    const current = assertFound(row.returns[index] as StoredReturn | undefined, 'Return draft');

    if (current.state !== 'rascunho') throw new GatewayError(409, 'This return is already created');

    const next = { ...current, ...data };
    const returns = [...row.returns] as StoredReturn[];

    returns[index] = { ...next, problems: this.returnProblems(next) };

    await this.store.db
      .update(validations)
      .set({ returns, updatedAt: new Date(this.clock()) })
      .where(eq(validations.id, id));

    return this.get({ id });
  }

  /**
   * Creates one return card: a task of the same epic, in "to do", depending on the original,
   * with the return and type labels; mirrored on the tasks board at the top of its column.
   */
  async createReturn(id: string, index: number): Promise<Validation> {
    const row = await this.row({ id });
    const returns = [...row.returns] as StoredReturn[];
    const draft = assertFound(returns[index], 'Return draft');

    if (draft.state !== 'rascunho') throw new GatewayError(409, 'This return is already created');
    if (!draft.taskId) throw new GatewayError(409, 'Choose the original task first');

    const client = await this.client();
    const save = () =>
      this.store.db
        .update(validations)
        .set({ returns, updatedAt: new Date(this.clock()) })
        .where(eq(validations.id, id));

    try {
      if (!draft.workId) {
        const typeLabel = this.target.labels[draft.label];
        const created = (await client.call('POST', '/activities', {
          board_id: this.target.boardId,
          status_id: this.target.todoStatusId,
          parent_id: row.epicWorkId,
          title: draft.title,
          description: draft.description,
          label_ids: [this.target.returnedLabel, ...(typeLabel ? [typeLabel] : [])],
          custom_field_values: [
            { field_id: this.target.requesterFieldId, value: this.target.requester },
          ],
        })) as { id: string; version: number };

        await client.call('PATCH', `/activities/${created.id}`, {
          team_id: this.target.teamId,
          expected_version: created.version,
        });

        for (const criterion of draft.criteria) {
          await client.call('POST', `/activities/${created.id}/checklist`, { text: criterion });
        }

        draft.workId = created.id;
        await save();
      }

      if (!draft.linked) {
        await client.call('POST', `/activities/${draft.workId}/relationships`, {
          relation_type: 'depends_on',
          target_id: draft.taskId,
        });
        draft.linked = true;
        await save();
      }

      if (!draft.mirrored) {
        const mirror = (await client.call('POST', `/activities/${draft.workId}/boards`, {
          board_id: this.target.tasksBoardId,
        })) as { version?: number } | undefined;
        const column = (await client.call(
          'GET',
          `/boards/${this.target.tasksBoardId}/activities/column?status_id=${this.target.todoStatusId}&limit=2`,
        )) as { items: Array<{ id: string; version: number }> };
        const top = column.items.find((card) => card.id !== draft.workId);
        const self = column.items.find((card) => card.id === draft.workId);

        if (top && column.items[0]?.id !== draft.workId) {
          await client.call(
            'POST',
            `/activities/${draft.workId}/boards/${this.target.tasksBoardId}/move`,
            {
              status_id: this.target.todoStatusId,
              before_activity_id: null,
              after_activity_id: top.id,
              expected_version: self?.version ?? mirror?.version ?? 1,
            },
          );
        }

        draft.mirrored = true;
      }

      draft.state = 'criado';
      draft.error = undefined;
      await save();
    } catch (failure) {
      draft.error = (failure instanceof Error ? failure.message : String(failure)).slice(0, 1000);
      await save();
      throw failure;
    }

    if (draft.original !== JSON.stringify([draft.title, draft.description, draft.criteria])) {
      const profileId = await this.keyProfile();

      if (profileId) {
        await this.quality?.record(this.store.db, profileId, {
          kind: 'edited',
          via: 'panel',
          action: VALIDATION_AUTOMATION,
          original: draft.original,
          corrected: JSON.stringify([draft.title, draft.description, draft.criteria]),
          note: 'O Moabe editou o card de retorno antes de criar.',
        });
      }
    }

    return this.get({ id });
  }

  /** "aprovado" or "reprovado: motivo" from the owner in a chat, for one open validation. */
  async fromChat(reply: { number?: number; approved: boolean; reason?: string }) {
    const open = reply.number
      ? [await this.row({ number: reply.number })]
      : await this.store.db.select().from(validations).where(eq(validations.state, 'aberta'));

    if (open.length !== 1) return undefined;

    const row = assertFound(open[0], 'Validation');

    // Checked here too: the item added below must not land on a validation already answered.
    if (row.state !== 'aberta') {
      throw new GatewayError(409, `Validation #${row.number} is already ${row.state}`);
    }

    if (reply.approved) {
      return this.answer(
        { id: row.id },
        { items: row.items.map(() => ({ result: 'passou' as const })) },
        'channel',
      );
    }

    // One item: the reason is about it, and its text is what the return card expects.
    if (row.items.length === 1) {
      return this.answer(
        { id: row.id },
        {
          items: [{ result: 'falhou' as const, ...(reply.reason ? { reason: reply.reason } : {}) }],
        },
        'channel',
      );
    }

    // Several items and one reason: the chat does not say which item failed.
    await this.store.db
      .update(validations)
      .set({ items: [...row.items, { text: 'Reprovado pelo PO no chat' }] })
      .where(eq(validations.id, row.id));

    return this.answer(
      { id: row.id },
      {
        items: [
          ...row.items.map(() => ({ result: 'passou' as const })),
          { result: 'falhou' as const, ...(reply.reason ? { reason: reply.reason } : {}) },
        ],
      },
      'channel',
    );
  }

  /** What an agent reads when the owner answered in a chat. */
  static notice(validation: Validation) {
    return validation.state === 'aprovada'
      ? `[Validação #${validation.number}] O Moabe aprovou "${validation.epicTitle}"; o comentário Aprovado já está no épico.`
      : `[Validação #${validation.number}] O Moabe reprovou "${validation.epicTitle}"; o motivo está no épico e o card de retorno espera ele em Validações, no painel.`;
  }
}
