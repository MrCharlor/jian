import { Approvals } from '../approvals/service.js';
import type { Knowledge } from '../knowledge/service.js';
import type { Mentions } from '../mentions/service.js';
import type { Pautas } from '../pautas/service.js';
import type { Plans } from '../plans/service.js';
import type { Priorities } from '../priorities/service.js';
import type { Profiles } from '../profiles/service.js';
import type { Roadmap } from '../roadmap/service.js';
import type { Validations } from '../validations/service.js';
import type { InboxSource } from './service.js';

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const MENTION_WAITING = new Set(['waiting', 'held', 'limited']);

/** The roadmap answers a list; one that failed comes back as the reason, not as an error. */
const charted = async (result: Promise<{ failed: Array<{ why: string }> }>) => {
  const { failed } = await result;

  if (failed[0]) throw new Error(failed[0].why);
};

/**
 * Every queue the owner answers, read and decided through the calls its own page and its old
 * chat command already make. Nothing here decides anything a queue would not decide itself.
 */
export function inboxSources(services: {
  profiles: Pick<Profiles, 'profiles'>;
  approvals: Pick<Approvals, 'list' | 'approve' | 'reject' | 'decide'>;
  plans: Pick<Plans, 'list' | 'approve' | 'reject' | 'giveBack'>;
  knowledge: Pick<Knowledge, 'proposals' | 'approve' | 'reject'>;
  pautas: Pick<Pautas, 'list' | 'decide' | 'discard'>;
  validations: Pick<Validations, 'list' | 'fromChat' | 'commentFromChat' | 'discardComment'>;
  mentions: Pick<Mentions, 'list' | 'answer' | 'ignore'>;
  roadmap: Pick<Roadmap, 'proposals' | 'fromChat'>;
  priorities: Pick<Priorities, 'list' | 'apply' | 'discard'>;
}): InboxSource[] {
  const approvalOwner = new Map<string, string>();

  return [
    {
      kind: 'aprovacao',
      label: 'Ação',
      async pending() {
        const profiles = await services.profiles.profiles();
        const found = [];

        for (const profile of profiles) {
          for (const approval of await services.approvals.list(profile.id)) {
            if (approval.status !== 'pending') continue;

            approvalOwner.set(approval.id, profile.id);
            found.push({
              refId: approval.id,
              refNumber: approval.number,
              title: `${profile.name}: ${clip(approval.summary || approval.action, 160)}`,
              summary: approval.action,
              createdAt: approval.createdAt,
            });
          }
        }

        return found;
      },
      // In a chat the owner's own message carries the answer to the agent; elsewhere the
      // conversation is woken up with it.
      async ok(item, via, chat) {
        const profileId = approvalOwner.get(item.refId) ?? '';

        if (!chat) {
          await services.approvals.approve(profileId, item.refId, {}, via);
          return 'aprovada; o agente segue.';
        }

        return Approvals.notice(
          await services.approvals.decide(profileId, { id: item.refId }, true, via),
        );
      },
      async no(item, reason, via, chat) {
        const profileId = approvalOwner.get(item.refId) ?? '';

        if (chat)
          await services.approvals.decide(profileId, { id: item.refId }, false, via, reason);
        else await services.approvals.reject(profileId, item.refId, reason ? { reason } : {}, via);
        return 'recusada.';
      },
    },
    {
      kind: 'plano',
      label: 'Plano',
      async pending() {
        return (await services.plans.list({ state: 'aguardando_po' })).map((plan) => ({
          refId: plan.id,
          refNumber: plan.number,
          title: plan.title,
          createdAt: plan.updatedAt,
        }));
      },
      async ok(item, via) {
        await services.plans.approve({ id: item.refId }, via);
        return 'aprovado.';
      },
      async no(item, reason, via) {
        await services.plans.reject({ id: item.refId }, reason ? { reason } : {}, via);
        return 'recusado.';
      },
      async text(item, text, via) {
        await services.plans.giveBack({ id: item.refId }, { reason: text }, via);
        return 'devolvido ao autor com o seu texto.';
      },
    },
    {
      kind: 'regra',
      label: 'Regra',
      async pending() {
        return (await services.knowledge.proposals({ state: 'aguardando_po' })).map((proposal) => ({
          refId: proposal.id,
          refNumber: proposal.number,
          title: clip(proposal.text ?? proposal.ruleText ?? proposal.reason, 160),
          summary: proposal.reason,
          highImpact: proposal.sensitive,
          createdAt: proposal.createdAt,
        }));
      },
      async ok(item, via) {
        await services.knowledge.approve({ id: item.refId }, via);
        return 'aplicada na base.';
      },
      async no(item, reason, via) {
        await services.knowledge.reject({ id: item.refId }, reason ? { reason } : {}, via);
        return 'recusada.';
      },
    },
    {
      kind: 'decisao',
      label: 'Decisão',
      async pending() {
        return (await services.pautas.list()).flatMap((pauta) =>
          pauta.decisions
            .filter((decision) => decision.state === 'proposta')
            .map((decision) => ({
              refId: decision.id,
              refNumber: decision.number,
              title: `${pauta.title}: ${clip(decision.question, 140)}`,
              summary: `Opções: ${decision.options.join(' / ')}. Recomendação: ${decision.recommendation}`,
              createdAt: decision.createdAt,
            })),
        );
      },
      async ok(item, via) {
        const decision = (await services.pautas.list())
          .flatMap((pauta) => pauta.decisions)
          .find((entry) => entry.id === item.refId);

        await services.pautas.decide(
          { id: item.refId },
          { choice: decision?.recommendation ?? '' },
          via,
        );
        return 'decidida pela recomendação.';
      },
      async no(item) {
        await services.pautas.discard(item.refId);
        return 'descartada.';
      },
      async text(item, text, via) {
        const [choice, ...why] = text.split(/,\s*porque\s+/i);

        await services.pautas.decide(
          { id: item.refId },
          { choice: (choice ?? text).trim(), ...(why.length ? { reason: why.join(', ') } : {}) },
          via,
        );
        return 'decidida com a sua escolha.';
      },
    },
    {
      kind: 'validacao',
      label: 'Validação',
      async pending() {
        return (await services.validations.list())
          .filter((validation) => validation.state === 'aberta')
          .map((validation) => ({
            refId: validation.id,
            refNumber: validation.number,
            title: validation.epicTitle,
            link: validation.epicUrl,
            createdAt: validation.createdAt,
          }));
      },
      async ok(item) {
        if (!(await services.validations.fromChat({ number: item.refNumber, approved: true }))) {
          throw new Error('a validação não está aberta');
        }
        return 'aprovada.';
      },
      async no(item, reason) {
        await services.validations.fromChat({
          number: item.refNumber,
          approved: false,
          ...(reason ? { reason } : {}),
        });
        return 'reprovada; o comentário vai para o seu OK.';
      },
    },
    {
      kind: 'comentario',
      label: 'Comentário',
      async pending() {
        return (await services.validations.list())
          .filter((validation) => validation.comment?.state === 'rascunho')
          .map((validation) => ({
            refId: validation.id,
            refNumber: validation.number,
            title: `reprovação de ${validation.epicTitle}`,
            summary: validation.comment?.body,
            link: validation.epicUrl,
            createdAt: validation.createdAt,
          }));
      },
      async ok(item) {
        await services.validations.commentFromChat({ number: item.refNumber });
        return 'publicado no épico.';
      },
      async no(item) {
        await services.validations.discardComment(item.refId);
        return 'descartado.';
      },
      async text(item, text) {
        await services.validations.commentFromChat({ number: item.refNumber, body: text });
        return 'publicado com o seu texto.';
      },
    },
    {
      kind: 'mencao',
      label: 'Menção',
      async pending() {
        return (await services.mentions.list())
          .filter((mention) => MENTION_WAITING.has(mention.state))
          .map((mention) => ({
            refId: mention.id,
            refNumber: mention.number,
            title: `${mention.authorName ?? 'alguém'} em ${mention.cardTitle ?? 'card'}`,
            summary: clip(mention.body, 300),
            ...(mention.cardUrl ? { link: mention.cardUrl } : {}),
            highImpact: mention.kind === 'alto_impacto',
            createdAt: mention.createdAt,
          }));
      },
      async ok(item, via) {
        await services.mentions.answer({ id: item.refId }, {}, via);
        return 'resposta proposta publicada no card.';
      },
      async no(item, _reason, via) {
        await services.mentions.ignore({ id: item.refId }, via);
        return 'ignorada, nada no card.';
      },
      async text(item, text, via) {
        await services.mentions.answer({ id: item.refId }, { text }, via);
        return 'o seu texto foi publicado no card.';
      },
    },
    {
      kind: 'roadmap',
      label: 'Roadmap',
      async pending() {
        return (await services.roadmap.proposals({ state: 'aguardando_po' })).map((proposal) => ({
          refId: proposal.id,
          refNumber: proposal.number,
          title:
            `${proposal.kind === 'incluir' ? '' : `${proposal.kind}: `}${proposal.item?.title ?? proposal.itemTitle ?? ''}`.trim(),
          summary: `${proposal.kind}. ${proposal.reason}`,
          highImpact: proposal.highImpact,
          createdAt: proposal.createdAt,
        }));
      },
      async ok(item) {
        await charted(services.roadmap.fromChat({ numbers: [item.refNumber], action: 'ok' }));
        return 'aplicada.';
      },
      async no(item, reason) {
        await charted(
          services.roadmap.fromChat({
            numbers: [item.refNumber],
            action: 'refuse',
            ...(reason ? { text: reason } : {}),
          }),
        );
        return 'recusada.';
      },
      async text(item, text) {
        await charted(
          services.roadmap.fromChat({ numbers: [item.refNumber], action: 'edit', text }),
        );
        return 'aplicada com o seu ajuste.';
      },
    },
    {
      kind: 'priorizacao',
      label: 'Priorização',
      async pending() {
        // One held by a plan is answered as that plan.
        return (await services.priorities.list())
          .filter((proposal) => proposal.state === 'proposta' && !proposal.planNumber)
          .map((proposal) => ({
            refId: proposal.id,
            refNumber: proposal.number,
            title: clip(proposal.summary, 160),
            createdAt: proposal.createdAt,
          }));
      },
      async ok(item, via) {
        await services.priorities.apply({ id: item.refId }, {}, via);
        return 'ordem aplicada no Work.';
      },
      async no(item, reason, via) {
        await services.priorities.discard(item.refId, reason ? { note: reason } : {}, via);
        return 'descartada.';
      },
    },
  ];
}
