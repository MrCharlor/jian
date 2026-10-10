import { randomUUID } from 'node:crypto';
import {
  type EpicDraft,
  epicDraftInputSchema,
  epicDraftPatchSchema,
  type epicImageSchema,
} from '@jian/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { WorkClient, WorkClientOpener } from '../priorities/work-board.js';
import type { Quality } from '../quality/service.js';
import type { Store } from '../storage/database.js';
import { epicDrafts, pautas } from '../storage/schema.js';
import { lintDraft } from './lint.js';
import type { EpicTarget } from './target.js';

type Row = typeof epicDrafts.$inferSelect;
type Image = z.infer<typeof epicImageSchema>;
type Task = { title: string; label: string; description: string; criteria: string[] };

/** An epic titled as an integration test is created like any other, but nobody is asked to act. */
const INTEGRATION_TEST = /teste de integra[çc][ãa]o/i;
type Work = EpicDraft['work'];

/** The automation the owner's edits are counted against in Quality. */
export const EPIC_AUTOMATION = 'epico';

/** Where an image goes in the text: before "Esperado" in the epic, before the rules in a task. */
function withImages(text: string, images: Array<{ id: string; caption: string }>, before: string) {
  if (!images.length) return text;

  const block = images
    .map((image) => `![${image.caption}](vx-attachment:image/${image.id})`)
    .join('\n\n');
  const marker = text.search(new RegExp(`^##\\s+${before}`, 'm'));

  return marker < 0
    ? `${text}\n\n${block}`
    : `${text.slice(0, marker)}${block}\n\n${text.slice(marker)}`;
}

const outline = (draft: { title: string; tasks: Task[] }) =>
  [draft.title, ...draft.tasks.map((task, index) => `${index + 1}. ${task.title}`)].join('\n');

/**
 * Epics and their tasks, drafted by an agent from a topic and written on the board only when
 * the owner says so. The rules the owner set are checked on every draft; what the owner changed
 * before creating counts as a correction of the agent that wrote it.
 */
export class Epics {
  private remember?: (profileId: string, key: string, content: string) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private readonly open: WorkClientOpener,
    private readonly keyProfile: () => Promise<string | undefined>,
    private readonly target: EpicTarget,
    private readonly fetcher: typeof fetch,
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(hooks: { remember: NonNullable<Epics['remember']> }) {
    this.remember = hooks.remember;
  }

