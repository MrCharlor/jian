import { randomUUID } from 'node:crypto';
import {
  type Pipeline,
  type PipelineSettings,
  type PipelineStage,
  pipelineReportSchema,
  pipelineSettingsPatchSchema,
  pipelineSettingsSchema,
  type RequestDraft,
  requestProposalSchema,
} from '@jian/contracts';
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Epics } from '../epics/service.js';
import type { EntryTarget, RequestTarget } from '../epics/target.js';
import type { Pautas } from '../pautas/service.js';
import type { WorkClientOpener } from '../priorities/work-board.js';
import { boardColumns, columnCards } from '../priorities/work-readers.js';
import type { Profiles } from '../profiles/service.js';
import type { Prototypes } from '../prototypes/service.js';
import type { Store } from '../storage/database.js';
import {
  epicDrafts,
  gatewaySettings,
  pautas,
  pipelines,
  requestDrafts,
} from '../storage/schema.js';

type Row = typeof pipelines.$inferSelect;

/** How the chain reaches the agent that writes: a conversation of its own, and a message. */
export type PipelineAgents = {
  submit(profileId: string, sessionId: string, text: string, key: string): Promise<unknown>;
  session(profileId: string, title: string): Promise<{ id: string }>;
};

const SETTINGS_KEY = 'pipeline';
/** Set once the requests already in Priorizado when the chain was switched on were put aside. */
const BASELINE_KEY = 'pipeline:baseline';
const SESSION = 'Pedidos → épico';
/** The author named so when no profile is set, as the plans do. */
const AUTHOR_NAME = 'subaru';
/** The tracker's automation calls the moment a card moves; this look is only the safety net. */
const TICK_MS = 60 * 60_000;

const DEFAULTS: PipelineSettings = { enabled: false, maxActive: 3, maxRounds: 2 };

/** The stages that hold one of the places; the line and the ended ones do not. */
const WALKING: PipelineStage[] = ['pauta', 'prototipo', 'epico', 'aguardando_epico'];

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * A request that enters Priorizado on the Entrada walks to an epic by itself (B23): the author
 * finds or opens the pauta and says whether a drawing is due; the prototype goes through its
 * plan, the Reviewer and the owner as always; the author drafts the epic; the owner's OK in the
 * inbox creates it on the board. Each step is kept, so a restart goes on where it was. The
 * requests already in Priorizado when it was switched on wait for the owner to let them in.
 */
export class PipelineChain {
  private agents?: PipelineAgents;
  private notify?: (text: string, short?: string) => Promise<unknown>;
  private lastTick = 0;
  private running?: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly open: WorkClientOpener,
    private readonly keyProfile: () => Promise<string | undefined>,
    private readonly target: EntryTarget,
    private readonly profiles: Pick<Profiles, 'profiles'>,
    private readonly pautasService: Pick<Pautas, 'get' | 'list' | 'update'>,
    private readonly prototypes: Pick<Prototypes, 'list' | 'create'>,
    private readonly epics: Pick<Epics, 'list' | 'discard'>,
    private readonly request: RequestTarget,
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(agents: PipelineAgents) {
    this.agents = agents;
  }

