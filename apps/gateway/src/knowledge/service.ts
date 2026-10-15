import { randomUUID } from 'node:crypto';
import {
  type KnowledgeProposal,
  type KnowledgeReply,
  type KnowledgeRule,
  type KnowledgeSettings,
  knowledgeImportSchema,
  knowledgeListQuerySchema,
  knowledgePatchSchema,
  knowledgeProposalInputSchema,
  knowledgeProposalListQuerySchema,
  knowledgeProposalRejectSchema,
  knowledgeScopeSchema,
  knowledgeSettingsPatchSchema,
  knowledgeSettingsSchema,
  knowledgeSourceSchema,
  knowledgeStateSchema,
} from '@jian/contracts';
import { desc, eq, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Queryable, Store } from '../storage/database.js';
import { gatewaySettings, knowledge, knowledgeProposals, profiles } from '../storage/schema.js';
import { haystack, hits, sameName, scopeLabel, words } from './match.js';

type RuleRow = typeof knowledge.$inferSelect;
type ProposalRow = typeof knowledgeProposals.$inferSelect;
type Via = 'panel' | 'channel' | 'api';

/** A message handed to an agent, as a new turn in its conversation. */
type Submit = (profileId: string, sessionId: string, text: string, key: string) => Promise<unknown>;

/** Where the owner said something the base may learn from. */
export type Lesson = {
  kind: 'plano' | 'correcao' | 'decisao' | 'validacao' | 'mencao' | 'roadmap';
  /** "Plano #3", "Decisão #4 (pauta …)": what the Curator cites as the source. */
  ref: string;
  /** The owner's words, and what they answered. */
  text: string;
  application?: string;
  screen?: string;
};

/** What an action is about, to pick the rules its plan must follow. */
export type RuleContext = {
  /** Every name the application goes by: its slug and its name. */
  applications?: string[];
  screen?: string;
  text: string;
};

const SETTINGS_KEY = 'knowledge';

const DEFAULTS: KnowledgeSettings = { automatic: false, sensitiveAlwaysAsks: true };

/** The most rules handed with a plan: past this, the agent searches. */
export const PLAN_RULES = 40;

const KIND_LABEL: Record<KnowledgeProposal['kind'], string> = {
  incluir: 'incluir',
  mudar: 'mudar',
  aposentar: 'aposentar',
};

const LESSON_LABEL: Record<Lesson['kind'], string> = {
  plano: 'respondeu um plano',
  correcao: 'corrigiu uma resposta',
  decisao: 'decidiu uma pauta',
  validacao: 'respondeu uma validação',
  mencao: 'respondeu uma dúvida no Work',
  roadmap: 'respondeu uma proposta do roadmap',
};

const LESSON_SOURCE: Record<Lesson['kind'], KnowledgeRule['source']['kind']> = {
  plano: 'plano',
  correcao: 'correcao',
  decisao: 'decisao',
  validacao: 'validacao',
  mencao: 'mencao',
  roadmap: 'roadmap',
};

async function nextNumber(db: Queryable, table: typeof knowledge | typeof knowledgeProposals) {
  const [top] = await db
    .select({ max: sql<number>`coalesce(max(${table.number}), 0)` })
    .from(table);

  return Number(top?.max ?? 0) + 1;
}