  private present(row: Row, pauta?: string | null): EpicDraft {
    return {
      id: row.id,
      number: row.number,
      pautaId: row.pautaId,
      ...(pauta ? { pauta } : {}),
      state: row.state as EpicDraft['state'],
      ...(row.requestWorkId ? { requestWorkId: row.requestWorkId } : {}),
      title: row.title,
      label: row.label as EpicDraft['label'],
      description: row.description,
      ...(row.prototypeUrl ? { prototypeUrl: row.prototypeUrl } : {}),
      tasks: row.tasks as EpicDraft['tasks'],
      images: row.images.map(({ data: _data, ...image }) => image),
      problems: row.problems,
      work: {
        ...row.work,
        ...(row.work.epicId
          ? {
              epicUrl: `${this.target.webUrl}/w/${this.target.workspaceId}/b/${this.target.boardId}?activity=${row.work.epicId}`,
            }
          : {}),
      },
      ...(row.error ? { error: row.error } : {}),
      ...(row.proposedBy ? { proposedBy: row.proposedBy } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async row(which: { id: string } | { number: number }): Promise<Row> {
    const [row] = await this.store.db
      .select()
      .from(epicDrafts)
      .where('id' in which ? eq(epicDrafts.id, which.id) : eq(epicDrafts.number, which.number));

    return assertFound(row, 'Epic draft');
  }

  async get(which: { id: string } | { number: number }): Promise<EpicDraft> {
    const row = await this.row(which);
    const [pauta] = await this.store.db
      .select({ title: pautas.title })
      .from(pautas)
      .where(eq(pautas.id, row.pautaId));

    return this.present(row, pauta?.title);
  }

  async list(pautaId?: string): Promise<EpicDraft[]> {
    const rows = await this.store.db
      .select({ row: epicDrafts, pauta: pautas.title })
      .from(epicDrafts)
      .leftJoin(pautas, eq(pautas.id, epicDrafts.pautaId))
      .where(pautaId ? eq(epicDrafts.pautaId, pautaId) : undefined)
      .orderBy(desc(epicDrafts.createdAt))
      .limit(100);

    return rows.map(({ row, pauta }) => this.present(row, pauta));
  }

  /** An agent's draft, checked against the owner's rules; nothing reaches the board. */
  async draft(
    input: unknown,
    by?: { profileId: string; sessionId: string; name: string },
  ): Promise<EpicDraft> {
    const data = epicDraftInputSchema.parse(input);
    const [pauta] = await this.store.db
      .select({ id: pautas.id })
      .from(pautas)
      .where(eq(pautas.id, data.pautaId));

    assertFound(pauta, 'Pauta');

    const now = new Date(this.clock());
    const id = randomUUID();

    await this.store.transaction('epic_drafts', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${epicDrafts.number}), 0)` })
        .from(epicDrafts);

      await tx.insert(epicDrafts).values({
        id,
        number: Number(top?.max ?? 0) + 1,
        pautaId: data.pautaId,
        state: 'rascunho',
        requestWorkId: data.requestWorkId ?? null,
        title: data.title,
        label: data.label,
        description: data.description,
        prototypeUrl: data.prototypeUrl ?? null,
        tasks: data.tasks,
        images: [],
        problems: lintDraft({ ...data, images: [] }),
        original: { title: data.title, description: data.description, tasks: data.tasks },
        work: { taskIds: [], linked: false, announced: false },
        proposedBy: by?.name ?? null,
        profileId: by?.profileId ?? null,
        sessionId: by?.sessionId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    });

    return this.get({ id });
  }

  /** The owner's edits; the rules are checked again on what is there now. */
  async update(id: string, input: unknown): Promise<EpicDraft> {
    const data = epicDraftPatchSchema.parse(input);
    const row = await this.row({ id });

    if (row.state !== 'rascunho') {
      throw new GatewayError(409, `Draft #${row.number} is already ${row.state}`);
    }

    const next = {
      title: data.title ?? row.title,
      label: data.label ?? row.label,
      description: data.description ?? row.description,
      requestWorkId: data.requestWorkId ?? row.requestWorkId,
      prototypeUrl: data.prototypeUrl ?? row.prototypeUrl,
      tasks: data.tasks ?? row.tasks,
      images: [...row.images, ...(data.addImages ?? [])].slice(0, 12),
    };

    await this.store.db
      .update(epicDrafts)
      .set({ ...next, problems: lintDraft(next), updatedAt: new Date(this.clock()) })
      .where(eq(epicDrafts.id, id));

    return this.get({ id });
  }

  async discard(id: string): Promise<EpicDraft> {
    const row = await this.row({ id });

    if (row.state !== 'rascunho') {
      throw new GatewayError(409, `Draft #${row.number} is already ${row.state}`);
    }

    await this.store.db
      .update(epicDrafts)
      .set({ state: 'descartado', updatedAt: new Date(this.clock()) })
      .where(eq(epicDrafts.id, id));

    if (row.profileId) {
      await this.quality?.record(this.store.db, row.profileId, {
        kind: 'rejected',
        via: 'panel',
        action: EPIC_AUTOMATION,
        original: outline(row),
      });
    }

    return this.get({ id });
  }

  /**
   * Writes the epic and its tasks on the board, step by step, keeping what was made: a create
   * that stops half way goes on from where it stopped, and never makes a card twice.
   */
  async create(id: string): Promise<EpicDraft> {
    const row = await this.row({ id });

    if (row.state !== 'rascunho') {
      throw new GatewayError(409, `Draft #${row.number} is already ${row.state}`);
    }

    const profileId = await this.keyProfile();

    if (!profileId) throw new GatewayError(409, 'No agent reaches the work tracker');

    const client = await this.open(profileId, { workspaceId: this.target.workspaceId });
    const work: Work = { ...row.work, taskIds: [...row.work.taskIds] };
    const save = (patch: Partial<typeof epicDrafts.$inferInsert>) =>
      this.store.db
        .update(epicDrafts)
        .set({ ...patch, work, updatedAt: new Date(this.clock()) })
        .where(eq(epicDrafts.id, id));

    try {
      if (!work.epicId) {
        work.epicId = await this.card(client, {
          title: row.title,
          label: row.label,
          description: row.description,
          images: row.images.filter((image) => image.task === undefined),
          before: 'Esperado',
          prototypeUrl: row.prototypeUrl ?? undefined,
        });
        await save({});
      }

      for (const [index, task] of row.tasks.entries()) {
        if (work.taskIds[index]) continue;

        const taskId = await this.card(client, {
          title: task.title,
          label: task.label,
          description: task.description,
          images: row.images.filter((image) => image.task === index),
          before: 'Regras de negócio',
          parentId: work.epicId,
        });

        for (const criterion of task.criteria) {
          await client.call('POST', `/activities/${taskId}/checklist`, { text: criterion });
        }

        work.taskIds[index] = taskId;
        await save({});
      }

      if (row.requestWorkId && !work.linked) {
        await client.call('POST', `/activities/${row.requestWorkId}/relationships`, {
          relation_type: 'depends_on',
          target_id: work.epicId,
        });
        work.linked = true;
        await save({});
      }

      if (this.target.lead && !work.announced) {
        const { id: leadId, name } = this.target.lead;
        // Whoever is mentioned must see at once that a test epic asks nothing of them.
        const body = INTEGRATION_TEST.test(row.title)
          ? `@[${name}](mention:${leadId}) teste de integração da Atena, não é trabalho real: não precisa assumir, criar branch nem espelhar. Pode ignorar.`
          : `@[${name}](mention:${leadId}) épico pronto para você assumir, com ${row.tasks.length} task${row.tasks.length === 1 ? '' : 's'}. Pode preencher os campos, criar a branch e espelhar as tasks.`;

        await client.call('POST', `/activities/${work.epicId}/comments`, { body });
        work.announced = true;
      }

      await save({ state: 'criado', error: null });
    } catch (failure) {
      await save({
        error: (failure instanceof Error ? failure.message : String(failure)).slice(0, 2000),
      });
      throw failure;
    }

    await this.learn(row);

    return this.get({ id });
  }

  /** What the owner changed in the agent's draft is a correction, and the agent remembers it. */
  private async learn(row: Row) {
    const original = row.original as { title: string; description: string; tasks: Task[] };
    const changed = [
      original.title !== row.title ? 'título do épico' : '',
      original.description !== row.description ? 'texto do épico' : '',
      original.tasks.length !== row.tasks.length
        ? `número de tasks (${original.tasks.length} para ${row.tasks.length})`
        : '',
      ...row.tasks.map((task, index) => {
        const before = original.tasks[index];
        return before &&
          (before.title !== task.title ||
            before.description !== task.description ||
            before.criteria.join('\n') !== task.criteria.join('\n'))
          ? `task ${index + 1}`
          : '';
      }),
    ].filter(Boolean);

    if (!changed.length || !row.profileId) return;

    await this.quality?.record(this.store.db, row.profileId, {
      kind: 'edited',
      via: 'panel',
      action: EPIC_AUTOMATION,
      original: outline(original),
      corrected: outline(row),
      note: `O Moabe mudou: ${changed.join(', ')}.`,
    });
    await this.remember?.(
      row.profileId,
      `epico-${row.number}`,
      `Épico #${row.number} ("${row.title}"): o Moabe mudou ${changed.join(', ')} antes de criar no Work. Versão aplicada:\n${outline(row)}`,
    ).catch(() => {});
  }

  /** One card on the board: created, given the team, then its images placed in the text. */
  private async card(
    client: WorkClient,
    card: {
      title: string;
      label: string;
      description: string;
      images: Image[];
      before: string;
      parentId?: string;
      prototypeUrl?: string;
    },
  ): Promise<string> {
    const label = this.target.labels[card.label];
    const created = (await client.call('POST', '/activities', {
      board_id: this.target.boardId,
      status_id: this.target.todoStatusId,
      title: card.title,
      description: card.description,
      ...(card.parentId ? { parent_id: card.parentId } : {}),
      ...(label ? { label_ids: [label] } : {}),
      custom_field_values: [
        { field_id: this.target.requesterFieldId, value: this.target.requester },
        ...(card.prototypeUrl
          ? [{ field_id: this.target.prototypeFieldId, value: card.prototypeUrl }]
          : []),
      ],
    })) as { id: string; version: number };
    let version = created.version;
    const teamed = (await client.call('PATCH', `/activities/${created.id}`, {
      team_id: this.target.teamId,
      expected_version: version,
    })) as { version: number };

    version = teamed.version;

    if (card.images.length) {
      const placed: Array<{ id: string; caption: string }> = [];

      for (const image of card.images) {
        placed.push({ id: await this.upload(client, created.id, image), caption: image.caption });
      }

      await client.call('PATCH', `/activities/${created.id}`, {
        description: withImages(card.description, placed, card.before),
        expected_version: version,
      });
    }

    return created.id;
  }

  /** An attachment in three steps: ask where, send the bytes there, then close it. */
  private async upload(client: WorkClient, activityId: string, image: Image): Promise<string> {
    const bytes = Buffer.from(image.data, 'base64');
    const intent = (await client.call(
      'POST',
      `/activities/${activityId}/attachments/upload-intent`,
      {
        file_name: image.name,
        content_type: image.contentType,
        byte_size: bytes.length,
      },
    )) as {
      attachment: { id: string };
      upload: { url: string; method: string; headers: Record<string, string> };
    };
    const sent = await this.fetcher(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: new Uint8Array(bytes),
    });

    if (!sent.ok) throw new GatewayError(502, `The attachment upload answered ${sent.status}`);

    await client.call(
      'POST',
      `/activities/${activityId}/attachments/${intent.attachment.id}/complete`,
      {},
    );

    return intent.attachment.id;
  }
}
