import { randomUUID } from 'node:crypto';
import {
  type EntrySync,
  type KnowledgeRule,
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
import { scopeLabel } from '../knowledge/match.js';
import type { Knowledge } from '../knowledge/service.js';
import type { Quality } from '../quality/service.js';
import { toSchedule } from '../schedules/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySettings, schedules } from '../storage/schema.js';
import {
  countExecuted,
  findPlan,
  insertPlan,
  listPlanRows,
  openEntryPlans,
  openPriorityPlans,
  type PlanRow,
  priorityHistory,
  profileNames,
  proposalOf,
  prototypeOf,
  questionedPlans,
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

/** How the order is applied on the board, and how a refused plan ends its proposal. */
export type PriorityTarget = {
  applyApproved(proposalId: string, via: 'panel' | 'channel' | 'api' | 'agent'): Promise<unknown>;
  close(proposalId: string, note: string): Promise<unknown>;
};

/** How the moves of an approved entry sync are made: each against the card as it is now. */
export type EntryRunner = {
  apply(sync: EntrySync): Promise<EntrySync>;
};

type Via = 'panel' | 'channel' | 'api';

type ProposalRow = NonNullable<Awaited<ReturnType<typeof proposalOf>>>;

/** A run's text is capped at 8000 characters; the rest of a plan is read with read_plan. */
const MESSAGE_LIMIT = 7800;

const WEEK_MS = 7 * 86_400_000;

/** Weeks the question metric looks back. */
const WEEKS_SHOWN = 8;

const OPEN_STATES = new Set(['escrevendo', 'em_revisao', 'devolvido', 'aguardando_po']);

const DEFAULTS: Omit<PlanSettings, 'action'> = { automatic: false, maxRounds: 2 };

/**
 * The automation name corrections of an action are kept under, as Quality names them:
 * `prototipo:<application>` for a prototype, `priorizacao` for the order of the board.
 */
const CORRECTION_PREFIX: Record<PlanAction, string> = {
  prototype: 'prototipo:',
  priority: 'priorizacao',
  entry_sync: 'entrada',
};

/** How a plan's note starts when the approved order could not be applied on the board. */
const APPLY_FAILED = 'Não aplicou no Work:';

/** Who writes the plan when no author is set and the requester is gone. */
const FALLBACK_AUTHOR: Record<PlanAction, string> = {
  prototype: 'subaru',
  priority: 'otto',
  entry_sync: 'otto',
};

const what = (plan: Pick<Plan, 'action' | 'title'>) =>
  plan.action === 'priority'
    ? `${plan.title} (ordem do Priorizado)`
    : plan.action === 'entry_sync'
      ? plan.title
      : `protótipo "${plan.title}"`;

/** One line per move, as the Reviewer and the owner read it: card, from → to, why. */
export function entryPlanText(sync: EntrySync) {
  const board = (move: EntrySync['moves'][number]) =>
    move.board === 'epics' ? 'Épico' : 'Pedido na Entrada';

  return [
    `Leitura da Entrada, dos épicos e das tasks da Sigma em ${sync.readAt}.`,
    '',
    '## Movimentos',
    ...(sync.moves.length
      ? sync.moves.map(
          (move, index) =>
            `${index + 1}. ${board(move)} "${move.title}": ${move.from} → ${move.to}, ${move.reason}`,
        )
      : ['(nenhum)']),
    ...(sync.stale.length
      ? [
          '',
          '## Pedidos em Priorizado sem épico (não se movem; o Moabe decide)',
          ...sync.stale.map((item) => `- "${item.title}": há ${item.days} dias`),
        ]
      : []),
    ...(sync.skipped.length
      ? [
          '',
          '## Deixados de fora',
          ...sync.skipped.map((item) => `- "${item.title}" (→ ${item.to}): ${item.reason}`),
        ]
      : []),
  ].join('\n');
}

/** What makes two reads the same plan: the same moves and the same requests standing still. */
const entrySignature = (sync: EntrySync) =>
  JSON.stringify([
    sync.moves.map((move) => `${move.workId}:${move.toStatusId}`).sort(),
    sync.stale.map((item) => item.workId).sort(),
  ]);

/** A proposed order as the Reviewer and the owner read it: one numbered line per card. */
function priorityPlanText(proposal: ProposalRow) {
  const today = proposal.current.map((card, index) => `${index + 1}. ${card.title}`);

  return [
    `Priorização #${proposal.number}, proposta por ${proposal.proposedBy ?? 'um agente'}.`,
    `Resumo: ${proposal.summary}`,
    '',
    '## Ordem proposta',
    ...proposal.cards.map(
      (card, index) =>
        `${index + 1}. ${card.title}${card.raise ? ' (sobe do Aprovado)' : ''}: ${card.reason ?? 'sem motivo (o agente não citou; fica no fim)'}`,
    ),
    '',
    '## Ordem de hoje no Work',
    ...(today.length ? today : ['(coluna vazia)']),
  ].join('\n');
}

const KIND_LABEL: Record<PlanFinding['kind'], string> = {
  divergencia: 'divergência',
  regra_sensivel: 'regra sensível',
  lacuna: 'lacuna',
};

const settingsKey = (action: PlanAction) => `plans:${action}`;

const clip = (text: string, limit = MESSAGE_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}\n[…] (leia inteiro com read_plan)` : text;

/** The question budget, as the author is told it (B19). */
const AUTHOR_BUDGET = [
  'Orçamento de perguntas: no máximo 3 perguntas ao Moabe, só as que mudam o que vai ser feito e não têm padrão razoável. Liste-as também em questions do write_plan.',
  'Antes de perguntar, procure nas regras abaixo, com search_knowledge, nas decisões da pauta, nas preferências do PO e no guia do design system. Achou, use e cite a fonte ("regra #N").',
  'O resto vira suposição com padrão sugerido, numa seção "Suposições" do plano, que o Moabe corrige na curadoria.',
  'Suposição que toca regra sensível (faturamento, fiscal, dado de cliente, preço, permissão, dado em produção) vira pergunta, mesmo passando de 3.',
];

/** What the Reviewer holds the plan to, beside the rules (B19). */
const REVIEW_BUDGET = [
  'Cobre o orçamento de perguntas (no máximo 3 por plano):',
  '- pergunta que já tem resposta na base (regras abaixo ou search_knowledge) é divergência; cite "regra #N";',
  '- mais de 3 perguntas, sem contar as que tocam regra sensível, é divergência: o excesso vira suposição com padrão sugerido;',
  '- suposição que toca regra sensível e não virou pergunta é regra sensível;',
  '- duas regras em conflito: vale a mais recente e a mais específica; aponte o conflito como divergência para o Moabe resolver uma vez.',
];

/** Characters of a message the rules may take; the rest of the base is a search away. */
const RULES_ROOM = 3500;

/** The rules a plan carries, as many as fit in `room` characters, most specific first. */
function ruleSection(rules: KnowledgeRule[], room: number) {
  if (!rules.length) return '';

  const head = '\n## Regras da base que valem aqui (siga e cite "regra #N")';
  const lines = [head];
  let used = head.length;

  for (const [index, rule] of rules.entries()) {
    const text = rule.text.length > 240 ? `${rule.text.slice(0, 240)}…` : rule.text;
    const line = `- regra #${rule.number}${rule.sensitive ? ' (sensível)' : ''} [${scopeLabel(rule.scope)}]: ${text}`;

    if (used + line.length + 1 > Math.min(room, RULES_ROOM)) {
      lines.push(`- (mais ${rules.length - index} regra(s): search_knowledge)`);
      break;
    }

    lines.push(line);
    used += line.length + 1;
  }

  return lines.length > 1 ? lines.join('\n') : '';
}

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
  private owner?: (text: string, short?: string) => Promise<unknown>;
  private target?: PlanTarget;
  private board?: PriorityTarget;
  private knowledge?: Pick<Knowledge, 'relevant' | 'learn'>;
  private entry?: EntryRunner;

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
  useOwner(owner: (text: string, short?: string) => Promise<unknown>) {
    this.owner = owner;
  }

  usePrototypes(target: PlanTarget) {
    this.target = target;
  }

  usePriorities(board: PriorityTarget) {
    this.board = board;
  }

  /** The rules a plan carries, and the Curator told of what the owner answered. */
  useKnowledge(knowledge: Pick<Knowledge, 'relevant' | 'learn'>) {
    this.knowledge = knowledge;
  }

  useEntrySync(entry: EntryRunner) {
    this.entry = entry;
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
      all.find((profile) => profile.name.trim().toLowerCase() === FALLBACK_AUTHOR[action])?.id;

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
    const text = [
      `[Plano #${plan.number}] Antes de gerar o protótipo "${prototype.title}" (${prototype.applicationName}), escreva o plano com write_plan (planId ${plan.id}) e pare.`,
      'O plano diz: o que vai fazer; de onde tirou cada coisa (pauta, decisão, regra, print); o que assumiu; o que vai entregar. Não invente: o que faltar e mudar o trabalho vira pergunta ao Moabe dentro do plano.',
      ...AUTHOR_BUDGET,
      'Não chame request_prototype de novo: a Atena gera a tela depois que o plano for aprovado.',
      '',
      prototype.requestUrl ? `Pedido no Work: ${prototype.requestUrl}` : '',
      prototype.pautaId ? `Pauta: ${prototype.pautaId}` : '',
      '## O que a tela precisa fazer',
      prototype.brief,
    ]
      .filter((line) => line !== '')
      .join('\n');
    const rules = await this.rulesFor({
      applications: [prototype.application, prototype.applicationName],
      screen: prototype.title,
      text: `${prototype.title} ${prototype.brief}`,
    });

    await this.tellAuthor(
      plan,
      `${text}${ruleSection(rules, MESSAGE_LIMIT - text.length - 100)}`,
      'aberto',
    );

    return plan;
  }

  /**
   * A proposed order becomes the plan itself: its cards and reasons are what the Reviewer
   * reads, and the board is left as it is until the plan is approved. The plan its author was
   * asked to redo takes the new proposal and goes back to the Reviewer; any other open
   * prioritization plan ends, since its proposal was just replaced.
   */
  async openForPriority(input: {
    proposalId: string;
    profileId: string;
    sessionId?: string;
  }): Promise<Plan | undefined> {
    const people = await this.people('priority', input.profileId);

    if (!people) return undefined;

    const proposal = assertFound(
      await proposalOf(this.store.db, input.proposalId),
      'Priority proposal',
    );
    const original = priorityPlanText(proposal);
    const now = new Date(this.clock());

    const id = await this.store.transaction('plans', async (tx) => {
      const open = await openPriorityPlans(tx);
      const redo = open.find(
        (row) =>
          row.authorProfileId === input.profileId &&
          ['escrevendo', 'devolvido'].includes(row.state),
      );

      for (const row of open) {
        if (row.id === redo?.id) continue;
        await updatePlan(tx, row.id, {
          state: 'recusado',
          note: `Substituído pela priorização #${proposal.number}.`,
          updatedAt: now,
        });
      }

      if (redo) {
        await updatePlan(tx, redo.id, {
          priorityProposalId: proposal.id,
          original,
          state: 'em_revisao',
          updatedAt: now,
        });

        return redo.id;
      }

      const session =
        people.author === input.profileId && input.sessionId
          ? input.sessionId
          : (await this.sessions.gatewaySession(people.author)).id;
      const created = randomUUID();

      await insertPlan(tx, {
        id: created,
        action: 'priority',
        priorityProposalId: proposal.id,
        authorProfileId: people.author,
        authorSessionId: session,
        reviewerProfileId: people.reviewer,
        original,
        findings: [],
        rounds: 0,
        state: 'em_revisao',
        createdAt: now,
        updatedAt: now,
      });

      return created;
    });

    const plan = await this.get(id);

    await this.askReview(plan);

    return plan;
  }

  /**
   * A read of the boards becomes the plan itself: the moves are what the Reviewer reads, and
   * nothing moves until the plan is approved. An open plan that already says the same is kept;
   * the plan its author was asked to redo takes the new read; any other open one ends. Without
   * a Reviewer the plan goes straight to the owner, and the automatic switch never applies.
   */
  async openForEntrySync(input: {
    sync: EntrySync;
    requester?: string;
    sessionId?: string;
  }): Promise<{ plan: Plan; unchanged: boolean }> {
    const config = await this.settings('entry_sync');
    const all = await this.profiles.profiles();
    const exists = (id?: string) =>
      id && all.some((profile) => profile.id === id) ? id : undefined;
    const reviewer = exists(config.reviewerProfileId);
    const author =
      exists(config.authorProfileId) ??
      exists(input.requester) ??
      all.find((profile) => profile.name.trim().toLowerCase() === FALLBACK_AUTHOR.entry_sync)?.id;
    const signature = entrySignature(input.sync);
    const original = entryPlanText(input.sync);
    const state = reviewer ? 'em_revisao' : 'aguardando_po';
    const now = new Date(this.clock());
    // Found before the transaction: opening the author's conversation writes on its own.
    const session = author
      ? author === input.requester && input.sessionId
        ? input.sessionId
        : (await this.sessions.gatewaySession(author)).id
      : null;

    const result = await this.store.transaction('plans', async (tx) => {
      const open = await openEntryPlans(tx);
      const same = open.find(
        (row) =>
          ['em_revisao', 'aguardando_po'].includes(row.state) &&
          row.entrySync &&
          entrySignature(row.entrySync) === signature,
      );

      if (same) return { id: same.id, unchanged: true };

      const redo = open.find((row) => ['escrevendo', 'devolvido'].includes(row.state));

      for (const row of open) {
        if (row.id === redo?.id) continue;
        await updatePlan(tx, row.id, {
          state: 'recusado',
          note: 'Substituído por uma leitura mais nova da Entrada.',
          updatedAt: now,
        });
      }

      if (redo) {
        await updatePlan(tx, redo.id, {
          entrySync: input.sync,
          original,
          revised: null,
          reviewerProfileId: reviewer ?? null,
          state,
          updatedAt: now,
        });

        return { id: redo.id, unchanged: false };
      }

      const created = randomUUID();

      await insertPlan(tx, {
        id: created,
        action: 'entry_sync',
        entrySync: input.sync,
        authorProfileId: author ?? null,
        authorSessionId: session,
        reviewerProfileId: reviewer ?? null,
        original,
        findings: [],
        rounds: 0,
        state,
        createdAt: now,
        updatedAt: now,
      });

      return { id: created, unchanged: false };
    });

    const plan = await this.get(result.id);

    if (!result.unchanged) {
      if (plan.state === 'em_revisao') await this.askReview(plan);
      else await this.tellOwner(plan);
    }

    return { plan, unchanged: result.unchanged };
  }

  /** Open entry sync plans end when a newer read finds nothing to move. */
  async closeEntrySync(note: string): Promise<number> {
    const now = new Date(this.clock());
    const open = await openEntryPlans(this.store.db);

    for (const row of open) {
      await updatePlan(this.store.db, row.id, { state: 'recusado', note, updatedAt: now });
    }

    return open.length;
  }

  /**
   * The owner applied or discarded a held proposal from the Prioritization page: that is the
   * owner's decision on its plan, which ends with it.
   */
  async settle(
    proposalId: string,
    outcome: 'executado' | 'recusado',
    via: Via,
    note?: string,
  ): Promise<void> {
    const now = new Date(this.clock());

    for (const row of await openPriorityPlans(this.store.db)) {
      if (row.priorityProposalId !== proposalId) continue;
      await updatePlan(this.store.db, row.id, {
        state: outcome,
        ...(outcome === 'executado' ? { approvedBy: 'owner', executedAt: now } : {}),
        ...(note ? { note } : {}),
        decidedVia: via,
        decidedAt: now,
        updatedAt: now,
      });
    }
  }

  /** The active rules that hold where the action is; none without a base. */
  private async rulesFor(context: { applications: string[]; screen?: string; text: string }) {
    return (await this.knowledge?.relevant(context).catch(() => [])) ?? [];
  }

  private async view(row: PlanRow, names?: Map<string, string>): Promise<Plan> {
    const people = names ?? (await profileNames(this.store.db));
    const prototype = row.prototypeId ? await prototypeOf(this.store.db, row.prototypeId) : null;
    const proposal = row.priorityProposalId
      ? await proposalOf(this.store.db, row.priorityProposalId)
      : null;
    const title =
      row.action === 'priority'
        ? proposal
          ? `Priorização #${proposal.number}`
          : 'Priorização removida'
        : row.action === 'entry_sync'
          ? `Entrada e épicos (${row.entrySync?.moves.length ?? 0} movimento(s))`
          : (prototype?.title ?? 'Protótipo removido');
    const state = planStateSchema.parse(row.state);
    const author = row.authorProfileId ? people.get(row.authorProfileId) : undefined;
    const reviewer = row.reviewerProfileId ? people.get(row.reviewerProfileId) : undefined;

    return {
      id: row.id,
      number: row.number,
      action: planActionSchema.parse(row.action),
      ...(row.prototypeId ? { prototypeId: row.prototypeId } : {}),
      ...(row.prototypeVersion ? { prototypeVersion: row.prototypeVersion } : {}),
      title,
      ...(prototype ? { application: prototype.application } : {}),
      ...(row.priorityProposalId ? { priorityProposalId: row.priorityProposalId } : {}),
      ...(proposal
        ? {
            priority: {
              number: proposal.number,
              summary: proposal.summary,
              cards: proposal.cards.map((card) => ({
                workId: card.workId,
                title: card.title,
                ...(card.reason ? { reason: card.reason } : {}),
                raise: card.raise,
              })),
            },
          }
        : {}),
      ...(row.entrySync ? { entrySync: row.entrySync } : {}),
      ...(row.pautaId ? { pautaId: row.pautaId } : {}),
      ...(row.authorProfileId ? { authorProfileId: row.authorProfileId } : {}),
      ...(author ? { authorName: author } : {}),
      ...(row.reviewerProfileId ? { reviewerProfileId: row.reviewerProfileId } : {}),
      ...(reviewer ? { reviewerName: reviewer } : {}),
      ...(row.original ? { original: row.original } : {}),
      ...(row.revised ? { revised: row.revised } : {}),
      findings: row.findings,
      ...(row.questions ? { questions: row.questions } : {}),
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
    const { text, questions } = planWriteSchema.parse(input);

    await this.store.transaction('plans', async (tx) => {
      const row = await this.row({ id }, tx);

      if (row.authorProfileId !== by.profileId) {
        throw new GatewayError(403, `Plan #${row.number} is not yours to write`);
      }
      if (row.action === 'priority') {
        throw new GatewayError(
          409,
          `Plan #${row.number} is a prioritization: its plan is the proposed order; propose it again with propose_priorities`,
        );
      }
      if (row.action === 'entry_sync') {
        throw new GatewayError(
          409,
          `Plan #${row.number} is an entry sync: its plan is the list of moves; read the boards again with propose_entry_sync`,
        );
      }
      if (!['escrevendo', 'devolvido'].includes(row.state)) {
        throw new GatewayError(
          409,
          `Plan #${row.number} is ${row.state}; it is not waiting for you`,
        );
      }

      await updatePlan(tx, id, {
        original: text,
        questions,
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

    // An order the owner adjusted has no words, only the order applied: that is the lesson.
    const said = (row: (typeof rows)[number]) =>
      row.note ??
      (typeof row.corrected === 'string' ? `ajustou a ordem para:\n${row.corrected}` : undefined);

    return rows
      .filter((row) => said(row))
      .map(
        (row) =>
          `- ${row.createdAt.toISOString().slice(0, 10)} (${row.automation}): ${said(row)?.slice(0, 400)}`,
      );
  }

  /** The prioritization the Reviewer reads: the proposed order first, then what it weighs. */
  private async priorityReview(plan: Plan, rules: string[]) {
    const history = plan.priorityProposalId
      ? await priorityHistory(this.store.db, plan.priorityProposalId)
      : { criteria: '', past: [] };
    const past = history.past.map((item) => {
      const order = (item.applied ?? item.cards)
        .slice(0, 12)
        .map((card, index) => `${index + 1}. ${card.title}`)
        .join('; ');
      const how =
        item.state === 'aplicada'
          ? item.adjusted
            ? 'aplicada com ajuste do Moabe'
            : 'aplicada'
          : `descartada${item.note ? `: ${item.note}` : ''}`;

      return `- #${item.number} (${item.createdAt.toISOString().slice(0, 10)}, ${how}): ${order}`;
    });

    return [
      `[Plano #${plan.number} para revisar] Ação: ${what(plan)}, proposta por ${plan.authorName ?? 'um agente'}. Volta ${plan.rounds + 1}.`,
      `Revise com review_plan (planId ${plan.id}). Leia contra as regras do Moabe: memórias, os critérios de priorização, as priorizações anteriores e as decisões das pautas. Devolva o plano mais curto e os achados, cada um com a fonte:`,
      '- divergência: contradiz uma regra, os critérios, uma decisão anterior de prioridade (o que o Moabe ajustou, descartou ou decidiu na pauta) ou o pedido;',
      '- regra sensível: muda a posição de um card que o Moabe já fixou, ou depende de decisão de produto como cliente ou diretoria; ou toca faturamento, fiscal (Tipos e Natureza), dado de cliente (CPF, LGPD), preço, permissão ou dado em produção;',
      '- lacuna: falta informação para ordenar sem inventar (card sem motivo, motivo sem fonte).',
      'Com qualquer achado, não aprove. Você não executa nada: aprovado, a Atena aplica no Work a ordem proposta, não o seu texto.',
      ...REVIEW_BUDGET,
      '\n## Plano',
      plan.original ?? '',
      history.criteria ? `\n## Critérios do Moabe\n${history.criteria.slice(0, 2000)}` : '',
      past.length ? `\n## Priorizações anteriores\n${past.join('\n')}` : '',
      rules.length
        ? `\n## Correções recentes do Moabe na priorização (barre o erro repetido)\n${rules.join('\n')}`
        : '',
    ];
  }

  private async askReview(plan: Plan) {
    const row = await this.row({ id: plan.id });
    const config = await this.settings(plan.action);

    if (!this.submit || !row.reviewerProfileId) return;

    const session = await this.sessions.gatewaySession(row.reviewerProfileId);
    const rules = await this.curation(plan.action);
    const lines =
      plan.action === 'priority'
        ? await this.priorityReview(plan, rules)
        : plan.action === 'entry_sync'
          ? this.entryReview(plan, rules)
          : this.prototypeReview(plan, rules);
    const text = lines.filter((line) => line !== '').join('\n');
    const prototype = plan.prototypeId ? await prototypeOf(this.store.db, plan.prototypeId) : null;
    const known = await this.rulesFor({
      applications: prototype ? [prototype.application, prototype.applicationName] : [],
      ...(prototype ? { screen: prototype.title } : {}),
      text: [plan.title, prototype?.brief ?? '', plan.original ?? ''].join(' '),
    });

    await this.submit(
      row.reviewerProfileId,
      session.id,
      clip(`${text}${ruleSection(known, MESSAGE_LIMIT - text.length - 100)}`),
      // The rounds start again when the owner gives a plan back: the time keeps the key new.
      `plan:${plan.id}:review:${plan.rounds + 1}:${Date.parse(plan.updatedAt)}`,
      config.reviewerModel,
    ).catch(() => {});
  }

  private entryReview(plan: Plan, rules: string[]) {
    return [
      `[Plano #${plan.number} para revisar] Ação: movimentos da Entrada e dos épicos da Sigma, lidos por ${plan.authorName ?? 'a Atena'}. Volta ${plan.rounds + 1}.`,
      `Revise com review_plan (planId ${plan.id}). Confira cada movimento contra as regras do Moabe e as correções abaixo. Devolva o plano mais curto e os achados, cada um com a fonte:`,
      '- divergência: o movimento contradiz uma regra (épico nunca vai para Aceito nem sai de Bloqueado; task nunca se move; pedido só se move pelo épico de que depende; Em execução só quando o épico saiu de A fazer; Concluído só com a validação aprovada pelo Moabe) ou uma correção do Moabe;',
      '- regra sensível: o movimento avisa o suporte (a coluna da Entrada aparece no Geral) de algo que o Moabe ainda não confirmou, ou o card toca faturamento, fiscal (Tipos e Natureza), dado de cliente, preço, permissão ou dado em produção;',
      '- lacuna: falta informação para confirmar o movimento (motivo sem fonte).',
      'Com qualquer achado, não aprove. Você não move nada: aprovado, a Atena move os cards listados, não o seu texto. Pedido parado sem épico não se move: é para o Moabe decidir.',
      rules.length
        ? `\n## Correções recentes do Moabe nestes movimentos (barre o erro repetido)\n${rules.join('\n')}`
        : '',
      '\n## Plano',
      plan.original ?? '',
    ];
  }

  private prototypeReview(plan: Plan, rules: string[]) {
    return [
      `[Plano #${plan.number} para revisar] Ação: protótipo "${plan.title}"${plan.application ? ` (${plan.application})` : ''}, escrito por ${plan.authorName ?? 'um agente'}. Volta ${plan.rounds + 1}.`,
      `Revise com review_plan (planId ${plan.id}). Leia contra as regras do Moabe: memórias, preferencias-do-po.md, padrao-telas.md e as decisões da pauta. Devolva o plano mais curto e os achados, cada um com a fonte:`,
      '- divergência: contradiz uma regra, uma decisão ou o pedido;',
      '- regra sensível: toca faturamento, fiscal (Tipos e Natureza), dado de cliente (CPF, LGPD), preço, permissão ou dado em produção;',
      '- lacuna: falta informação para executar sem inventar.',
      'Com qualquer achado, não aprove. Você não executa nada.',
      ...REVIEW_BUDGET,
      rules.length
        ? `\n## Correções recentes do Moabe nesta ação (barre o erro repetido)\n${rules.join('\n')}`
        : '',
      plan.questions?.length
        ? `\n## Perguntas do autor ao Moabe (${plan.questions.length})\n${plan.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}`
        : '',
      '\n## Plano',
      plan.original ?? '',
    ];
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
          plan.action === 'priority'
            ? 'Corrija propondo a ordem de novo com propose_priorities (mesma coluna); o plano segue com a proposta nova. Lacuna vira pergunta ao Moabe no resumo, nunca invenção. O plano revisado está em read_plan.'
            : plan.action === 'entry_sync'
              ? 'Leia os boards de novo com propose_entry_sync, passando em skip cada card que não deve mover, com o motivo; o plano segue com a leitura nova. O plano revisado está em read_plan.'
              : `Corrija com write_plan (planId ${plan.id}). Lacuna vira pergunta ao Moabe dentro do plano, nunca invenção. O plano revisado está em read_plan.`,
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
      : plan.reviewerProfileId
        ? 'o Revisor aprovou.'
        : 'sem Revisor configurado, confira você.';
    const failed = plan.state === 'aguardando_po' && plan.note?.startsWith(APPLY_FAILED);
    // The moves are short and the owner answers in the chat: they go with the message.
    const moves = plan.action === 'entry_sync' && !failed ? `\n\n${plan.original ?? ''}` : '';

    const answer = `Responda "ok plano ${plan.number}" ou "corrige plano ${plan.number}: motivo"`;
    // The chat gets the gist and the command; the findings are read in the panel or asked for.
    const short = `Plano #${plan.number} esperando você: ${what(plan)}. ${
      failed
        ? 'A aplicação falhou.'
        : plan.findings.length
          ? `${plan.findings.length} achado(s).`
          : plan.reviewerProfileId
            ? 'O Revisor aprovou.'
            : 'Sem Revisor configurado, confira você.'
    }\n${answer}.${moves}`;

    await this.owner?.(
      clip(
        `Plano #${plan.number} esperando você: ${what(plan)}. ${failed ? plan.note : verdict}\n${answer}, ou abra Planos no painel.${moves}`,
      ),
      clip(short),
    ).catch(() => {});
  }

  /**
   * Runs the action the plan is for: the prototype goes to the generator's queue, the order is
   * applied on the board. An order the board refused leaves the plan waiting for the owner with
   * the error, to be approved again; the owner who approved in the panel sees the error.
   */
  private async execute(plan: Plan, rethrow = false) {
    if (plan.prototypeId && plan.prototypeVersion) {
      await this.target?.release(plan.prototypeId, plan.prototypeVersion);
    }

    const runs =
      (plan.action === 'priority' && plan.priorityProposalId && this.board) ||
      (plan.action === 'entry_sync' && plan.entrySync && this.entry);

    if (runs) {
      const via = plan.approvedBy === 'owner' ? (plan.decidedVia as Via) : 'agent';

      try {
        if (plan.action === 'priority' && plan.priorityProposalId) {
          await this.board?.applyApproved(plan.priorityProposalId, via);
        }

        if (plan.action === 'entry_sync' && plan.entrySync && this.entry) {
          const done = await this.entry.apply(plan.entrySync);
          const failed = done.moves.filter((move) => move.result === 'falhou');

          await updatePlan(this.store.db, plan.id, {
            entrySync: done,
            updatedAt: new Date(this.clock()),
          });

          if (failed.length) {
            throw new GatewayError(
              502,
              failed.map((move) => `"${move.title}": ${move.resultNote ?? ''}`).join('; '),
            );
          }
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : String(failure);

        await updatePlan(this.store.db, plan.id, {
          state: 'aguardando_po',
          note: `${APPLY_FAILED} ${message}`.slice(0, 2000),
          updatedAt: new Date(this.clock()),
        });

        if (rethrow) throw failure;

        const waiting = await this.get(plan.id);

        if (plan.approvedBy !== 'owner') await this.tellOwner(waiting);

        return waiting;
      }
    }

    const now = new Date(this.clock());

    await updatePlan(this.store.db, plan.id, {
      state: 'executado',
      executedAt: now,
      updatedAt: now,
    });

    const done = await this.get(plan.id);

    if (done.action === 'priority' && done.approvedBy === 'automatico') {
      await this.tellAuthor(
        done,
        `[Plano #${done.number}] O Revisor aprovou e a priorização é automática: a ordem foi aplicada no Work.`,
        'executado',
      );
    }

    if (done.action === 'entry_sync' && done.approvedBy === 'automatico') {
      await this.tellAuthor(
        done,
        `[Plano #${done.number}] O Revisor aprovou e os movimentos da Entrada são automáticos: ${Plans.entryOutcome(done)}`,
        'executado',
      );
    }

    return done;
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

    // In a chat the decision is told to the agent; the panel and the API show the error.
    return this.execute(await this.get(id), via !== 'channel');
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
      plan.action === 'priority'
        ? `[Plano #${plan.number}] O Moabe devolveu a priorização: ${reason}\nProponha a ordem de novo com propose_priorities (mesma coluna); o plano segue com a proposta nova.`
        : plan.action === 'entry_sync'
          ? `[Plano #${plan.number}] O Moabe devolveu os movimentos da Entrada: ${reason}\nLeia os boards de novo com propose_entry_sync, passando em skip cada card que não deve mover, com o motivo.`
          : `[Plano #${plan.number}] O Moabe devolveu: ${reason}\nReescreva com write_plan (planId ${plan.id}). O plano atual está em read_plan.`,
      `moabe:${Date.parse(plan.updatedAt)}`,
    );
    await this.teach(plan, reason);

    return plan;
  }

  /** What the owner wrote on a plan, for the Curator to turn into rules. */
  private async teach(plan: Plan, said?: string) {
    if (!said) return;

    await this.knowledge?.learn({
      kind: 'plano',
      ref: `Plano #${plan.number}, ${what(plan)}`,
      text: [
        `O Moabe escreveu: ${said}`,
        plan.questions?.length
          ? `Perguntas do plano:\n${plan.questions.map((question) => `- ${question}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      ...(plan.application ? { application: plan.application } : {}),
      ...(plan.action === 'prototype' ? { screen: plan.title } : {}),
    });
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

    if (plan.priorityProposalId) {
      await this.board?.close(
        plan.priorityProposalId,
        `Plano #${plan.number} recusado pelo PO${reason ? `: ${reason}` : ''}`,
      );
    }

    await this.teach(plan, reason);

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

    const action = planActionSchema.parse(row.action);

    await this.quality?.record(tx, row.authorProfileId, {
      kind,
      via,
      action:
        action === 'prototype'
          ? `${CORRECTION_PREFIX[action]}${prototype?.application ?? 'plano'}`
          : CORRECTION_PREFIX[action],
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

  /** "3 movimento(s) feito(s), 1 pulado(s): …" for an entry sync that ran. */
  static entryOutcome(plan: Plan) {
    const moves = plan.entrySync?.moves ?? [];
    const done = moves.filter((move) => move.result === 'feito').length;
    const left = moves.filter((move) => move.result === 'pulado');
    const skipped = left.map((move) => `"${move.title}" (${move.resultNote ?? ''})`).join('; ');

    return `${done} movimento(s) feito(s)${left.length ? `, ${left.length} pulado(s): ${skipped}` : ''}.`;
  }

  static notice(plan: Plan) {
    if (plan.action === 'entry_sync') {
      if (plan.state === 'executado') {
        return `[Plano #${plan.number}] O Moabe aprovou os movimentos da Entrada: ${Plans.entryOutcome(plan)}`;
      }
      if (plan.state === 'aguardando_po') {
        return `[Plano #${plan.number}] O Moabe aprovou os movimentos da Entrada, mas nem todos foram feitos. ${plan.note ?? ''}`;
      }
      return `[Plano #${plan.number}] O Moabe devolveu os movimentos da Entrada ao autor: ${plan.note ?? ''}`;
    }

    if (plan.action === 'priority') {
      if (plan.state === 'executado') {
        return `[Plano #${plan.number}] O Moabe aprovou o plano da ${plan.title}; a ordem foi aplicada no Work.`;
      }
      if (plan.state === 'aguardando_po') {
        return `[Plano #${plan.number}] O Moabe aprovou a ${plan.title}, mas a ordem não foi aplicada. ${plan.note ?? ''}`;
      }
      return `[Plano #${plan.number}] O Moabe devolveu a ${plan.title} ao autor: ${plan.note ?? ''}`;
    }

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
      questionsPerWeek: await this.questionsPerWeek(),
    };
  }

  /**
   * Questions the authors asked per written plan, by the week (from Monday, UTC) the plan was
   * opened, over the last eight weeks. It should fall as the base learns. A plan written before
   * questions were counted is left out rather than counted as none.
   */
  private async questionsPerWeek(): Promise<Routines['questionsPerWeek']> {
    const now = this.clock();
    const rows = await questionedPlans(this.store.db, new Date(now - WEEKS_SHOWN * WEEK_MS));
    const weeks = new Map<string, { plans: number; questions: number }>();

    for (const row of rows) {
      const day = new Date(row.createdAt);
      const monday = new Date(
        Date.UTC(
          day.getUTCFullYear(),
          day.getUTCMonth(),
          day.getUTCDate() - ((day.getUTCDay() + 6) % 7),
        ),
      )
        .toISOString()
        .slice(0, 10);
      const week = weeks.get(monday) ?? { plans: 0, questions: 0 };

      week.plans += 1;
      week.questions += row.questions?.length ?? 0;
      weeks.set(monday, week);
    }

    return [...weeks.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, count]) => ({
        week,
        ...count,
        average: Math.round((count.questions / count.plans) * 10) / 10,
      }));
  }
}
