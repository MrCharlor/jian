import { randomUUID } from 'node:crypto';
import {
  type ModelSelection,
  type Plan,
  type PlanAction,
  type PlanFinding,
  type PlanReply,
  type PlanSettings,
  planActionSchema,
  planRejectSchema,
  planReturnSchema,
  planReviewSchema,
  planSettingsPatchSchema,
  planSettingsSchema,
  planStateSchema,
  planWriteSchema,
  type Routines,
} from '@jian/contracts';
import { asc, eq } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Quality } from '../quality/service.js';
import { toSchedule } from '../schedules/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySettings, schedules } from '../storage/schema.js';
import {
  countExecuted,
  findPlan,
  insertPlan,
  listPlanRows,
  type PlanRow,
  profileNames,
  prototypeOf,
  recentCorrections,
  updatePlan,
} from './repository.js';

/** A message handed to an agent: into its conversation, as a new turn or between steps. */
type Submit = (
  profileId: string,
  sessionId: string,
  text: string,
  key: string,
  model?: ModelSelection,
) => Promise<unknown>;

/** What a plan unlocks or stops: the prototype version that waits for it. */
export type PlanTarget = {
  release(prototypeId: string, version: number): Promise<void>;
  refuse(prototypeId: string, version: number, reason: string): Promise<void>;
};

type Via = 'panel' | 'channel' | 'api';

/** A run's text is capped at 8000 characters; the rest of a plan is read with read_plan. */
const MESSAGE_LIMIT = 7800;

const OPEN_STATES = new Set(['escrevendo', 'em_revisao', 'devolvido', 'aguardando_po']);

const DEFAULTS: Omit<PlanSettings, 'action'> = { automatic: false, maxRounds: 2 };

/** The automation name corrections of an action are kept under, as Quality names them. */
const CORRECTION_PREFIX: Record<PlanAction, string> = { prototype: 'prototipo:' };

const KIND_LABEL: Record<PlanFinding['kind'], string> = {
  divergencia: 'divergência',
  regra_sensivel: 'regra sensível',
  lacuna: 'lacuna',
};

const settingsKey = (action: PlanAction) => `plans:${action}`;

