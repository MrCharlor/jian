import { randomUUID } from 'node:crypto';
import {
  type Application,
  type RoadmapDraft,
  type RoadmapItem,
  type RoadmapKind,
  type RoadmapLane,
  type RoadmapNote,
  type RoadmapOrigin,
  type RoadmapProposal,
  type RoadmapProposalKind,
  type RoadmapReply,
  type RoadmapRunResult,
  type RoadmapSettings,
  type RoadmapState,
  type RoadmapSyncResult,
  roadmapDecideSchema,
  roadmapDraftSchema,
  roadmapItemCreateSchema,
  roadmapItemPatchSchema,
  roadmapListQuerySchema,
  roadmapProposalInputSchema,
  roadmapProposalListQuerySchema,
  roadmapRunSchema,
  roadmapSettingsPatchSchema,
  roadmapSettingsSchema,
  roadmapSyncInputSchema,
} from '@jian/contracts';
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { noDashes } from '../core/wording.js';
import type { EntryTarget } from '../epics/target.js';
import type { Lesson } from '../knowledge/service.js';
import type { WorkClientOpener } from '../priorities/work-board.js';
import { boardColumns, columnCards, dependsOn } from '../priorities/work-readers.js';
import type { Quality } from '../quality/service.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  gatewaySettings,
  pautas,
  profiles,
  roadmapItems,
  roadmapProposals,
} from '../storage/schema.js';

type ItemRow = typeof roadmapItems.$inferSelect;
type ProposalRow = typeof roadmapProposals.$inferSelect;
type Via = 'panel' | 'channel' | 'api';

/** How the gateway reaches the Estrategista. */
export type RoadmapAgents = {
  submit(profileId: string, sessionId: string, text: string, key: string): Promise<unknown>;
  /** The agent's conversation of that title, found or opened. */
  session(profileId: string, title: string): Promise<{ id: string }>;
  /** A memory of the agent's, such as a suggestion the owner refused and why. */
  remember?(profileId: string, key: string, content: string): Promise<unknown>;
};

/** What "roadmap: <ideia>" gave: the item, or the one-line question back. */
export type RoadmapNoteResult = { item: RoadmapItem } | { question: string };

/** What "ok roadmap 1-12" decided, and what it could not. */
export type RoadmapChatResult = {
  proposals: RoadmapProposal[];
  failed: Array<{ number: number; why: string }>;
};

/** The automation the owner's corrections of the roadmap are counted in. */
export const ROADMAP_AUTOMATION = 'roadmap';

const SETTINGS_KEY = 'roadmap';

const DEFAULTS: RoadmapSettings = {
  automaticMoves: false,
  suggestionsPerRound: 3,
  applications: ['erp', 'app-gestores'],
};

const DAY = 86_400_000;
/** A suggestion the owner refused is not made again for this long. */
const REPEAT_DAYS = 60;

const READING_SESSION = 'Roadmap · leitura';
const SUGGESTIONS_SESSION = 'Roadmap · sugestões';

/** Agora is the furthest forward. */
const RANK: Record<RoadmapLane, number> = { agora: 0, proximo: 1, depois: 2 };

export const LANE_LABEL: Record<RoadmapLane, string> = {
  agora: 'Agora',
  proximo: 'Próximo',
  depois: 'Depois',
};

const KIND_LABEL: Record<RoadmapProposalKind, string> = {
  incluir: 'incluir',
  mover: 'mover',
  concluir: 'concluir',
  descartar: 'descartar',
};