function toRule(row: RuleRow): KnowledgeRule {
  return {
    id: row.id,
    number: row.number,
    ...(row.code ? { code: row.code } : {}),
    text: row.text,
    scope: knowledgeScopeSchema.parse(row.scope),
    source: knowledgeSourceSchema.parse(row.source),
    sensitive: row.sensitive,
    state: knowledgeStateSchema.parse(row.state),
    ...(row.replaces ? { replaces: row.replaces } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Whether a rule holds where the action is: its application, or every application. */
const appHolds = (rule: KnowledgeRule, names: string[]) =>
  !rule.scope.application || names.some((name) => sameName(rule.scope.application, name));

/**
 * The owner's knowledge base (B19). Every agent searches it before asking the owner; plans
 * carry the rules that hold where they act. Only the Curator proposes changes, from what the
 * owner answered; a proposal waits for the owner unless the base is automatic, and a sensitive
 * one waits anyway while "sensível sempre pede OK" is on.
 */
export class Knowledge {
  private submit?: Submit;
  private owner?: (text: string) => Promise<unknown>;

  constructor(
    private readonly store: Store,
    private readonly people: { profiles(): Promise<Array<{ id: string; name: string }>> },
    private readonly sessions: { gatewaySession(profileId: string): Promise<{ id: string }> },
    private readonly clock: Clock = Date.now,
  ) {}

  useAgents(submit: Submit) {
    this.submit = submit;
  }

  /** Where "Proposta de regra #N esperando você" is said: the owner's own conversation. */
  useOwner(owner: (text: string) => Promise<unknown>) {
    this.owner = owner;
  }

  async settings(): Promise<KnowledgeSettings> {
    const [row] = await this.store.db
      .select()
      .from(gatewaySettings)
      .where(eq(gatewaySettings.key, SETTINGS_KEY))
      .limit(1);

    return knowledgeSettingsSchema.parse({ ...DEFAULTS, ...((row?.value ?? {}) as object) });
  }

  async updateSettings(input: unknown): Promise<KnowledgeSettings> {
    const patch = knowledgeSettingsPatchSchema.parse(input ?? {});
    const merged: Record<string, unknown> = { ...(await this.settings()) };

    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else if (value !== undefined) merged[key] = value;
    }

    const curator = merged.curatorProfileId;

    if (
      typeof curator === 'string' &&
      !(await this.people.profiles()).some((profile) => profile.id === curator)
    ) {
      throw new GatewayError(404, `Profile ${curator} not found`);
    }

    const value = knowledgeSettingsSchema.parse(merged);

    await this.store.db
      .insert(gatewaySettings)
      .values({ key: SETTINGS_KEY, value })
      .onConflictDoUpdate({
        target: gatewaySettings.key,
        set: { value, updatedAt: new Date(this.clock()) },
      });

    return value;
  }

  /** Only the Curator is offered propose_knowledge. */
  async isCurator(profileId: string) {
    return (await this.settings()).curatorProfileId === profileId;
  }

  private async rules(): Promise<KnowledgeRule[]> {
    const rows = await this.store.db.select().from(knowledge).orderBy(desc(knowledge.number));

    return rows.map(toRule);
  }

  /**
   * The panel's list: by state, application, screen (the names in the rule's scope) and words,
   * every one of which must be in the rule.
   */
  async list(query: unknown = {}): Promise<KnowledgeRule[]> {
    const filter = knowledgeListQuerySchema.parse(query ?? {});
    const wanted = filter.q ? words(filter.q) : [];

    return (await this.rules()).filter(
      (rule) =>
        (!filter.state || rule.state === filter.state) &&
        (!filter.application || sameName(rule.scope.application, filter.application)) &&
        (!filter.screen || sameName(rule.scope.screen, filter.screen)) &&
        hits(wanted, haystack(rule)) === wanted.length,
    );
  }

  async get(id: string): Promise<KnowledgeRule> {
    const [row] = await this.store.db.select().from(knowledge).where(eq(knowledge.id, id));

    return toRule(assertFound(row, 'Rule'));
  }

  /** The owner's edit in the panel: text, scope, sensitivity, or retiring it. */
  async update(id: string, input: unknown): Promise<KnowledgeRule> {
    const patch = knowledgePatchSchema.parse(input ?? {});
    const current = await this.get(id);

    await this.store.db
      .update(knowledge)
      .set({ ...patch, updatedAt: new Date(this.clock()) })
      .where(eq(knowledge.id, current.id));

    return this.get(id);
  }

  /**
   * A load of rules, all or nothing. A code already in the base is skipped, so a load can be
   * sent again. A rule that replaces another, by code, retires it when it arrives active.
   */
  async import(input: unknown): Promise<{ created: KnowledgeRule[]; skipped: string[] }> {
    const { rules } = knowledgeImportSchema.parse(input);
    const now = new Date(this.clock());

    const ids = await this.store.transaction('knowledge', async (tx) => {
      const known = new Map(
        (
          await tx
            .select({ id: knowledge.id, number: knowledge.number, code: knowledge.code })
            .from(knowledge)
        )
          .filter((row) => row.code)
          .map((row) => [row.code as string, row]),
      );
      const skipped: string[] = [];
      const created: Array<{ id: string; rule: (typeof rules)[number] }> = [];
      let number = await nextNumber(tx, knowledge);

      for (const rule of rules) {
        if (rule.code && known.has(rule.code)) {
          skipped.push(rule.code);
          continue;
        }

        const id = randomUUID();

        await tx.insert(knowledge).values({
          id,
          number,
          code: rule.code ?? null,
          text: rule.text,
          scope: rule.scope,
          source: rule.source,
          sensitive: rule.sensitive,
          state: rule.state,
          createdAt: now,
          updatedAt: now,
        });

        if (rule.code) known.set(rule.code, { id, number, code: rule.code });
        created.push({ id, rule });
        number += 1;
      }

      for (const { id, rule } of created) {
        if (!rule.replaces) continue;

        const target = known.get(rule.replaces);

        if (!target) {
          throw new GatewayError(
            400,
            `Rule ${rule.code ?? rule.text.slice(0, 40)} replaces ${rule.replaces}, which is neither in the base nor in this load`,
          );
        }

        await tx.update(knowledge).set({ replaces: target.number }).where(eq(knowledge.id, id));

        if (rule.state === 'ativa') {
          await tx
            .update(knowledge)
            .set({ state: 'aposentada', updatedAt: now })
            .where(eq(knowledge.id, target.id));
        }
      }

      return { created: created.map((item) => item.id), skipped };
    });

    return {
      created: await Promise.all(ids.created.map((id) => this.get(id))),
      skipped: ids.skipped,
    };
  }

  /**
   * What an agent finds before asking: active rules that hold where it acts (every scope, when
   * it names no application) with the words it gave, most specific first.
   */
  async lookup(query: { q?: string; application?: string; screen?: string; limit?: number }) {
    const wanted = query.q ? words(query.q) : [];
    const names = query.application ? [query.application] : [];
    const found = (await this.rules())
      .filter((rule) => rule.state === 'ativa')
      .filter((rule) => !names.length || appHolds(rule, names))
      .filter(
        (rule) =>
          !query.screen || rule.scope.kind !== 'tela' || sameName(rule.scope.screen, query.screen),
      )
      .map((rule) => ({ rule, score: hits(wanted, haystack(rule)) }))
      .filter((item) => !wanted.length || item.score > 0)
      .sort((a, b) => b.score - a.score || specificity(b.rule) - specificity(a.rule));

    return found.slice(0, query.limit ?? 20).map(({ rule }) => ({
      number: rule.number,
      text: rule.text,
      scope: scopeLabel(rule.scope),
      sensitive: rule.sensitive,
      source: `${rule.source.kind}${rule.source.ref ? `: ${rule.source.ref}` : ''}${rule.source.date ? ` (${rule.source.date})` : ''}`,
    }));
  }

  /**
   * The rules a plan carries: those of its screen, of every screen kind and of the whole
   * application, then those the request's words call for. At most PLAN_RULES; a rule of another
   * screen or another application never comes by words alone.
   */
  async relevant(context: RuleContext): Promise<KnowledgeRule[]> {
    const names = context.applications ?? [];
    const wanted = words(context.text);
    const needed = wanted.length <= 4 ? 1 : 2;

    const ranked = (await this.rules())
      .filter((rule) => rule.state === 'ativa' && appHolds(rule, names))
      .map((rule) => {
        const score = hits(wanted, haystack(rule));
        const tier =
          rule.scope.kind === 'tela'
            ? sameName(rule.scope.screen, context.screen)
              ? 0
              : undefined
            : rule.scope.kind === 'tipo_de_tela' && names.length
              ? 1
              : rule.scope.kind === 'aplicacao' && names.length
                ? 2
                : score >= needed
                  ? 3
                  : undefined;

        return { rule, score, tier };
      })
      .filter((item) => item.tier !== undefined)
      .sort(
        (a, b) =>
          (a.tier ?? 9) - (b.tier ?? 9) || b.score - a.score || b.rule.number - a.rule.number,
      );

    return ranked.slice(0, PLAN_RULES).map((item) => item.rule);
  }

  private async proposalRow(which: { id: string } | { number: number }, db: Queryable) {
    const [row] = await db
      .select()
      .from(knowledgeProposals)
      .where(
        'id' in which
          ? eq(knowledgeProposals.id, which.id)
          : eq(knowledgeProposals.number, which.number),
      )
      .limit(1);

    return assertFound(row, 'Knowledge proposal');
  }

  private async views(rows: ProposalRow[]): Promise<KnowledgeProposal[]> {
    const numbers = new Map(
      (
        await this.store.db.select({ id: knowledge.id, number: knowledge.number }).from(knowledge)
      ).map((row) => [row.id, row.number]),
    );
    const names = new Map(
      (await this.store.db.select({ id: profiles.id, name: profiles.name }).from(profiles)).map(
        (row) => [row.id, row.name],
      ),
    );

    return rows.map((row) => {
      const ruleNumber = row.ruleId ? numbers.get(row.ruleId) : undefined;
      const resultNumber = row.resultId ? numbers.get(row.resultId) : undefined;
      const proposedBy = row.proposedBy ? names.get(row.proposedBy) : undefined;

      return {
        id: row.id,
        number: row.number,
        kind: row.kind as KnowledgeProposal['kind'],
        ...(ruleNumber ? { ruleNumber } : {}),
        ...(row.ruleText ? { ruleText: row.ruleText } : {}),
        ...(row.text ? { text: row.text } : {}),
        ...(row.scope ? { scope: knowledgeScopeSchema.parse(row.scope) } : {}),
        sensitive: row.sensitive,
        reason: row.reason,
        source: knowledgeSourceSchema.parse(row.source),
        state: row.state as KnowledgeProposal['state'],
        ...(proposedBy ? { proposedBy } : {}),
        ...(row.appliedBy ? { appliedBy: row.appliedBy as 'owner' | 'automatico' } : {}),
        ...(resultNumber ? { resultNumber } : {}),
        ...(row.note ? { note: row.note } : {}),
        ...(row.decidedVia
          ? { decidedVia: row.decidedVia as NonNullable<KnowledgeProposal['decidedVia']> }
          : {}),
        ...(row.decidedAt ? { decidedAt: row.decidedAt.toISOString() } : {}),
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private async proposal(which: { id: string } | { number: number }) {
    const [view] = await this.views([await this.proposalRow(which, this.store.db)]);

    return assertFound(view, 'Knowledge proposal');
  }

  async proposals(query: unknown = {}): Promise<KnowledgeProposal[]> {
    const { state } = knowledgeProposalListQuerySchema.parse(query ?? {});
    const rows = await this.store.db
      .select()
      .from(knowledgeProposals)
      .where(state ? eq(knowledgeProposals.state, state) : undefined)
      .orderBy(desc(knowledgeProposals.createdAt))
      .limit(300);

    return this.views(rows);
  }

  /**
   * The Curator's proposal. It applies at once when the base is automatic, unless it is
   * sensitive and sensitive ones always ask; otherwise the owner is told it waits.
   */
  async propose(input: unknown, by: { profileId: string }): Promise<KnowledgeProposal> {
    const data = knowledgeProposalInputSchema.parse(input);
    const config = await this.settings();

    if (config.curatorProfileId !== by.profileId) {
      throw new GatewayError(403, 'Only the Curator proposes changes to the knowledge base');
    }

    const id = randomUUID();
    const sensitive = await this.store.transaction('knowledge', async (tx) => {
      const target = data.ruleNumber
        ? assertFound(
            (await tx.select().from(knowledge).where(eq(knowledge.number, data.ruleNumber)))[0],
            `Rule #${data.ruleNumber}`,
          )
        : undefined;

      if (target && target.state === 'aposentada') {
        throw new GatewayError(409, `Rule #${target.number} is already retired`);
      }

      const marked = data.sensitive || Boolean(target?.sensitive);

      await tx.insert(knowledgeProposals).values({
        id,
        number: await nextNumber(tx, knowledgeProposals),
        kind: data.kind,
        ruleId: target?.id ?? null,
        ruleText: target?.text ?? null,
        text: data.text ?? null,
        scope: data.scope ?? null,
        sensitive: marked,
        reason: data.reason,
        source: data.source,
        state: 'aguardando_po',
        proposedBy: by.profileId,
        createdAt: new Date(this.clock()),
      });

      return marked;
    });

    if (config.automatic && !(sensitive && config.sensitiveAlwaysAsks)) {
      return this.decide({ id }, 'automatico');
    }

    const waiting = await this.proposal({ id });

    await this.owner?.(Knowledge.ask(waiting)).catch(() => {});

    return waiting;
  }

  /** Applies a proposal: a new rule, a new text in the place of one, or a rule retired. */
  private async apply(tx: Queryable, row: ProposalRow) {
    const now = new Date(this.clock());
    const target = row.ruleId
      ? (await tx.select().from(knowledge).where(eq(knowledge.id, row.ruleId)))[0]
      : undefined;

    if (row.kind !== 'incluir' && !target) {
      throw new GatewayError(409, `The rule proposal #${row.number} is about no longer exists`);
    }

    if (target && row.kind !== 'incluir') {
      await tx
        .update(knowledge)
        .set({ state: 'aposentada', updatedAt: now })
        .where(eq(knowledge.id, target.id));
    }

    if (row.kind === 'aposentar') return null;

    const id = randomUUID();

    await tx.insert(knowledge).values({
      id,
      number: await nextNumber(tx, knowledge),
      text: row.text ?? '',
      scope: row.scope ?? target?.scope ?? { kind: 'geral' },
      source: row.source,
      sensitive: row.sensitive,
      state: 'ativa',
      replaces: target?.number ?? null,
      createdAt: now,
      updatedAt: now,
    });

    return id;
  }

  private async decide(
    which: { id: string } | { number: number },
    via: Via | 'automatico',
    refusal?: { reason?: string },
  ): Promise<KnowledgeProposal> {
    const id = await this.store.transaction('knowledge', async (tx) => {
      const row = await this.proposalRow(which, tx);

      if (row.state !== 'aguardando_po') {
        throw new GatewayError(409, `Rule proposal #${row.number} is already ${row.state}`);
      }

      const now = new Date(this.clock());

      if (refusal) {
        await tx
          .update(knowledgeProposals)
          .set({
            state: 'recusada',
            note: refusal.reason ?? null,
            decidedVia: via,
            decidedAt: now,
          })
          .where(eq(knowledgeProposals.id, row.id));

        return row.id;
      }

      const result = await this.apply(tx, row);

      await tx
        .update(knowledgeProposals)
        .set({
          state: 'aplicada',
          appliedBy: via === 'automatico' ? 'automatico' : 'owner',
          resultId: result,
          decidedVia: via,
          decidedAt: now,
        })
        .where(eq(knowledgeProposals.id, row.id));

      return row.id;
    });

    return this.proposal({ id });
  }

  async approve(which: { id: string } | { number: number }, via: Via = 'api') {
    return this.decide(which, via);
  }

  async reject(which: { id: string } | { number: number }, input: unknown, via: Via = 'api') {
    return this.decide(which, via, knowledgeProposalRejectSchema.parse(input ?? {}));
  }

  /** "ok regra 4" or "recusa regra 4: …" from the owner in a chat. */
  async fromChat(reply: KnowledgeReply) {
    return reply.approve
      ? this.approve({ number: reply.number }, 'channel')
      : this.reject(
          { number: reply.number },
          reply.reason ? { reason: reply.reason } : {},
          'channel',
        );
  }

  /**
   * The owner said something the base may learn from: the Curator is asked to propose what
   * changes. Nothing happens without a Curator, and a failure never reaches the owner's action.
   */
  async learn(lesson: Lesson): Promise<void> {
    try {
      const config = await this.settings();

      if (!this.submit || !config.curatorProfileId || !lesson.text.trim()) return;

      const session = await this.sessions.gatewaySession(config.curatorProfileId);
      const today = new Date(this.clock()).toISOString().slice(0, 10);
      const where = [
        lesson.application ? `aplicação ${lesson.application}` : '',
        lesson.screen ? `tela ${lesson.screen}` : '',
      ]
        .filter(Boolean)
        .join(', ');

      await this.submit(
        config.curatorProfileId,
        session.id,
        [
          `[Base de conhecimento] O Moabe ${LESSON_LABEL[lesson.kind]} (${lesson.ref}${where ? `; ${where}` : ''}):`,
          lesson.text.slice(0, 4000),
          '',
          'Leia a base com search_knowledge e proponha com propose_knowledge o que muda: incluir regra nova, mudar o texto de uma regra ou aposentá-la. Uma proposta por regra, cada uma com o motivo.',
          `Fonte: kind "${LESSON_SOURCE[lesson.kind]}", ref "${lesson.ref}", date "${today}".`,
          'Escopo padrão: o tipo de tela da aplicação (ex.: toda listagem do ERP). Restrinja à tela só quando a resposta valer só para ela; geral só quando valer para qualquer aplicação.',
          'Marque sensível o que toca faturamento, fiscal (Tipos e Natureza), dado de cliente (CPF, LGPD), preço, permissão ou dado em produção.',
          'Conflito com uma regra existente: proponha mudar a antiga, não incluir outra. Se nada muda na base, não proponha nada.',
        ].join('\n'),
        `knowledge:${lesson.kind}:${lesson.ref}:${this.clock()}`,
      ).catch(() => {});
    } catch {
      // The owner's decision is already recorded; the base learns from the next one.
    }
  }

  /** How the owner is asked about a proposal that waits. */
  static ask(proposal: KnowledgeProposal) {
    const target = proposal.ruleNumber ? ` a regra #${proposal.ruleNumber}` : '';
    const lines = [
      `Proposta de regra #${proposal.number} do ${proposal.proposedBy ?? 'Curador'} (${KIND_LABEL[proposal.kind]}${target})${proposal.sensitive ? ', sensível' : ''}:`,
      proposal.ruleText && proposal.kind !== 'incluir' ? `Hoje: ${proposal.ruleText}` : '',
      proposal.text ? `Nova: ${proposal.text}` : '',
      proposal.scope ? `Escopo: ${scopeLabel(proposal.scope)}` : '',
      `Motivo: ${proposal.reason}`,
      `Fonte: ${proposal.source.kind}${proposal.source.ref ? `, ${proposal.source.ref}` : ''}`,
      `Responda "ok regra ${proposal.number}" ou "recusa regra ${proposal.number}: motivo", ou abra Conhecimento no painel.`,
    ];

    return lines.filter(Boolean).join('\n').slice(0, 7800);
  }

  /** What an agent reads when the owner answered a proposal in a chat. */
  static notice(proposal: KnowledgeProposal) {
    return proposal.state === 'aplicada'
      ? `[Proposta de regra #${proposal.number}] O Moabe aprovou${proposal.resultNumber ? `; a regra #${proposal.resultNumber} está na base` : '; a regra foi aposentada'}.`
      : `[Proposta de regra #${proposal.number}] O Moabe recusou${proposal.note ? `: ${proposal.note}` : ''}.`;
  }
}

/** Most specific first: one screen, a kind of screen, an application, everything. */
function specificity(rule: KnowledgeRule) {
  return { tela: 3, tipo_de_tela: 2, aplicacao: 1, geral: 0 }[rule.scope.kind];
}