const clip = (text: string, limit = MESSAGE_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}\n[…] (leia inteiro com read_plan)` : text;

const findingLines = (findings: PlanFinding[]) =>
  findings
    .map(
      (item) =>
        `- [${KIND_LABEL[item.kind]}] ${item.text}${item.source ? ` (${item.source})` : ''}`,
    )
    .join('\n');

/**
 * Plans before actions (B18). The author writes what it will do and where each thing came
 * from; the Reviewer reads it against the owner's rules and corrections, and approves only a
 * plan with no finding. A plan goes back to its author a limited number of times, then waits
 * for the owner with what was found. An approved plan waits for the owner's OK unless the
 * action is automatic; then the action runs with the revised plan as part of its request.
 */
export class Plans {
  private submit?: Submit;
  private owner?: (text: string) => Promise<unknown>;
  private target?: PlanTarget;

  constructor(
    private readonly store: Store,
    private readonly profiles: {
      profiles(): Promise<Array<{ id: string; name: string }>>;
    },
    private readonly sessions: { gatewaySession(profileId: string): Promise<{ id: string }> },
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(submit: Submit) {
    this.submit = submit;
  }

  /** Where "Plano #N esperando você" is said: the owner's own conversation. */
  useOwner(owner: (text: string) => Promise<unknown>) {
    this.owner = owner;
  }

  usePrototypes(target: PlanTarget) {
    this.target = target;
  }

  async settings(action: unknown): Promise<PlanSettings> {
    const name = planActionSchema.parse(action);
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, settingsKey(name)))
      .limit(1);
    const saved = (row?.value ?? {}) as Partial<PlanSettings>;

    return planSettingsSchema.parse({ ...DEFAULTS, ...saved, action: name });
  }

  async updateSettings(action: unknown, input: unknown): Promise<PlanSettings> {
    const name = planActionSchema.parse(action);
    const patch = planSettingsPatchSchema.parse(input ?? {});
    const current = await this.settings(name);
    const merged: Record<string, unknown> = { ...current };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }

    const known = new Set((await this.profiles.profiles()).map((profile) => profile.id));

    for (const key of ['authorProfileId', 'reviewerProfileId'] as const) {
      const id = merged[key];
      if (typeof id === 'string' && !known.has(id)) {
        throw new GatewayError(404, `Profile ${id} not found`);
      }
    }

    const value = planSettingsSchema.parse(merged);

    await this.store.db
      .insert(gatewaySettings)
      .values({ key: settingsKey(name), value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date(this.clock()) },
      });

    return value;
  }

  /**
   * Who writes and who reviews, or nothing when the action runs as before: no Reviewer set,
   * or no author to be found.
   */
  private async people(action: PlanAction, requester?: string) {
    const config = await this.settings(action);

    if (!config.reviewerProfileId) return undefined;

    const all = await this.profiles.profiles();
    const exists = (id?: string) =>
      id && all.some((profile) => profile.id === id) ? id : undefined;
    const reviewer = exists(config.reviewerProfileId);
    const author =
      exists(config.authorProfileId) ??
      exists(requester) ??
      all.find((profile) => profile.name.trim().toLowerCase() === 'subaru')?.id;

    return reviewer && author ? { config, reviewer, author } : undefined;
  }

  /** Whether an action asked for now goes through a plan first. */
  async wanted(action: PlanAction, requester?: string) {
    return Boolean(await this.people(action, requester));
  }

  /**
   * Opens the plan of a prototype version and asks its author to write it. The version stays
   * out of the generator's queue until the plan is approved.
   */
  async openForPrototype(input: {
    prototypeId: string;
    version: number;
    profileId?: string;
    sessionId?: string;
  }): Promise<Plan | undefined> {
    const people = await this.people('prototype', input.profileId);

    if (!people) return undefined;

    const prototype = assertFound(await prototypeOf(this.store.db, input.prototypeId), 'Prototype');
    const session =
      people.author === input.profileId && input.sessionId
        ? input.sessionId
        : (await this.sessions.gatewaySession(people.author)).id;
    const now = new Date(this.clock());
    const id = randomUUID();

    await this.store.transaction('plans', (tx) =>
      insertPlan(tx, {
        id,
        action: 'prototype',
        prototypeId: input.prototypeId,
        prototypeVersion: input.version,
        pautaId: prototype.pautaId ?? null,
        authorProfileId: people.author,
        authorSessionId: session,
        reviewerProfileId: people.reviewer,
        findings: [],
        rounds: 0,
        state: 'escrevendo',
        createdAt: now,
        updatedAt: now,
      }),
    );

    const plan = await this.get(id);

    await this.tellAuthor(
      plan,
      [
        `[Plano #${plan.number}] Antes de gerar o protótipo "${prototype.title}" (${prototype.applicationName}), escreva o plano com write_plan (planId ${plan.id}) e pare.`,
        'O plano diz: o que vai fazer; de onde tirou cada coisa (pauta, decisão, regra, print); o que assumiu; o que vai entregar. Não invente: o que faltar vira pergunta ao Moabe dentro do plano.',
        'Não chame request_prototype de novo: a Atena gera a tela depois que o plano for aprovado.',
        '',
        prototype.requestUrl ? `Pedido no Work: ${prototype.requestUrl}` : '',
        prototype.pautaId ? `Pauta: ${prototype.pautaId}` : '',
        '## O que a tela precisa fazer',
        prototype.brief,
      ]
        .filter((line) => line !== '')
        .join('\n'),
      'aberto',
    );

    return plan;
  }

  private async view(row: PlanRow, names?: Map<string, string>): Promise<Plan> {
    const people = names ?? (await profileNames(this.store.db));
    const prototype = row.prototypeId ? await prototypeOf(this.store.db, row.prototypeId) : null;
    const state = planStateSchema.parse(row.state);
    const author = row.authorProfileId ? people.get(row.authorProfileId) : undefined;
    const reviewer = row.reviewerProfileId ? people.get(row.reviewerProfileId) : undefined;

    return {
      id: row.id,
      number: row.number,
      action: planActionSchema.parse(row.action),
      ...(row.prototypeId ? { prototypeId: row.prototypeId } : {}),
      ...(row.prototypeVersion ? { prototypeVersion: row.prototypeVersion } : {}),
      title: prototype?.title ?? 'Protótipo removido',
      ...(prototype ? { application: prototype.application } : {}),
      ...(row.pautaId ? { pautaId: row.pautaId } : {}),
      ...(row.authorProfileId ? { authorProfileId: row.authorProfileId } : {}),
      ...(author ? { authorName: author } : {}),
      ...(row.reviewerProfileId ? { reviewerProfileId: row.reviewerProfileId } : {}),
      ...(reviewer ? { reviewerName: reviewer } : {}),
      ...(row.original ? { original: row.original } : {}),
      ...(row.revised ? { revised: row.revised } : {}),
      findings: row.findings,
      rounds: row.rounds,
      state,
      ...(row.note ? { note: row.note } : {}),
      ...(row.approvedBy ? { approvedBy: row.approvedBy as NonNullable<Plan['approvedBy']> } : {}),
      ...(row.decidedVia ? { decidedVia: row.decidedVia as NonNullable<Plan['decidedVia']> } : {}),
      ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
      ...(row.executedAt ? { executedAt: row.executedAt.toISOString() } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async row(which: { id: string } | { number: number }, db: Queryable = this.store.db) {
    return assertFound(await findPlan(db, which), 'Plan');
  }

  async get(id: string) {
    return this.view(await this.row({ id }));
  }

  /** By id or by the number the agents and the owner use. */
  async read(which: { id: string } | { number: number }) {
    return this.view(await this.row(which));
  }

  async list(query: unknown = {}): Promise<Plan[]> {
    const state = (query as { state?: unknown })?.state;
    const rows = await listPlanRows(
      this.store.db,
      state === undefined ? undefined : planStateSchema.parse(state),
    );
    const names = await profileNames(this.store.db);

    return Promise.all(rows.map((row) => this.view(row, names)));
  }

  /** The author's plan, first or rewritten; it goes straight to the Reviewer. */
  async write(id: string, input: unknown, by: { profileId: string }) {
    const { text } = planWriteSchema.parse(input);

    await this.store.transaction('plans', async (tx) => {
      const row = await this.row({ id }, tx);

      if (row.authorProfileId !== by.profileId) {
        throw new GatewayError(403, `Plan #${row.number} is not yours to write`);
      }
      if (!['escrevendo', 'devolvido'].includes(row.state)) {
        throw new GatewayError(
          409,
          `Plan #${row.number} is ${row.state}; it is not waiting for you`,
        );
      }

      await updatePlan(tx, id, {
        original: text,
        state: 'em_revisao',
        updatedAt: new Date(this.clock()),
      });
    });

    const plan = await this.get(id);

    await this.askReview(plan);

    return plan;
  }

  /** The owner's recent corrections of this action: the Reviewer's rules beyond the memories. */
  private async curation(action: PlanAction) {
    const rows = await recentCorrections(this.store.db, CORRECTION_PREFIX[action]);

    return rows
      .filter((row) => row.note)
      .map(
        (row) =>
          `- ${row.createdAt.toISOString().slice(0, 10)} (${row.automation}): ${row.note?.slice(0, 400)}`,
      );
  }

  private async askReview(plan: Plan) {
    const row = await this.row({ id: plan.id });
    const config = await this.settings(plan.action);

    if (!this.submit || !row.reviewerProfileId) return;

    const session = await this.sessions.gatewaySession(row.reviewerProfileId);
    const rules = await this.curation(plan.action);
    const text = [
      `[Plano #${plan.number} para revisar] Ação: protótipo "${plan.title}"${plan.application ? ` (${plan.application})` : ''}, escrito por ${plan.authorName ?? 'um agente'}. Volta ${plan.rounds + 1}.`,
      `Revise com review_plan (planId ${plan.id}). Leia contra as regras do Moabe: memórias, preferencias-do-po.md, padrao-telas.md e as decisões da pauta. Devolva o plano mais curto e os achados, cada um com a fonte:`,
      '- divergência: contradiz uma regra, uma decisão ou o pedido;',
      '- regra sensível: toca faturamento, fiscal (Tipos e Natureza), dado de cliente (CPF, LGPD), preço, permissão ou dado em produção;',
      '- lacuna: falta informação para executar sem inventar.',
      'Com qualquer achado, não aprove. Você não executa nada.',
      rules.length
        ? `\n## Correções recentes do Moabe nesta ação (barre o erro repetido)\n${rules.join('\n')}`
        : '',
      '\n## Plano',
      plan.original ?? '',
    ]
      .filter((line) => line !== '')
      .join('\n');

    await this.submit(
      row.reviewerProfileId,
      session.id,
      clip(text),
      `plan:${plan.id}:review:${plan.rounds + 1}`,
      config.reviewerModel,
    ).catch(() => {});
  }

  /**
   * The Reviewer's answer. A plan with any finding is not approved: it goes back to its author
   * while it has returns left, then waits for the owner with the findings. An approved plan
   * runs at once when the action is automatic, and waits for the owner otherwise.
   */
  async review(id: string, input: unknown, by: { profileId: string }) {
    const data = planReviewSchema.parse(input);
    const approved = data.approved && data.findings.length === 0;
    const config = await this.settings(planActionSchema.parse((await this.row({ id })).action));

    const next = await this.store.transaction('plans', async (tx) => {
      const row = await this.row({ id }, tx);

      if (row.reviewerProfileId !== by.profileId) {
        throw new GatewayError(403, `Plan #${row.number} is not yours to review`);
      }
      if (row.state !== 'em_revisao') {
        throw new GatewayError(
          409,
          `Plan #${row.number} is ${row.state}; it is not waiting for a review`,
        );
      }

      const rounds = row.rounds + 1;
      const state = approved
        ? config.automatic
          ? 'aprovado'
          : 'aguardando_po'
        : rounds > config.maxRounds
          ? 'aguardando_po'
          : 'devolvido';
      const now = new Date(this.clock());

      await updatePlan(tx, id, {
        revised: data.revised,
        findings: data.findings,
        rounds,
        state,
        ...(state === 'aprovado'
          ? { approvedBy: 'automatico', decidedVia: 'automatico', decidedAt: now }
          : {}),
        updatedAt: now,
      });

      return state;
    });

    const plan = await this.get(id);

    if (next === 'aprovado') return this.execute(plan);

    if (next === 'devolvido') {
      await this.tellAuthor(
        plan,
        [
          `[Plano #${plan.number}] O Revisor devolveu (volta ${plan.rounds} de ${config.maxRounds}). Achados:`,
          findingLines(plan.findings),
          `Corrija com write_plan (planId ${plan.id}). Lacuna vira pergunta ao Moabe dentro do plano, nunca invenção. O plano revisado está em read_plan.`,
        ].join('\n'),
        `devolvido:${plan.rounds}`,
      );
    }

    if (next === 'aguardando_po') await this.tellOwner(plan);

    return plan;
  }

  private async tellAuthor(plan: Plan, text: string, step: string) {
    const row = await this.row({ id: plan.id });

    if (!this.submit || !row.authorProfileId || !row.authorSessionId) return;

    await this.submit(
      row.authorProfileId,
      row.authorSessionId,
      clip(text),
      `plan:${plan.id}:${step}`,
    ).catch(() => {});
  }

  private async tellOwner(plan: Plan) {
    const verdict = plan.findings.length
      ? `${plan.findings.length} achado(s) depois de ${plan.rounds} volta(s):\n${findingLines(plan.findings)}`
      : 'o Revisor aprovou.';

    await this.owner?.(
      clip(
        `Plano #${plan.number} esperando você: protótipo "${plan.title}". ${verdict}\nResponda "ok plano ${plan.number}" ou "corrige plano ${plan.number}: motivo", ou abra Planos no painel.`,
      ),
    ).catch(() => {});
  }

  /** Runs the action the plan is for; the prototype then goes to the generator's queue. */
  private async execute(plan: Plan) {
    if (plan.prototypeId && plan.prototypeVersion) {
      await this.target?.release(plan.prototypeId, plan.prototypeVersion);
    }

    const now = new Date(this.clock());

    await updatePlan(this.store.db, plan.id, {
      state: 'executado',
      executedAt: now,
      updatedAt: now,
    });

    return this.get(plan.id);
  }

  private async openRow(which: { id: string } | { number: number }, tx: Queryable) {
    const row = await this.row(which, tx);

    if (!OPEN_STATES.has(row.state)) {
      throw new GatewayError(409, `Plan #${row.number} is already ${row.state}`);
    }

    return row;
  }

  /** The owner's OK. A plan not written yet has nothing to approve. */
  async approve(which: { id: string } | { number: number }, via: Via = 'api') {
    const id = await this.store.transaction('plans', async (tx) => {
      const row = await this.openRow(which, tx);

      if (!row.original) {
        throw new GatewayError(409, `Plan #${row.number} has not been written yet`);
      }

      const now = new Date(this.clock());

      await updatePlan(tx, row.id, {
        state: 'aprovado',
        approvedBy: 'owner',
        decidedVia: via,
        decidedAt: now,
        updatedAt: now,
      });

      return row.id;
    });

    return this.execute(await this.get(id));
  }

  /**
   * The owner's "corrige": the plan goes back to its author with the owner's words, its returns
   * start again, and the words are kept as a correction of the action.
   */
  async giveBack(which: { id: string } | { number: number }, input: unknown, via: Via = 'api') {
    const { reason } = planReturnSchema.parse(input);

    const id = await this.store.transaction('plans', async (tx) => {
      const row = await this.openRow(which, tx);
      const now = new Date(this.clock());

      await updatePlan(tx, row.id, {
        state: 'devolvido',
        rounds: 0,
        note: reason,
        decidedVia: via,
        decidedAt: now,
        updatedAt: now,
      });
      await this.correct(tx, row, 'redone', reason, via);

      return row.id;
    });

    const plan = await this.get(id);

    await this.tellAuthor(
      plan,
      `[Plano #${plan.number}] O Moabe devolveu: ${reason}\nReescreva com write_plan (planId ${plan.id}). O plano atual está em read_plan.`,
      `moabe:${Date.parse(plan.updatedAt)}`,
    );

    return plan;
  }

  /** The owner's no: the plan ends and the version it held fails with the reason. */
  async reject(which: { id: string } | { number: number }, input: unknown, via: Via = 'api') {
    const { reason } = planRejectSchema.parse(input ?? {});

    const id = await this.store.transaction('plans', async (tx) => {
      const row = await this.openRow(which, tx);
      const now = new Date(this.clock());

      await updatePlan(tx, row.id, {
        state: 'recusado',
        ...(reason ? { note: reason } : {}),
        decidedVia: via,
        decidedAt: now,
        updatedAt: now,
      });
      await this.correct(tx, row, 'rejected', reason, via);

      return row.id;
    });

    const plan = await this.get(id);

    if (plan.prototypeId && plan.prototypeVersion) {
      await this.target?.refuse(
        plan.prototypeId,
        plan.prototypeVersion,
        `Plano #${plan.number} recusado pelo PO${reason ? `: ${reason}` : ''}`,
      );
    }

    return plan;
  }

  private async correct(
    tx: Queryable,
    row: PlanRow,
    kind: 'redone' | 'rejected',
    note: string | undefined,
    via: Via,
  ) {
    const prototype = row.prototypeId ? await prototypeOf(tx, row.prototypeId) : null;

    if (!row.authorProfileId) return;

    await this.quality?.record(tx, row.authorProfileId, {
      kind,
      via,
      action: `${CORRECTION_PREFIX[planActionSchema.parse(row.action)]}${prototype?.application ?? 'plano'}`,
      original: `Plano #${row.number}: ${(row.revised ?? row.original ?? '').slice(0, 3000)}`,
      ...(note ? { note } : {}),
    });
  }

  /** "ok plano 3" or "corrige plano 3: …" from the owner in a chat. */
  async fromChat(reply: PlanReply) {
    return reply.approve
      ? this.approve({ number: reply.number }, 'channel')
      : this.giveBack({ number: reply.number }, { reason: reply.reason ?? '' }, 'channel');
  }

  static notice(plan: Plan) {
    return plan.state === 'executado'
      ? `[Plano #${plan.number}] O Moabe aprovou o plano de "${plan.title}"; o protótipo entrou na fila.`
      : `[Plano #${plan.number}] O Moabe devolveu o plano de "${plan.title}" ao autor: ${plan.note ?? ''}`;
  }

  /** The Routines page: every schedule, the plans waiting, and how each action is doing. */
  async routines(): Promise<Routines> {
    const names = await profileNames(this.store.db);
    const rows = await this.store.db.select().from(schedules).orderBy(asc(schedules.createdAt));
    const waiting = await this.list({ state: 'aguardando_po' });
    const actions = await Promise.all(
      planActionSchema.options.map(async (action) => {
        const config = await this.settings(action);
        const [last] = await recentCorrections(this.store.db, CORRECTION_PREFIX[action], 1);

        return {
          action,
          automatic: config.automatic,
          reviewer: Boolean(config.reviewerProfileId),
          executed: await countExecuted(this.store.db, action),
          clean: await countExecuted(this.store.db, action, last?.createdAt),
          ...(last ? { lastCorrectionAt: last.createdAt.toISOString() } : {}),
        };
      }),
    );

    return {
      schedules: rows.map((row) => ({
        ...toSchedule(row),
        profileName: names.get(row.profileId) ?? '',
      })),
      waiting,
      actions,
    };
  }
}