/** Lowercase, no accents, no punctuation: how two titles or two product names are compared. */
export function normalized(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

async function nextNumber(db: Queryable, table: typeof roadmapItems | typeof roadmapProposals) {
  const [top] = await db
    .select({ max: sql<number>`coalesce(max(${table.number}), 0)` })
    .from(table);

  return Number(top?.max ?? 0) + 1;
}

/**
 * The roadmap of the products (B24). The owner's own items and edits are direct. The
 * Estrategista is the only agent that proposes: suggestions and new items always wait for the
 * owner; what it reads on the boards moves an item forward on its own only with the automatic
 * switch on, and a move backward or a discard always waits.
 */
export class Roadmap {
  private agents?: RoadmapAgents;
  private notify?: (text: string, short?: string) => Promise<unknown>;
  private learn?: (lesson: Lesson) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private readonly people: { profiles(): Promise<Array<{ id: string; name: string }>> },
    private readonly applications: { list(): Promise<Application[]> },
    private readonly open: WorkClientOpener,
    private readonly keyProfile: () => Promise<string | undefined>,
    private readonly target: EntryTarget,
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(agents: RoadmapAgents) {
    this.agents = agents;
  }

  /** Where a proposal reaches the owner: the panel and, by the setting, the channels. */
  useOwner(notify: (text: string, short?: string) => Promise<unknown>) {
    this.notify = notify;
  }

  /** The knowledge base learns from the owner's refusals and adjustments, through its Curator. */
  useLearner(learn: (lesson: Lesson) => Promise<unknown>) {
    this.learn = learn;
  }

  async settings(): Promise<RoadmapSettings> {
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, SETTINGS_KEY))
      .limit(1);

    return roadmapSettingsSchema.parse({ ...DEFAULTS, ...((row?.value ?? {}) as object) });
  }

  async updateSettings(input: unknown): Promise<RoadmapSettings> {
    const patch = roadmapSettingsPatchSchema.parse(input ?? {});
    const merged: Record<string, unknown> = { ...(await this.settings()) };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }

    const strategist = merged.strategistProfileId;

    if (
      typeof strategist === 'string' &&
      !(await this.people.profiles()).some((profile) => profile.id === strategist)
    ) {
      throw new GatewayError(404, `Profile ${strategist} not found`);
    }

    const value = roadmapSettingsSchema.parse(merged);

    await this.store.db
      .insert(gatewaySettings)
      .values({ key: SETTINGS_KEY, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date(this.clock()) },
      });

    return value;
  }

  /** Only the Estrategista is offered propose_roadmap and sync_roadmap. */
  async isStrategist(profileId: string) {
    return (await this.settings()).strategistProfileId === profileId;
  }

  private async assertStrategist(by: { profileId: string }) {
    if (!(await this.isStrategist(by.profileId))) {
      throw new GatewayError(403, 'Only the Estrategista proposes changes to the roadmap');
    }
  }

  /** The applications the roadmap covers, as the settings list them. */
  private async products(settings?: RoadmapSettings): Promise<Application[]> {
    const covered = (settings ?? (await this.settings())).applications;
    const all = await this.applications.list();

    return covered
      .map((slug) => all.find((app) => app.slug === slug))
      .filter((app): app is Application => Boolean(app));
  }

  /** An application by its slug or its name, without case, accents or hyphens. */
  private match(apps: Application[], name: string): Application | undefined {
    const wanted = normalized(name);

    return apps.find(
      (app) =>
        app.id === name || normalized(app.slug) === wanted || normalized(app.name) === wanted,
    );
  }

  /** An application by slug or name; the list is read before any transaction opens. */
  private async product(name: string, known?: Application[]): Promise<Application> {
    const found = this.match(known ?? (await this.applications.list()), name);

    if (!found) throw new GatewayError(404, `Application ${name} not found`);

    return found;
  }

  private requestUrl(workId: string) {
    return `${this.target.webUrl}/w/${this.target.workspaceId}/b/${this.target.entryBoardId}?activity=${workId}`;
  }

  private async present(rows: ItemRow[]): Promise<RoadmapItem[]> {
    const apps = new Map((await this.applications.list()).map((app) => [app.id, app]));
    const topics = new Map(
      (await this.store.db.select({ id: pautas.id, title: pautas.title }).from(pautas)).map(
        (row) => [row.id, row.title],
      ),
    );

    return rows.map((row) => {
      const app = apps.get(row.applicationId);
      const pautaTitle = row.pautaId ? topics.get(row.pautaId) : undefined;

      return {
        id: row.id,
        number: row.number,
        applicationId: row.applicationId,
        application: app?.slug ?? '',
        applicationName: app?.name ?? '',
        title: row.title,
        summary: row.summary,
        kind: row.kind as RoadmapKind,
        lane: row.lane as RoadmapLane,
        position: row.position,
        state: row.state as RoadmapState,
        blocked: row.blocked,
        origin: row.origin as RoadmapOrigin,
        ...(row.pautaId ? { pautaId: row.pautaId } : {}),
        ...(pautaTitle ? { pautaTitle } : {}),
        ...(row.requestWorkId
          ? { requestWorkId: row.requestWorkId, requestUrl: this.requestUrl(row.requestWorkId) }
          : {}),
        epicWorkIds: row.epicWorkIds ?? [],
        ...(row.theme ? { theme: row.theme } : {}),
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        ...(row.concludedAt ? { concludedAt: row.concludedAt.toISOString() } : {}),
      };
    });
  }

  private async itemRow(id: string, db: Queryable = this.store.db) {
    const [row] = await db.select().from(roadmapItems).where(eq(roadmapItems.id, id)).limit(1);

    return assertFound(row, 'Roadmap item');
  }

  async get(id: string): Promise<RoadmapItem> {
    const [item] = await this.present([await this.itemRow(id)]);

    return assertFound(item, 'Roadmap item');
  }

  /** Lane by lane (Agora, Próximo, Depois), in order within each. */
  async list(query: unknown = {}): Promise<RoadmapItem[]> {
    const filter = roadmapListQuerySchema.parse(query ?? {});
    const app = filter.application ? await this.product(filter.application) : undefined;
    const rows = await this.store.db
      .select()
      .from(roadmapItems)
      .where(
        and(
          app ? eq(roadmapItems.applicationId, app.id) : undefined,
          filter.lane ? eq(roadmapItems.lane, filter.lane) : undefined,
          filter.state ? eq(roadmapItems.state, filter.state) : undefined,
        ),
      )
      .orderBy(asc(roadmapItems.position), asc(roadmapItems.number))
      .limit(1000);

    return this.present(
      [...rows].sort((a, b) => RANK[a.lane as RoadmapLane] - RANK[b.lane as RoadmapLane]),
    );
  }

  /** The next free place at the end of a lane. */
  private async endOf(tx: Queryable, lane: RoadmapLane) {
    const [top] = await tx
      .select({ max: sql<number>`coalesce(max(${roadmapItems.position}), -1)` })
      .from(roadmapItems)
      .where(and(eq(roadmapItems.lane, lane), eq(roadmapItems.state, 'ativo')));

    return Number(top?.max ?? -1) + 1;
  }

  /** Puts an item at a place in its lane and renumbers the lane from 0. */
  private async place(tx: Queryable, id: string, lane: RoadmapLane, position: number) {
    const others = (
      await tx
        .select({ id: roadmapItems.id })
        .from(roadmapItems)
        .where(and(eq(roadmapItems.lane, lane), eq(roadmapItems.state, 'ativo')))
        .orderBy(asc(roadmapItems.position), asc(roadmapItems.number))
    ).filter((row) => row.id !== id);
    const order = [...others.map((row) => row.id)];

    order.splice(Math.min(position, order.length), 0, id);

    for (const [index, itemId] of order.entries()) {
      await tx.update(roadmapItems).set({ position: index }).where(eq(roadmapItems.id, itemId));
    }
  }

  private async insertItem(
    tx: Queryable,
    data: {
      applicationId: string;
      title: string;
      summary: string;
      kind: RoadmapKind;
      lane: RoadmapLane;
      origin: RoadmapOrigin;
      theme?: string | undefined;
      pautaId?: string | undefined;
      requestWorkId?: string | undefined;
      epicWorkIds: string[];
      createdBy: string;
    },
  ) {
    const id = randomUUID();
    const now = new Date(this.clock());

    await tx.insert(roadmapItems).values({
      id,
      number: await nextNumber(tx, roadmapItems),
      applicationId: data.applicationId,
      title: noDashes(data.title),
      summary: noDashes(data.summary),
      kind: data.kind,
      lane: data.lane,
      position: await this.endOf(tx, data.lane),
      state: 'ativo',
      blocked: false,
      origin: data.origin,
      pautaId: data.pautaId ?? null,
      requestWorkId: data.requestWorkId ?? null,
      epicWorkIds: data.epicWorkIds,
      theme: data.theme ?? null,
      createdBy: data.createdBy,
      createdAt: now,
      updatedAt: now,
    });

    return id;
  }

  /** The owner's own item: direct, in Depois unless a lane is given. */
  async create(input: unknown): Promise<RoadmapItem> {
    const data = roadmapItemCreateSchema.parse(input);
    const app = await this.product(data.application);
    const id = await this.store.transaction('roadmap', (tx) =>
      this.insertItem(tx, {
        applicationId: app.id,
        title: data.title,
        summary: data.summary,
        kind: data.kind,
        lane: data.lane,
        origin: 'moabe',
        theme: data.theme,
        pautaId: data.pautaId,
        requestWorkId: data.requestWorkId,
        epicWorkIds: data.epicWorkIds,
        createdBy: 'owner',
      }),
    );

    return this.get(id);
  }

  /** The owner's edit: direct, with no proposal. A new lane puts it at the end unless placed. */
  async update(id: string, input: unknown): Promise<RoadmapItem> {
    const patch = roadmapItemPatchSchema.parse(input ?? {});
    const app = patch.application ? await this.product(patch.application) : undefined;

    await this.store.transaction('roadmap', async (tx) => {
      const current = await this.itemRow(id, tx);
      const lane = (patch.lane ?? current.lane) as RoadmapLane;
      const state = patch.state ?? (current.state as RoadmapState);
      const now = new Date(this.clock());

      await tx
        .update(roadmapItems)
        .set({
          ...(app ? { applicationId: app.id } : {}),
          ...(patch.title !== undefined ? { title: noDashes(patch.title) } : {}),
          ...(patch.summary !== undefined ? { summary: noDashes(patch.summary) } : {}),
          ...(patch.kind ? { kind: patch.kind } : {}),
          ...(patch.blocked !== undefined ? { blocked: patch.blocked } : {}),
          ...(patch.theme !== undefined ? { theme: patch.theme } : {}),
          ...(patch.pautaId !== undefined ? { pautaId: patch.pautaId } : {}),
          ...(patch.requestWorkId !== undefined ? { requestWorkId: patch.requestWorkId } : {}),
          ...(patch.epicWorkIds ? { epicWorkIds: patch.epicWorkIds } : {}),
          lane,
          state,
          concludedAt:
            state === 'concluido'
              ? (current.concludedAt ?? now)
              : state === 'ativo'
                ? null
                : current.concludedAt,
          updatedAt: now,
        })
        .where(eq(roadmapItems.id, id));

      if (
        state === 'ativo' &&
        (patch.position !== undefined || lane !== current.lane || current.state !== 'ativo')
      ) {
        await this.place(
          tx,
          id,
          lane,
          patch.position ??
            (lane === current.lane && current.state === 'ativo'
              ? current.position
              : Number.MAX_SAFE_INTEGER),
        );
      }
    });

    return this.get(id);
  }

  private async proposalRow(which: { id: string } | { number: number }, db: Queryable) {
    const [row] = await db
      .select()
      .from(roadmapProposals)
      .where(
        'id' in which
          ? eq(roadmapProposals.id, which.id)
          : eq(roadmapProposals.number, which.number),
      )
      .limit(1);

    return assertFound(row, 'Roadmap proposal');
  }

  private async views(rows: ProposalRow[]): Promise<RoadmapProposal[]> {
    const items = new Map(
      (await this.store.db.select().from(roadmapItems)).map((row) => [row.id, row]),
    );
    const apps = await this.applications.list();
    const names = new Map(
      (await this.store.db.select({ id: profiles.id, name: profiles.name }).from(profiles)).map(
        (row) => [row.id, row.name],
      ),
    );

    return rows.map((row) => {
      const item = row.itemId ? items.get(row.itemId) : undefined;
      const draft =
        row.kind === 'incluir' ? roadmapDraftSchema.safeParse(row.payload ?? {}) : undefined;
      const payload = (row.payload ?? {}) as { lane?: RoadmapLane; fromLane?: RoadmapLane };
      const app = item
        ? apps.find((entry) => entry.id === item.applicationId)
        : draft?.success
          ? this.match(apps, draft.data.application)
          : undefined;
      const result = row.resultId ? items.get(row.resultId) : undefined;
      const proposedBy = row.proposedBy ? names.get(row.proposedBy) : undefined;
      const lane = draft?.success ? draft.data.lane : payload.lane;

      return {
        id: row.id,
        number: row.number,
        kind: row.kind as RoadmapProposalKind,
        ...(item ? { itemId: item.id, itemNumber: item.number, itemTitle: item.title } : {}),
        ...(app ? { application: app.slug, applicationName: app.name } : {}),
        ...(payload.fromLane ? { fromLane: payload.fromLane } : {}),
        ...(lane ? { lane } : {}),
        ...(draft?.success ? { item: draft.data } : {}),
        reason: row.reason,
        ...(row.counterpoint ? { counterpoint: row.counterpoint } : {}),
        evidence: row.evidence ?? [],
        highImpact: row.highImpact,
        state: row.state as RoadmapProposal['state'],
        ...(proposedBy ? { proposedBy } : {}),
        ...(row.appliedBy ? { appliedBy: row.appliedBy as 'owner' | 'automatico' } : {}),
        ...(result ? { resultNumber: result.number } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.decidedVia
          ? { decidedVia: row.decidedVia as NonNullable<RoadmapProposal['decidedVia']> }
          : {}),
        ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private async proposal(which: { id: string } | { number: number }) {
    const [view] = await this.views([await this.proposalRow(which, this.store.db)]);

    return assertFound(view, 'Roadmap proposal');
  }

  async proposals(query: unknown = {}): Promise<RoadmapProposal[]> {
    const { state } = roadmapProposalListQuerySchema.parse(query ?? {});
    const rows = await this.store.db
      .select()
      .from(roadmapProposals)
      .where(state ? eq(roadmapProposals.state, state) : undefined)
      .orderBy(desc(roadmapProposals.createdAt), desc(roadmapProposals.number))
      .limit(300);

    return this.views(rows);
  }

  /** What an agent reads: the items with their numbers, the proposals waiting, the settings. */
  async lookup(query: { application?: string; lane?: RoadmapLane; state?: RoadmapState }) {
    const settings = await this.settings();
    const items = await this.list({ state: 'ativo', ...query });
    const waiting = await this.proposals({ state: 'aguardando_po' });

    return {
      items: items.map((item) => ({
        id: item.id,
        number: item.number,
        application: item.application,
        lane: item.lane,
        position: item.position,
        state: item.state,
        title: item.title,
        summary: clip(item.summary, 400),
        kind: item.kind,
        origin: item.origin,
        blocked: item.blocked,
        ...(item.theme ? { theme: item.theme } : {}),
        ...(item.pautaId ? { pautaId: item.pautaId, pautaTitle: item.pautaTitle } : {}),
        ...(item.requestWorkId ? { requestWorkId: item.requestWorkId } : {}),
        epicWorkIds: item.epicWorkIds,
      })),
      waiting: waiting.map((proposal) => ({
        number: proposal.number,
        kind: proposal.kind,
        ...(proposal.itemNumber ? { itemNumber: proposal.itemNumber } : {}),
        title: proposal.item?.title ?? proposal.itemTitle ?? '',
        ...(proposal.lane ? { lane: proposal.lane } : {}),
      })),
      settings: {
        automaticMoves: settings.automaticMoves,
        suggestionsPerRound: settings.suggestionsPerRound,
        applications: settings.applications,
      },
    };
  }

  /** A suggestion the owner refused in the last 60 days with this title, if any. */
  private async refusedLately(tx: Queryable, title: string) {
    const since = new Date(this.clock() - REPEAT_DAYS * DAY);
    const wanted = normalized(title);
    const refused = await tx
      .select()
      .from(roadmapProposals)
      .where(
        and(
          eq(roadmapProposals.state, 'recusada'),
          eq(roadmapProposals.kind, 'incluir'),
          gte(roadmapProposals.decidedAt, since),
        ),
      );

    return refused.find(
      (row) => normalized(String((row.payload as { title?: unknown }).title ?? '')) === wanted,
    );
  }

  /** An active item, or a waiting proposal, already about this request, topic or title. */
  private async known(tx: Queryable, appId: string, draft: RoadmapDraft) {
    const items = await tx.select().from(roadmapItems).where(eq(roadmapItems.state, 'ativo'));
    const title = normalized(draft.title);
    const item = items.find(
      (row) =>
        (draft.requestWorkId && row.requestWorkId === draft.requestWorkId) ||
        (draft.pautaId && row.pautaId === draft.pautaId) ||
        (row.applicationId === appId && normalized(row.title) === title),
    );

    if (item) return `o item #${item.number} já é sobre isso`;

    const waiting = await tx
      .select()
      .from(roadmapProposals)
      .where(
        and(eq(roadmapProposals.state, 'aguardando_po'), eq(roadmapProposals.kind, 'incluir')),
      );
    const proposal = waiting.find((row) => {
      const other = row.payload as Partial<RoadmapDraft>;

      return (
        (draft.requestWorkId && other.requestWorkId === draft.requestWorkId) ||
        (draft.pautaId && other.pautaId === draft.pautaId) ||
        normalized(String(other.title ?? '')) === title
      );
    });

    return proposal ? `a proposta #${proposal.number} já espera o Moabe` : undefined;
  }

  private async insertProposal(
    tx: Queryable,
    data: {
      kind: RoadmapProposalKind;
      itemId?: string;
      payload: Record<string, unknown>;
      reason: string;
      counterpoint?: string;
      evidence: string[];
      highImpact: boolean;
      proposedBy: string;
    },
  ) {
    const id = randomUUID();

    await tx.insert(roadmapProposals).values({
      id,
      number: await nextNumber(tx, roadmapProposals),
      kind: data.kind,
      itemId: data.itemId ?? null,
      payload: data.payload,
      reason: noDashes(data.reason),
      counterpoint: data.counterpoint ? noDashes(data.counterpoint) : null,
      evidence: data.evidence,
      highImpact: data.highImpact,
      state: 'aguardando_po',
      proposedBy: data.proposedBy,
      createdAt: new Date(this.clock()),
    });

    return id;
  }

  /**
   * The Estrategista's proposal: always for the owner's OK. A new item the owner refused in the
   * last 60 days, by its title, is refused here with when and why.
   */
  async propose(input: unknown, by: { profileId: string }): Promise<RoadmapProposal> {
    const data = roadmapProposalInputSchema.parse(input);

    await this.assertStrategist(by);

    const apps = await this.applications.list();
    const id = await this.store.transaction('roadmap', async (tx) => {
      if (data.kind === 'incluir' && data.item) {
        const app = await this.product(data.item.application, apps);
        const refused = await this.refusedLately(tx, data.item.title);

        if (refused) {
          const day = (refused.decidedAt ?? refused.createdAt).toISOString().slice(0, 10);
          const [year, month, date] = day.split('-');

          throw new GatewayError(
            409,
            `O Moabe recusou essa sugestão em ${date}/${month}/${year} (proposta #${refused.number})${refused.note ? `: ${refused.note}` : ''}. Não repita antes de ${REPEAT_DAYS} dias.`,
          );
        }

        const known = await this.known(tx, app.id, data.item);

        if (known) throw new GatewayError(409, `Não proposto: ${known}.`);

        return this.insertProposal(tx, {
          kind: 'incluir',
          payload: { ...data.item, application: app.slug },
          reason: data.reason,
          counterpoint: data.counterpoint,
          evidence: data.evidence,
          highImpact: data.highImpact,
          proposedBy: by.profileId,
        });
      }

      const item = await this.itemRow(data.itemId ?? '', tx);

      if (item.state !== 'ativo') {
        throw new GatewayError(409, `O item #${item.number} já está ${item.state}`);
      }
      if (data.kind === 'mover' && data.lane === item.lane) {
        throw new GatewayError(
          409,
          `O item #${item.number} já está em ${LANE_LABEL[item.lane as RoadmapLane]}`,
        );
      }

      return this.insertProposal(tx, {
        kind: data.kind,
        itemId: item.id,
        payload: { fromLane: item.lane, ...(data.lane ? { lane: data.lane } : {}) },
        reason: data.reason,
        counterpoint: data.counterpoint,
        evidence: data.evidence,
        highImpact: data.highImpact,
        proposedBy: by.profileId,
      });
    });
    const proposal = await this.proposal({ id });

    await this.tell([proposal]);

    return proposal;
  }

  /**
   * The Estrategista's reading of the boards. A forward move (or a conclusion) applies at once
   * when the automatic switch is on; a move backward, a discard and a new item always become
   * proposals. A blocked mark is applied as it is read; the lane stays.
   */
  async sync(input: unknown, by: { profileId: string }): Promise<RoadmapSyncResult> {
    const { entries } = roadmapSyncInputSchema.parse(input);

    await this.assertStrategist(by);

    const settings = await this.settings();
    const result: RoadmapSyncResult = { applied: [], proposed: [], skipped: [] };
    const created: string[] = [];
    const apps = await this.applications.list();

    for (const [index, entry] of entries.entries()) {
      try {
        const outcome = await this.store.transaction('roadmap', async (tx) => {
          if (entry.new) {
            const draft = {
              ...entry.new,
              ...(entry.lane ? { lane: entry.lane } : {}),
            };
            const app = await this.product(draft.application, apps);
            const known = await this.known(tx, app.id, draft);

            if (known) return { skipped: known };

            return {
              proposed: await this.insertProposal(tx, {
                kind: 'incluir',
                payload: { ...draft, application: app.slug },
                reason: entry.reason,
                evidence: entry.evidence,
                highImpact: false,
                proposedBy: by.profileId,
              }),
            };
          }

          const item = await this.itemRow(entry.itemId ?? '', tx);
          const lane = item.lane as RoadmapLane;
          const applied: string[] = [];

          if (item.state !== 'ativo')
            return { skipped: `o item #${item.number} já está ${item.state}` };

          if (entry.blocked !== undefined && entry.blocked !== item.blocked) {
            await tx
              .update(roadmapItems)
              .set({ blocked: entry.blocked, updatedAt: new Date(this.clock()) })
              .where(eq(roadmapItems.id, item.id));
            applied.push(entry.blocked ? 'marcado bloqueado' : 'desbloqueado');
          }

          const kind: RoadmapProposalKind | undefined =
            entry.state === 'descartado'
              ? 'descartar'
              : entry.state === 'concluido'
                ? 'concluir'
                : entry.lane && entry.lane !== lane
                  ? 'mover'
                  : undefined;

          if (!kind) {
            return applied.length
              ? {
                  applied: {
                    itemNumber: item.number,
                    title: item.title,
                    change: applied.join(', '),
                  },
                }
              : { skipped: 'nada muda' };
          }

          const waiting = await tx
            .select()
            .from(roadmapProposals)
            .where(
              and(
                eq(roadmapProposals.state, 'aguardando_po'),
                eq(roadmapProposals.itemId, item.id),
                eq(roadmapProposals.kind, kind),
              ),
            );

          if (
            waiting.some(
              (row) => kind !== 'mover' || (row.payload as { lane?: string }).lane === entry.lane,
            )
          ) {
            return applied.length
              ? {
                  applied: {
                    itemNumber: item.number,
                    title: item.title,
                    change: applied.join(', '),
                  },
                }
              : { skipped: `já há proposta esperando o Moabe para o item #${item.number}` };
          }

          const forward =
            kind === 'concluir' ||
            (kind === 'mover' && entry.lane && RANK[entry.lane] < RANK[lane]);
          const proposalId = await this.insertProposal(tx, {
            kind,
            itemId: item.id,
            payload: { fromLane: lane, ...(kind === 'mover' ? { lane: entry.lane } : {}) },
            reason: entry.reason,
            evidence: entry.evidence,
            highImpact: false,
            proposedBy: by.profileId,
          });

          if (forward && settings.automaticMoves) {
            await this.applyRow(tx, await this.proposalRow({ id: proposalId }, tx), apps);
            await this.close(tx, proposalId, { appliedBy: 'automatico', via: 'automatico' });
            applied.push(
              kind === 'concluir'
                ? 'concluído'
                : `movido para ${LANE_LABEL[entry.lane as RoadmapLane]}`,
            );

            return {
              applied: { itemNumber: item.number, title: item.title, change: applied.join(', ') },
            };
          }

          return {
            proposed: proposalId,
            ...(applied.length
              ? {
                  applied: {
                    itemNumber: item.number,
                    title: item.title,
                    change: applied.join(', '),
                  },
                }
              : {}),
          };
        });

        if ('skipped' in outcome && outcome.skipped)
          result.skipped.push({ index, why: outcome.skipped });
        if ('applied' in outcome && outcome.applied) result.applied.push(outcome.applied);
        if ('proposed' in outcome && outcome.proposed) created.push(outcome.proposed);
      } catch (failure) {
        result.skipped.push({
          index,
          why: failure instanceof Error ? failure.message.slice(0, 300) : String(failure),
        });
      }
    }

    for (const id of created) result.proposed.push(await this.proposal({ id }));

    await this.tell(result.proposed);

    return result;
  }

  /** Applies a proposal to the roadmap; returns the item a new one created. */
  private async applyRow(tx: Queryable, row: ProposalRow, apps: Application[], title?: string) {
    const now = new Date(this.clock());

    if (row.kind === 'incluir') {
      const draft = roadmapDraftSchema.parse(row.payload);
      const app = await this.product(draft.application, apps);

      return this.insertItem(tx, {
        applicationId: app.id,
        title: title ?? draft.title,
        summary: draft.summary,
        kind: draft.kind,
        lane: draft.lane,
        origin: draft.origin,
        theme: draft.theme,
        pautaId: draft.pautaId,
        requestWorkId: draft.requestWorkId,
        epicWorkIds: draft.epicWorkIds,
        createdBy: row.proposedBy ?? 'owner',
      });
    }

    const item = row.itemId
      ? (await tx.select().from(roadmapItems).where(eq(roadmapItems.id, row.itemId)))[0]
      : undefined;

    if (!item) {
      throw new GatewayError(409, `O item da proposta #${row.number} não existe mais`);
    }
    if (item.state !== 'ativo') {
      throw new GatewayError(409, `O item #${item.number} já está ${item.state}`);
    }

    if (row.kind === 'mover') {
      const lane = (row.payload as { lane?: RoadmapLane }).lane ?? (item.lane as RoadmapLane);

      await tx
        .update(roadmapItems)
        .set({ lane, updatedAt: now })
        .where(eq(roadmapItems.id, item.id));
      await this.place(tx, item.id, lane, Number.MAX_SAFE_INTEGER);
    } else {
      await tx
        .update(roadmapItems)
        .set({
          state: row.kind === 'concluir' ? 'concluido' : 'descartado',
          ...(row.kind === 'concluir' ? { concludedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(roadmapItems.id, item.id));
    }

    return null;
  }

  private async close(
    tx: Queryable,
    id: string,
    outcome: {
      appliedBy?: 'owner' | 'automatico';
      via: Via | 'automatico';
      refused?: boolean;
      note?: string;
      resultId?: string | null;
    },
  ) {
    await tx
      .update(roadmapProposals)
      .set({
        state: outcome.refused ? 'recusada' : 'aplicada',
        appliedBy: outcome.refused ? null : (outcome.appliedBy ?? 'owner'),
        resultId: outcome.resultId ?? null,
        note: outcome.note ?? null,
        decidedVia: outcome.via,
        decidedAt: new Date(this.clock()),
      })
      .where(eq(roadmapProposals.id, id));
  }

  /**
   * The owner on a proposal: ok applies it; edit applies it with the owner's adjustment (the
   * new title of a new item, a note otherwise) and counts as a correction; refuse closes it,
   * with the reason kept for the Estrategista and the Curator.
   */
  async decide(
    which: { id: string } | { number: number },
    input: unknown,
    via: Via = 'api',
  ): Promise<RoadmapProposal> {
    const data = roadmapDecideSchema.parse(input ?? {});
    const text = data.text ? noDashes(data.text).trim() : undefined;
    const apps = await this.applications.list();
    const id = await this.store.transaction('roadmap', async (tx) => {
      const row = await this.proposalRow(which, tx);

      if (row.state !== 'aguardando_po') {
        throw new GatewayError(409, `A proposta de roadmap #${row.number} já está ${row.state}`);
      }

      if (data.action === 'refuse') {
        await this.close(tx, row.id, { via, refused: true, ...(text ? { note: text } : {}) });
        return row.id;
      }

      const adjusted =
        data.action === 'edit' && row.kind === 'incluir'
          ? text?.split('\n')[0]?.slice(0, 200)
          : undefined;
      const result = await this.applyRow(tx, row, apps, adjusted);

      await this.close(tx, row.id, {
        via,
        appliedBy: 'owner',
        resultId: result,
        ...(data.action === 'edit' && text ? { note: text } : {}),
      });

      return row.id;
    });
    const proposal = await this.proposal({ id });

    if (data.action !== 'ok') await this.corrected(proposal, data.action, via);

    return proposal;
  }

  /** A refusal or an adjustment: a correction in Quality, a lesson, and the Estrategista's memory. */
  private async corrected(proposal: RoadmapProposal, action: 'edit' | 'refuse', via: Via) {
    const profileId = (await this.settings()).strategistProfileId;
    const what = proposal.item?.title ?? proposal.itemTitle ?? '';
    const description = `${KIND_LABEL[proposal.kind]} "${what}"${proposal.lane ? ` em ${LANE_LABEL[proposal.lane]}` : ''}`;

    if (profileId) {
      await this.quality
        ?.record(this.store.db, profileId, {
          kind: action === 'refuse' ? 'rejected' : 'edited',
          via,
          action: ROADMAP_AUTOMATION,
          original: description,
          ...(action === 'edit' && proposal.note ? { corrected: proposal.note } : {}),
          note:
            action === 'refuse'
              ? `O Moabe recusou a proposta de roadmap #${proposal.number}${proposal.note ? `: ${proposal.note}` : ''}.`
              : `O Moabe aplicou a proposta de roadmap #${proposal.number} com ajuste.`,
        })
        .catch(() => {});

      if (action === 'refuse') {
        await this.agents
          ?.remember?.(
            profileId,
            `roadmap-recusa-${proposal.number}`,
            `Em ${new Date(this.clock()).toISOString().slice(0, 10)} o Moabe recusou a proposta de roadmap #${proposal.number} (${description})${proposal.note ? `: ${proposal.note}` : ''}. Não repetir por ${REPEAT_DAYS} dias.`,
          )
          .catch(() => {});
      }
    }

    await this.learn?.({
      kind: 'roadmap',
      ref: `Roadmap, proposta #${proposal.number}`,
      text: [
        `Proposta: ${description}`,
        `Motivo do Estrategista: ${proposal.reason}`,
        action === 'refuse'
          ? `O Moabe recusou${proposal.note ? `: ${proposal.note}` : ', sem motivo'}.`
          : `O Moabe aplicou com o ajuste: ${proposal.note ?? ''}`,
      ].join('\n'),
      ...(proposal.applicationName ? { application: proposal.applicationName } : {}),
    }).catch(() => {});
  }

  /** "ok roadmap 1-12", "recusa roadmap 4: motivo" or "roadmap 4: texto" from the owner in a chat. */
  async fromChat(reply: RoadmapReply): Promise<RoadmapChatResult> {
    const result: RoadmapChatResult = { proposals: [], failed: [] };

    for (const number of reply.numbers) {
      try {
        result.proposals.push(
          await this.decide(
            { number },
            { action: reply.action, ...(reply.text ? { text: reply.text } : {}) },
            'channel',
          ),
        );
      } catch (failure) {
        result.failed.push({
          number,
          why:
            failure instanceof GatewayError && failure.statusCode === 404
              ? 'não existe'
              : failure instanceof Error
                ? failure.message
                : String(failure),
        });
      }
    }

    return result;
  }

  /**
   * The owner's idea from a chat: an item in Depois, origin moabe, with no proposal. The product
   * is found by slug or name; with none named and more than one application, one line asks.
   */
  async note(note: RoadmapNote): Promise<RoadmapNoteResult> {
    const settings = await this.settings();
    const apps = await this.products(settings);
    const named = note.product ? this.match(apps, note.product) : undefined;
    const app = named ?? (apps.length === 1 ? apps[0] : undefined);
    const title = named ? note.title : note.text;

    if (!app) {
      const options = apps.map((entry) => entry.name);
      const list =
        options.length > 1
          ? `${options.slice(0, -1).join(', ')} ou ${options[options.length - 1]}`
          : (options[0] ?? 'qual aplicação');

      return {
        question: `Em qual produto entra "${clip(title, 120)}": ${list}? Responda "roadmap: ${clip(title, 120)} no <produto>".`,
      };
    }

    const id = await this.store.transaction('roadmap', (tx) =>
      this.insertItem(tx, {
        applicationId: app.id,
        title: title.slice(0, 200),
        summary: '',
        kind: 'ideia',
        lane: 'depois',
        origin: 'moabe',
        epicWorkIds: [],
        createdBy: 'owner',
      }),
    );

    return { item: await this.get(id) };
  }

  /**
   * Starts the Estrategista's routine now: the daily reading, with a read of the Entrada when
   * the tracker answers, or the Monday suggestions.
   */
  async run(input: unknown = {}): Promise<RoadmapRunResult> {
    const { kind } = roadmapRunSchema.parse(input ?? {});
    const settings = await this.settings();
    const profileId = settings.strategistProfileId;

    if (!profileId) throw new GatewayError(409, 'Nenhum Estrategista configurado no roadmap');
    if (!this.agents) throw new GatewayError(503, 'No agent keeps the roadmap');

    const session = await this.agents.session(
      profileId,
      kind === 'leitura' ? READING_SESSION : SUGGESTIONS_SESSION,
    );
    const snapshot = kind === 'leitura' ? await this.snapshot() : undefined;
    const text =
      kind === 'leitura'
        ? [
            '[Roadmap · leitura] Leia os pedidos da Entrada, os épicos e as pautas e aplique as regras de faixa da skill roadmap-leitura. Leia o roadmap com read_roadmap e mande a leitura com sync_roadmap: cada item que muda (faixa, conclusão, descarte, bloqueio) e cada pedido ou pauta que ainda não tem item. Nunca invente sinal: cite a evidência.',
            settings.automaticMoves
              ? 'Automático ligado: o que anda para frente se aplica sozinho; para trás e descarte viram proposta.'
              : 'Automático desligado: tudo vira proposta para o Moabe.',
            '',
            snapshot ?? 'Não consegui ler a Entrada daqui; leia pelo Work.',
          ].join('\n')
        : [
            `[Roadmap · sugestões] Rodada de sugestões: até ${settings.suggestionsPerRound}, com motivo, contraponto e evidência, seguindo a skill roadmap-sugestoes. Leia o roadmap com read_roadmap e proponha com propose_roadmap. Sugestão recusada nos últimos ${REPEAT_DAYS} dias não volta.`,
          ].join('\n');

    await this.agents.submit(
      profileId,
      session.id,
      text.slice(0, 7800),
      `roadmap:${kind}:${this.clock()}`,
    );

    return { kind, profileId, sessionId: session.id, workRead: Boolean(snapshot) };
  }

  /** The Entrada as it is now, column by column, with the epics each request depends on. */
  async snapshot(): Promise<string | undefined> {
    try {
      const profileId = await this.keyProfile();

      if (!profileId) return undefined;

      const client = await this.open(profileId, { workspaceId: this.target.workspaceId });
      const columns = await boardColumns(client, this.target);
      const lines: string[] = ['Entrada agora:'];

      for (const key of ['running', 'prioritized', 'blocked', 'done'] as const) {
        const cards = await columnCards(client, this.target.entryBoardId, columns.entry[key]);
        const shown = cards.slice(0, key === 'done' ? 20 : 40);

        lines.push(`${this.target.entryColumns[key]} (${cards.length}):`);

        for (const card of shown) {
          const epics =
            key === 'done' ? [] : await dependsOn(client, this.target, card.id, new Map());

          lines.push(
            `- ${card.title} (pedido ${card.id})${epics.length ? `; épicos: ${epics.map((epic) => epic.activity_id).join(', ')}` : ''}`,
          );
        }
      }

      return clip(lines.join('\n'), 6000);
    } catch {
      return undefined;
    }
  }

  /** The owner hears of the proposals that wait: the full text, and a short one for the chat. */
  private async tell(waiting: RoadmapProposal[]) {
    const open = waiting.filter((proposal) => proposal.state === 'aguardando_po');

    if (!open.length || !this.notify) return;

    await this.notify(Roadmap.ask(open), Roadmap.short(open)).catch(() => {});
  }

  private static what(proposal: RoadmapProposal) {
    const title = proposal.item?.title ?? proposal.itemTitle ?? '';
    const app = proposal.applicationName ? ` (${proposal.applicationName})` : '';

    switch (proposal.kind) {
      case 'incluir':
        return `incluir "${title}"${app} em ${LANE_LABEL[proposal.lane ?? 'depois']}`;
      case 'mover':
        return `mover "${title}"${app}${proposal.fromLane ? ` de ${LANE_LABEL[proposal.fromLane]}` : ''} para ${LANE_LABEL[proposal.lane ?? 'depois']}`;
      case 'concluir':
        return `concluir "${title}"${app}`;
      case 'descartar':
        return `descartar "${title}"${app}`;
    }
  }

  private static commands(open: RoadmapProposal[]) {
    const first = open[0]?.number ?? 0;
    const last = open[open.length - 1]?.number ?? first;
    const all = open.length > 1 ? `Para aplicar todas: "ok roadmap ${first}-${last}". ` : '';

    return `${all}Responda "ok roadmap ${first}" ou "recusa roadmap ${first}: motivo".`;
  }

  /** How the owner is asked about the proposals that wait. */
  static ask(open: RoadmapProposal[]) {
    const blocks = open.map((proposal) =>
      [
        `Roadmap, proposta #${proposal.number} do ${proposal.proposedBy ?? 'Estrategista'}: ${Roadmap.what(proposal)}${proposal.highImpact ? ' (alto impacto)' : ''}.`,
        proposal.item?.summary ? `Resumo: ${clip(proposal.item.summary, 600)}` : '',
        `Por quê: ${proposal.reason}`,
        proposal.counterpoint ? `Contraponto: ${proposal.counterpoint}` : '',
        proposal.evidence.length ? `Evidência: ${proposal.evidence.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    return noDashes(
      [...blocks, `${Roadmap.commands(open)} Ou abra Roadmap no painel.`].join('\n\n'),
    ).slice(0, 7800);
  }

  /** The short text for a chat, ending in the commands. */
  static short(open: RoadmapProposal[]) {
    const lines = open
      .slice(0, 8)
      .map(
        (proposal) =>
          `#${proposal.number}: ${Roadmap.what(proposal)}${proposal.highImpact ? ' (alto impacto)' : ''}`,
      );
    const more = open.length > 8 ? [`e mais ${open.length - 8} no painel.`] : [];

    return noDashes(
      [
        `Roadmap: ${open.length === 1 ? 'uma proposta espera você' : `${open.length} propostas esperam você`}.`,
        ...lines,
        ...more,
        Roadmap.commands(open),
      ].join('\n'),
    ).slice(0, 3000);
  }

  /** What an agent reads when the owner answered proposals in a chat. */
  static notice(result: RoadmapChatResult) {
    const lines = result.proposals.map((proposal) =>
      proposal.state === 'aplicada'
        ? `[Roadmap #${proposal.number}] O Moabe aplicou: ${Roadmap.what(proposal)}${proposal.note ? ` (ajuste: ${proposal.note})` : ''}${proposal.resultNumber ? `; item #${proposal.resultNumber}` : ''}.`
        : `[Roadmap #${proposal.number}] O Moabe recusou: ${Roadmap.what(proposal)}${proposal.note ? `. Motivo: ${proposal.note}` : ''}.`,
    );
    const failed = result.failed.map(
      (item) => `[Roadmap #${item.number}] Não aplicada: ${item.why}.`,
    );

    return [...lines, ...failed].join('\n');
  }

  /** What an agent reads after "roadmap: <ideia>". */
  static noted(result: RoadmapNoteResult) {
    return 'item' in result
      ? `[Roadmap] Item #${result.item.number} do Moabe criado em Depois no ${result.item.applicationName}: "${result.item.title}". Confirme em uma linha.`
      : `[Roadmap] O Moabe mandou uma ideia sem dizer o produto. Pergunte em uma linha, exatamente: ${result.question}`;
  }
}