  /** Where the owner hears that a gate waits: the panel and the owner's chat. */
  useOwner(notify: (text: string, short?: string) => Promise<unknown>) {
    this.notify = notify;
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, key))
      .limit(1);

    return row?.value as T | undefined;
  }

  private async write(key: string, value: unknown) {
    await this.store.db
      .insert(gatewaySettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date(this.clock()) },
      });
  }

  async settings(): Promise<PipelineSettings> {
    return pipelineSettingsSchema.parse({
      ...DEFAULTS,
      ...((await this.read<Partial<PipelineSettings>>(SETTINGS_KEY)) ?? {}),
    });
  }

  async updateSettings(input: unknown): Promise<PipelineSettings> {
    const patch = pipelineSettingsPatchSchema.parse(input ?? {});
    const merged: Record<string, unknown> = { ...(await this.settings()) };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }

    const value = pipelineSettingsSchema.parse(merged);

    await this.write(SETTINGS_KEY, value);

    return value;
  }

  /** The agent that writes for the chain: the one set, or the one named Subaru. */
  async author(): Promise<string | undefined> {
    const settings = await this.settings();

    if (settings.authorProfileId) return settings.authorProfileId;

    return (await this.profiles.profiles()).find(
      (profile) => profile.name.trim().toLowerCase() === AUTHOR_NAME,
    )?.id;
  }

  async isAuthor(profileId: string): Promise<boolean> {
    return (await this.author()) === profileId;
  }

  private requestUrl(workId: string) {
    return `${this.target.webUrl}/w/${this.target.workspaceId}/b/${this.target.entryBoardId}?activity=${workId}`;
  }

  private async present(row: Row): Promise<Pipeline> {
    const pauta = row.pautaId
      ? await this.pautasService.get(row.pautaId).catch(() => undefined)
      : undefined;
    const [draft] = row.epicDraftId
      ? await this.store.db
          .select({ number: epicDrafts.number })
          .from(epicDrafts)
          .where(eq(epicDrafts.id, row.epicDraftId))
      : [];

    return {
      id: row.id,
      number: row.number,
      requestWorkId: row.requestWorkId,
      requestTitle: row.requestTitle,
      requestUrl: this.requestUrl(row.requestWorkId),
      stage: row.stage as PipelineStage,
      ...(row.pautaId ? { pautaId: row.pautaId } : {}),
      ...(pauta ? { pautaTitle: pauta.title } : {}),
      ...(row.needsPrototype === null ? {} : { needsPrototype: row.needsPrototype }),
      ...(row.prototypeId ? { prototypeId: row.prototypeId } : {}),
      ...(row.epicDraftId ? { epicDraftId: row.epicDraftId } : {}),
      ...(draft ? { epicDraftNumber: draft.number } : {}),
      ...(row.epicWorkId ? { epicWorkId: row.epicWorkId } : {}),
      ...(row.note ? { note: row.note } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.store.db.select().from(pipelines).where(eq(pipelines.id, id));

    return assertFound(row, 'Pipeline');
  }

  async list(): Promise<Pipeline[]> {
    const rows = await this.store.db
      .select()
      .from(pipelines)
      .orderBy(desc(pipelines.createdAt))
      .limit(100);

    return Promise.all(rows.map((row) => this.present(row)));
  }

  private async update(id: string, change: Partial<Row>) {
    await this.store.db
      .update(pipelines)
      .set({ ...change, updatedAt: new Date(this.clock()) })
      .where(eq(pipelines.id, id));
  }

  /** The owner lets in a request that was in Priorizado before the chain was switched on. */
  async enter(id: string): Promise<Pipeline> {
    const row = await this.row(id);

    if (row.stage !== 'fora' && row.stage !== 'parado') {
      throw new GatewayError(409, `Pedido #${row.number} já está na cadeia (${row.stage})`);
    }

    await this.update(id, { stage: 'fila', note: null, asked: null });
    this.lastTick = 0;

    return this.present(await this.row(id));
  }

  async stop(id: string): Promise<Pipeline> {
    const row = await this.row(id);

    if (row.stage === 'criado') throw new GatewayError(409, 'O épico já foi criado');

    await this.update(id, { stage: 'parado', note: 'Parado pelo Moabe.' });

    return this.present(await this.row(id));
  }

  /**
   * The tracker's automation, the moment a card moves on the Entrada: the chain looks at once
   * instead of waiting for its hourly look. Answers at once; the look runs after.
   */
  poke(): { accepted: boolean } {
    this.lastTick = 0;
    void this.tick().catch((error) => {
      console.error('jian: the requests could not go on after a move on the Entrada', error);
    });

    return { accepted: true };
  }

  /** On the worker's tick, every hour as a safety net, while the owner keeps the chain on. */
  async tick(): Promise<void> {
    const now = this.clock();

    if (now - this.lastTick < TICK_MS) return;

    this.lastTick = now;

    if (!(await this.settings()).enabled) return;

    this.running ??= this.step().finally(() => {
      this.running = undefined;
    });
    await this.running;
  }

  /** One look at the Entrada and at each request on its way. */
  async step(): Promise<void> {
    const profileId = await this.keyProfile();

    if (!profileId) return;

    const client = await this.open(profileId, { workspaceId: this.target.workspaceId });
    const columns = await boardColumns(client, this.target);
    const cards = await columnCards(client, this.target.entryBoardId, columns.entry.prioritized);
    const present = new Map(cards.map((card) => [card.id, card]));
    const baselined = Boolean(await this.read<boolean>(BASELINE_KEY));
    const known = new Set(
      (await this.store.db.select({ id: pipelines.requestWorkId }).from(pipelines)).map(
        (row) => row.id,
      ),
    );

    for (const card of cards) {
      if (known.has(card.id)) continue;
      await this.insert(card.id, card.title, baselined ? 'fila' : 'fora');
    }

    if (!baselined) {
      await this.write(BASELINE_KEY, true);

      if (cards.length) {
        await this.notify?.(
          `[Pedidos] A cadeia pedido → épico está ligada. ${cards.length} pedido(s) já estavam em Priorizado e ficaram de fora: ${cards.map((card) => `"${card.title}"`).join(', ')}. Para algum entrar, use Entrar na página Pedidos. Só os que entrarem em Priorizado daqui para frente andam sozinhos.`,
          `[Pedidos] Cadeia ligada. ${cards.length} pedido(s) que já estavam em Priorizado ficaram de fora; para algum entrar, abra Pedidos no painel.`,
        ).catch(() => {});
      }
    }

    const rows = await this.store.db.select().from(pipelines).orderBy(asc(pipelines.createdAt));

    for (const row of rows) {
      const waiting = row.stage === 'fila' || WALKING.includes(row.stage as PipelineStage);

      if (waiting && row.stage !== 'aguardando_epico' && !present.has(row.requestWorkId)) {
        await this.stopWith(row, 'O pedido saiu de Priorizado.');
      }
    }

    const settings = await this.settings();
    const fresh = await this.store.db.select().from(pipelines).orderBy(asc(pipelines.createdAt));
    let walking = fresh.filter((row) => WALKING.includes(row.stage as PipelineStage)).length;

    for (const row of fresh) {
      if (row.stage === 'fila' && walking < settings.maxActive) {
        await this.update(row.id, { stage: 'pauta' });
        walking += 1;
      }
    }

    for (const row of await this.store.db
      .select()
      .from(pipelines)
      .orderBy(asc(pipelines.createdAt))) {
      try {
        await this.advance(row);
      } catch (error) {
        console.error(`jian: pedido #${row.number} could not go on`, error);
      }
    }
  }

  private async insert(workId: string, title: string, stage: PipelineStage) {
    await this.store.transaction('pipelines', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${pipelines.number}), 0)` })
        .from(pipelines);

      await tx
        .insert(pipelines)
        .values({
          id: randomUUID(),
          number: Number(top?.max ?? 0) + 1,
          requestWorkId: workId,
          requestTitle: clip(title, 300),
          stage,
        })
        .onConflictDoNothing();
    });
  }

  private async stopWith(row: Row, note: string) {
    await this.update(row.id, { stage: 'parado', note });
    await this.notify?.(
      `[Pedido #${row.number}] "${row.requestTitle}" parou: ${note}`,
      `[Pedido #${row.number}] "${clip(row.requestTitle, 80)}" parou: ${note}`,
    ).catch(() => {});
  }

  /** Asks the author once per step: the key keeps the same message from going twice. */
  private async ask(row: Row, step: string, text: string) {
    if (row.asked === step) return;

    const agents = this.agents;
    const author = await this.author();

    if (!agents || !author) {
      await this.update(row.id, { note: 'Nenhum agente escreve para a cadeia (Subaru).' });
      return;
    }

    const session = await agents.session(author, SESSION);

    await agents.submit(author, session.id, text, `pipeline:${row.id}:${step}`);
    await this.update(row.id, { asked: step });
  }

  private async advance(row: Row): Promise<void> {
    switch (row.stage) {
      case 'pauta': {
        // The talk with the owner usually happened already: the pauta, its approved drawing and
        // even the draft may exist. Only what is missing is asked for.
        const pauta = (await this.pautasService.list()).find((item) =>
          item.links.some((link) => link.workId === row.requestWorkId),
        );
        const drawn = pauta?.prototypes.find((item) => item.approvedVersion);

        if (pauta && drawn) {
          await this.update(row.id, {
            pautaId: pauta.id,
            needsPrototype: true,
            prototypeId: drawn.id,
            stage: 'epico',
            asked: null,
            note: 'Pauta e protótipo aprovado já existiam: segue direto para o épico.',
          });
          return this.advance(await this.row(row.id));
        }

        if (pauta) await this.update(row.id, { pautaId: pauta.id });

        return this.ask(
          row,
          'pauta',
          [
            `[Pedido #${row.number}] Pedido em Priorizado na Entrada: "${row.requestTitle}" (${row.requestWorkId}). ${this.requestUrl(row.requestWorkId)}`,
            pauta
              ? `A pauta já existe: "${pauta.title}" (${pauta.id}). Use o que foi combinado nela e na conversa com o Moabe; não refaça.`
              : 'Nenhuma pauta tem este pedido ligado ainda.',
            '',
            '1. Leia o card no Work e os comentários dele.',
            pauta
              ? '2. Confira se a pauta tem a cadeia Pauta, Tela(s), Demanda; complete só o que faltar.'
              : `2. Ache a pauta deste assunto em list_pautas ou crie uma com create_pauta, com a cadeia Pauta, Tela(s), Demanda e o link {kind: "pedido", workId: "${row.requestWorkId}"}.`,
            '3. Decida se precisa de protótipo: tela nova ou mudança visível de tela, sim; regra, bug sem mudança de tela ou backend, não.',
            `4. Carregue o grupo pipeline e chame report_request com pipelineId ${row.id}, pautaId, needsPrototype, reason e, se precisar de protótipo, application (slug) e brief (o que desenhar).`,
            'Se não der para saber a origem ou a tela, não presuma: chame report_request com missing dizendo o que falta e abra uma decisão para o Moabe com propose_decision.',
          ].join('\n'),
        );
      }

      case 'prototipo': {
        if (!row.prototypeId) return this.stopWith(row, 'O protótipo não foi aberto.');

        const prototype = (await this.prototypes.list()).find(
          (item) => item.id === row.prototypeId,
        );

        if (!prototype) return this.stopWith(row, 'O protótipo sumiu.');

        const latest = prototype.versions.at(-1);

        if (latest?.status === 'failed') {
          return this.stopWith(
            row,
            `O protótipo não saiu: ${latest.error ?? 'plano recusado ou falha ao desenhar'}.`,
          );
        }

        if (latest && prototype.approvedVersion && prototype.approvedVersion >= latest.number) {
          await this.update(row.id, { stage: 'epico', asked: null });
          return this.advance({ ...(await this.row(row.id)) });
        }

        return;
      }

      case 'epico': {
        const draft = await this.draftFor(row);

        if (draft) {
          await this.update(row.id, {
            stage: 'aguardando_epico',
            epicDraftId: draft.id,
            note: null,
          });
          await this.notify?.(
            `[Pedido #${row.number}] O rascunho do épico de "${row.requestTitle}" está pronto: épico #${draft.number}, "${draft.title}".${draft.problems.length ? ` A conferência achou: ${draft.problems.join('; ')}.` : ' A conferência não achou problema.'}`,
            `[Pedido #${row.number}] Rascunho do épico pronto: "${clip(draft.title, 90)}".`,
          ).catch(() => {});
          return;
        }

        const prototype = row.prototypeId
          ? (await this.prototypes.list()).find((item) => item.id === row.prototypeId)
          : undefined;

        return this.ask(
          row,
          `epico:${row.rounds}`,
          [
            `[Pedido #${row.number}] Escreva o rascunho do épico e das subtasks de "${row.requestTitle}", seguindo a skill escrever-epico.`,
            `Carregue o grupo epics e chame draft_epic com pautaId ${row.pautaId}, requestWorkId ${row.requestWorkId}${prototype?.designUrl ? ` e prototypeUrl ${prototype.designUrl} (o protótipo aprovado)` : ''}.`,
            'Sem pergunta aberta no card: dúvida vira propose_decision para o Moabe, e o rascunho espera.',
            ...(row.note ? ['', `Correção do Moabe: ${row.note}`] : []),
          ].join('\n'),
        );
      }

      case 'aguardando_epico': {
        if (!row.epicDraftId) return;

        const [draft] = await this.store.db
          .select()
          .from(epicDrafts)
          .where(eq(epicDrafts.id, row.epicDraftId));

        if (draft?.state === 'criado') {
          const work = draft.work as { epicId?: string } | null;

          await this.update(row.id, {
            stage: 'criado',
            ...(work?.epicId ? { epicWorkId: work.epicId } : {}),
            note: null,
          });
        } else if (draft?.state === 'descartado') {
          await this.stopWith(row, 'O rascunho do épico foi recusado.');
        }

        return;
      }

      default:
        return;
    }
  }

  /** The latest draft the author wrote for this request since the chain asked for it. */
  private async draftFor(row: Row) {
    if (!row.pautaId) return undefined;

    const drafts = await this.epics.list(row.pautaId);

    return drafts.find(
      (draft) => draft.requestWorkId === row.requestWorkId && draft.state === 'rascunho',
    );
  }

  /**
   * What the author reports after reading the request: the pauta, and whether a drawing is due.
   * A drawing opens the prototype, which goes through its plan, the Reviewer and the owner.
   */
  async report(
    id: string,
    input: unknown,
    by: { profileId: string; sessionId: string },
  ): Promise<{ number: number; stage: PipelineStage; next: string }> {
    if (!(await this.isAuthor(by.profileId))) {
      throw new GatewayError(403, 'Only the chain’s author reports on a request');
    }

    const data = pipelineReportSchema.parse(input);
    const row = await this.row(id);

    if (row.stage !== 'pauta') {
      throw new GatewayError(409, `Pedido #${row.number} está em ${row.stage}, não em pauta`);
    }

    if (data.missing || !data.pautaId) {
      await this.stopWith(row, `Falta saber: ${data.missing ?? 'a pauta'}. ${data.reason}`);
      return { number: row.number, stage: 'parado', next: 'Abra a decisão para o Moabe.' };
    }

    const [pauta] = await this.store.db.select().from(pautas).where(eq(pautas.id, data.pautaId));

    if (!pauta) throw new GatewayError(404, 'Pauta not found');

    if (!data.needsPrototype) {
      await this.update(row.id, {
        pautaId: data.pautaId,
        needsPrototype: false,
        stage: 'epico',
        asked: null,
        note: data.reason,
      });
      await this.advance(await this.row(row.id));
      return { number: row.number, stage: 'epico', next: 'Sem protótipo: escreva o épico.' };
    }

    if (!data.application || !data.brief) {
      throw new GatewayError(400, 'A prototype needs application and brief');
    }

    const prototype = await this.prototypes.create(
      {
        application: data.application,
        title: clip(row.requestTitle, 200),
        brief: data.brief,
        pautaId: data.pautaId,
        requestUrl: this.requestUrl(row.requestWorkId),
      },
      { kind: 'agent', profileId: by.profileId, sessionId: by.sessionId },
    );

    await this.update(row.id, {
      pautaId: data.pautaId,
      needsPrototype: true,
      prototypeId: prototype.id,
      stage: 'prototipo',
      note: data.reason,
    });

    return {
      number: row.number,
      stage: 'prototipo',
      next: 'O protótipo foi aberto; o plano dele chega a você em seguida.',
    };
  }

  /** The prototype the owner refused stops its request. */
  async prototypeRefused(prototypeId: string, reason?: string) {
    const [row] = await this.store.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.prototypeId, prototypeId));

    if (row && row.stage === 'prototipo') {
      await this.update(row.id, {
        stage: 'parado',
        note: `Você recusou o protótipo${reason ? `: ${reason}` : '.'}`,
      });
    }
  }

  /**
   * The owner's words on a draft: it is set aside and the author writes it again with them. A
   * draft that did not come from the chain is corrected in the panel instead.
   */
  async revise(draftId: string, text: string): Promise<string> {
    const [row] = await this.store.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.epicDraftId, draftId));

    if (!row) {
      throw new GatewayError(
        409,
        'Este rascunho não veio da cadeia: corrija pelo painel, em Pautas.',
      );
    }

    await this.epics.discard(draftId);
    await this.update(row.id, {
      stage: 'epico',
      epicDraftId: null,
      rounds: row.rounds + 1,
      asked: null,
      note: text,
    });
    await this.advance(await this.row(row.id));

    return 'o autor reescreve com a sua correção.';
  }

  private presentRequest(
    row: typeof requestDrafts.$inferSelect,
    pautaTitle?: string,
  ): RequestDraft {
    return {
      id: row.id,
      number: row.number,
      pautaId: row.pautaId,
      ...(pautaTitle ? { pautaTitle } : {}),
      title: row.title,
      description: row.description,
      kind: row.kind as RequestDraft['kind'],
      state: row.state as RequestDraft['state'],
      ...(row.workId ? { workId: row.workId } : {}),
      createdAt: row.createdAt.toISOString(),
    };
  }

  async requests(): Promise<RequestDraft[]> {
    const rows = await this.store.db
      .select({ row: requestDrafts, pauta: pautas.title })
      .from(requestDrafts)
      .leftJoin(pautas, eq(pautas.id, requestDrafts.pautaId))
      .orderBy(desc(requestDrafts.createdAt))
      .limit(100);

    return rows.map(({ row, pauta }) => this.presentRequest(row, pauta ?? undefined));
  }

  /**
   * The author, at the end of a talk with the owner, proposes the request for the Entrada. It
   * waits in the inbox; nothing reaches the board before the owner's OK.
   */
  async proposeRequest(input: unknown, by: { profileId: string }): Promise<RequestDraft> {
    if (!(await this.isAuthor(by.profileId))) {
      throw new GatewayError(403, 'Only the chain’s author proposes a request');
    }

    const data = requestProposalSchema.parse(input);
    const [pauta] = await this.store.db.select().from(pautas).where(eq(pautas.id, data.pautaId));

    if (!pauta) throw new GatewayError(404, 'Pauta not found');

    const id = randomUUID();

    await this.store.transaction('request_drafts', async (tx) => {
      const [top] = await tx
        .select({ max: sql<number>`coalesce(max(${requestDrafts.number}), 0)` })
        .from(requestDrafts);

      await tx.insert(requestDrafts).values({
        id,
        number: Number(top?.max ?? 0) + 1,
        pautaId: data.pautaId,
        title: data.title,
        description: data.description,
        kind: data.kind,
        state: 'rascunho',
        proposedBy: by.profileId,
      });
    });

    const [row] = await this.store.db.select().from(requestDrafts).where(eq(requestDrafts.id, id));
    const draft = this.presentRequest(assertFound(row, 'Request draft'), pauta.title);

    await this.notify?.(
      `[Pedido proposto] O Subaru escreveu o pedido "${draft.title}" para a Entrada, da pauta "${pauta.title}".`,
      `[Pedido proposto] "${clip(draft.title, 90)}" (pauta ${clip(pauta.title, 60)}).`,
    ).catch(() => {});

    return draft;
  }

  /** The owner's OK: the request goes to the Entrada, in Novo, linked to its pauta. */
  async createRequest(id: string): Promise<RequestDraft> {
    const [row] = await this.store.db.select().from(requestDrafts).where(eq(requestDrafts.id, id));
    const draft = assertFound(row, 'Request draft');

    if (draft.state !== 'rascunho') {
      throw new GatewayError(409, `O pedido #${draft.number} já está ${draft.state}`);
    }

    const profileId = await this.keyProfile();

    if (!profileId) throw new GatewayError(409, 'No agent reaches the work tracker');

    const client = await this.open(profileId, { workspaceId: this.target.workspaceId });
    const created = (await client.call('POST', '/activities', {
      board_id: this.target.entryBoardId,
      status_id: this.request.newStatusId,
      title: draft.title,
      description: draft.description,
    })) as { id: string };
    const kind = this.request.kinds[draft.kind as keyof RequestTarget['kinds']];

    await client
      .call('PATCH', `/activities/${created.id}`, {
        custom_field_values: [
          { field_id: this.request.requesterFieldId, value: this.request.requester },
          ...(kind ? [{ field_id: this.request.kindFieldId, value: { option_id: kind } }] : []),
        ],
      })
      .catch(() => undefined);
    await this.store.db
      .update(requestDrafts)
      .set({ state: 'criado', workId: created.id, updatedAt: new Date(this.clock()) })
      .where(eq(requestDrafts.id, id));

    const pauta = await this.pautasService.get(draft.pautaId);

    await this.pautasService.update(pauta.id, {
      links: [...pauta.links, { kind: 'pedido', workId: created.id, title: draft.title }],
    });

    return this.presentRequest({ ...draft, state: 'criado', workId: created.id }, pauta.title);
  }

  async discardRequest(id: string): Promise<void> {
    await this.store.db
      .update(requestDrafts)
      .set({ state: 'descartado', updatedAt: new Date(this.clock()) })
      .where(eq(requestDrafts.id, id));
  }
}
