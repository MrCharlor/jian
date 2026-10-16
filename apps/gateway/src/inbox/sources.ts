import { Approvals } from '../approvals/service.js';
import type { Epics } from '../epics/service.js';
import type { Knowledge } from '../knowledge/service.js';
import type { Mentions } from '../mentions/service.js';
import type { Pautas } from '../pautas/service.js';
import type { PipelineChain } from '../pipeline/service.js';
import type { Plans } from '../plans/service.js';
import type { Priorities } from '../priorities/service.js';
import type { Profiles } from '../profiles/service.js';
import type { Prototypes } from '../prototypes/service.js';
import type { Roadmap } from '../roadmap/service.js';
import type { Validations } from '../validations/service.js';
import type { InboxSource } from './service.js';

const clip = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

const MENTION_WAITING = new Set(['waiting', 'held', 'limited']);

const LANE: Record<string, string> = { agora: 'Agora', proximo: 'Próximo', depois: 'Depois' };

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
  prototypes: Pick<Prototypes, 'list' | 'approve' | 'redo'>;
  epics: Pick<Epics, 'list' | 'create' | 'discard'>;
  pipeline: Pick<
    PipelineChain,
    'prototypeRefused' | 'revise' | 'requests' | 'createRequest' | 'discardRequest'
  >;
}): InboxSource[] {
  const approvalOwner = new Map<string, string>();

  return [
    {
      kind: 'aprovacao',
      label: 'Ação',
      question: 'Um agente pode fazer esta ação?',
      ifOk: 'O agente faz a ação agora.',
      ifNo: 'O agente não faz; o motivo vai para ele.',
      okLabel: 'Liberar',
      noLabel: 'Não liberar',
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
      question: 'O plano do agente pode seguir?',
      ifOk: 'O agente executa o plano (protótipo, ordem do Priorizado ou movimentos da Entrada).',
      ifNo: 'O plano é descartado.',
      ifText: 'O plano volta ao autor com a sua correção.',
      okLabel: 'Aprovar plano',
      noLabel: 'Descartar',
      async pending() {
        return (await services.plans.list({ state: 'aguardando_po' })).map((plan) => ({
          refId: plan.id,
          refNumber: plan.number,
          title: plan.title,
          question:
            plan.action === 'entry_sync'
              ? 'Os movimentos de cards na Entrada podem ser feitos?'
              : plan.action === 'priority'
                ? 'A nova ordem do Priorizado pode ser aplicada no Work?'
                : 'O plano do protótipo pode virar desenho?',
          details: [
            ...(plan.reviewerName ? [`Revisado por ${plan.reviewerName}.`] : []),
            ...plan.findings
              .slice(0, 4)
              .map((finding) => `Achado do Revisor: ${clip(finding.text, 200)}`),
            ...(plan.questions ?? [])
              .slice(0, 3)
              .map((question) => `Pergunta: ${clip(question, 200)}`),
            ...(plan.revised || plan.original
              ? [clip(plan.revised ?? plan.original ?? '', 600)]
              : []),
          ],
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
      question: 'Esta regra entra na base que os agentes consultam?',
      ifOk: 'A regra passa a valer para todos os agentes.',
      ifNo: 'A regra não entra; o motivo vira lição para o Curador.',
      okLabel: 'Aceitar regra',
      noLabel: 'Recusar regra',
      async pending() {
        return (await services.knowledge.proposals({ state: 'aguardando_po' })).map((proposal) => ({
          refId: proposal.id,
          refNumber: proposal.number,
          title: clip(proposal.text ?? proposal.ruleText ?? proposal.reason, 160),
          summary: proposal.reason,
          question:
            proposal.kind === 'aposentar'
              ? 'Esta regra sai da base?'
              : proposal.ruleText
                ? 'A regra muda para este texto?'
                : 'Esta regra entra na base que os agentes consultam?',
          details: [
            ...(proposal.text ? [`Regra: ${proposal.text}`] : []),
            ...(proposal.ruleText ? [`Hoje: ${proposal.ruleText}`] : []),
            `Por quê: ${proposal.reason}`,
            ...(proposal.sensitive
              ? ['Sensível: mexe com fiscal, preço, dado de cliente ou produção.']
              : []),
          ],
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
      question: 'Qual opção você escolhe?',
      ifOk: 'Vale a recomendação do agente.',
      ifNo: 'A decisão é descartada, sem escolha.',
      ifText: 'Vale a opção que você escrever (ex.: "B, porque ...").',
      okLabel: 'Seguir a recomendação',
      noLabel: 'Descartar',
      async pending() {
        return (await services.pautas.list()).flatMap((pauta) =>
          pauta.decisions
            .filter((decision) => decision.state === 'proposta')
            .map((decision) => ({
              refId: decision.id,
              refNumber: decision.number,
              title: `${pauta.title}: ${clip(decision.question, 140)}`,
              summary: `Opções: ${decision.options.join(' / ')}. Recomendação: ${decision.recommendation}`,
              question: decision.question,
              details: [
                ...decision.options.map(
                  (option, index) => `Opção ${String.fromCharCode(65 + index)}: ${option}`,
                ),
                `Contraponto: ${decision.counterpoint}`,
                `Recomendação: ${decision.recommendation}`,
              ],
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
      question: 'Você testou este épico e ele cumpre o Pronto quando?',
      ifOk: 'O épico fica aprovado e recebe o comentário "Aprovado" no Work.',
      ifNo: 'O épico fica reprovado; a Atena prepara o comentário com o seu motivo e espera o seu OK para publicar.',
      okLabel: 'Aprovar épico',
      noLabel: 'Reprovar',
      async pending() {
        return (await services.validations.list())
          .filter((validation) => validation.state === 'aberta')
          .map((validation) => ({
            refId: validation.id,
            refNumber: validation.number,
            title: validation.epicTitle,
            link: validation.previewUrl ?? validation.epicUrl,
            details: [
              ...(validation.pauta ? [`Pauta: ${validation.pauta}`] : []),
              ...(validation.previewUrl
                ? [`Preview: ${validation.previewUrl}`]
                : ['Sem link de preview no épico.']),
              `Épico: ${validation.epicUrl}`,
              ...validation.items
                .slice(0, 8)
                .map((entry) => `Pronto quando: ${clip(entry.text, 200)}`),
              ...validation.notes.slice(0, 2).map((note) => `Nota recente: ${clip(note, 200)}`),
            ],
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
      question: 'Este comentário de reprovação pode ir para o épico?',
      ifOk: 'O comentário é publicado no épico, marcando quem pegou e o Lucas.',
      ifNo: 'O comentário é descartado; nada vai para o Work.',
      ifText: 'O seu texto é publicado no lugar.',
      okLabel: 'Publicar',
      noLabel: 'Descartar',
      async pending() {
        return (await services.validations.list())
          .filter((validation) => validation.comment?.state === 'rascunho')
          .map((validation) => ({
            refId: validation.id,
            refNumber: validation.number,
            title: `reprovação de ${validation.epicTitle}`,
            summary: validation.comment?.body,
            details: [`Comentário: ${validation.comment?.body ?? ''}`],
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
      question: 'Alguém perguntou no Work. A resposta da Atena pode ir?',
      ifOk: 'A resposta proposta é publicada no card.',
      ifNo: 'Nada é publicado; a menção é ignorada.',
      ifText: 'O seu texto é publicado no card no lugar.',
      okLabel: 'Publicar resposta',
      noLabel: 'Ignorar',
      async pending() {
        return (await services.mentions.list())
          .filter((mention) => MENTION_WAITING.has(mention.state))
          .map((mention) => ({
            refId: mention.id,
            refNumber: mention.number,
            title: `${mention.authorName ?? 'alguém'} em ${mention.cardTitle ?? 'card'}`,
            summary: clip(mention.body, 300),
            details: [
              `Pergunta: ${clip(mention.body, 400)}`,
              ...(mention.proposedReply ? [`Resposta proposta: ${mention.proposedReply}`] : []),
              ...(mention.reason ? [`Por quê: ${clip(mention.reason, 300)}`] : []),
            ],
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
      question: 'Esta mudança entra no seu roadmap?',
      ifOk: 'O roadmap da Atena muda. Nada muda no Work.',
      ifNo: 'Não muda; o motivo vira lição para o Estrategista.',
      ifText: 'Muda com o seu ajuste.',
      okLabel: 'Aplicar no roadmap',
      noLabel: 'Recusar',
      async pending() {
        return (await services.roadmap.proposals({ state: 'aguardando_po' })).map((proposal) => ({
          refId: proposal.id,
          refNumber: proposal.number,
          title:
            `${proposal.kind === 'incluir' ? '' : `${proposal.kind}: `}${proposal.item?.title ?? proposal.itemTitle ?? ''}`.trim(),
          summary: `${proposal.kind}. ${proposal.reason}`,
          question:
            proposal.kind === 'incluir'
              ? `Incluir no roadmap${proposal.applicationName ? ` do ${proposal.applicationName}` : ''}, em ${LANE[proposal.lane ?? proposal.item?.lane ?? 'depois'] ?? 'Depois'}?`
              : proposal.kind === 'mover'
                ? `Mover de ${LANE[proposal.fromLane ?? ''] ?? '?'} para ${LANE[proposal.lane ?? ''] ?? '?'}?`
                : proposal.kind === 'concluir'
                  ? 'Marcar como concluído?'
                  : 'Descartar do roadmap?',
          details: [
            `Por quê: ${proposal.reason}`,
            ...(proposal.counterpoint ? [`Contraponto: ${proposal.counterpoint}`] : []),
            ...proposal.evidence.slice(0, 3).map((entry) => `Evidência: ${clip(entry, 200)}`),
          ],
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
      kind: 'pedido',
      label: 'Pedido',
      question: 'Este pedido pode ir para a Entrada?',
      ifOk: 'O card é criado na Entrada, em Novo, ligado à pauta. Para andar até o épico, mova para Priorizado.',
      ifNo: 'O pedido é descartado; nada vai para o Work.',
      okLabel: 'Criar na Entrada',
      noLabel: 'Descartar',
      async pending() {
        return (await services.pipeline.requests())
          .filter((draft) => draft.state === 'rascunho')
          .map((draft) => ({
            refId: draft.id,
            refNumber: draft.number,
            title: draft.title,
            details: [
              ...(draft.pautaTitle ? [`Pauta: ${draft.pautaTitle}`] : []),
              clip(draft.description, 900),
            ],
            createdAt: draft.createdAt,
          }));
      },
      async ok(item) {
        const created = await services.pipeline.createRequest(item.refId);
        return `criado na Entrada, em Novo${created.workId ? ` (${created.workId})` : ''}.`;
      },
      async no(item) {
        await services.pipeline.discardRequest(item.refId);
        return 'descartado.';
      },
    },
    {
      kind: 'prototipo',
      label: 'Protótipo',
      question: 'O desenho está bom para virar épico?',
      ifOk: 'Esta versão fica aprovada e o épico é escrito a partir dela.',
      ifNo: 'O protótipo é recusado e o pedido para; o motivo fica registrado.',
      ifText: 'Uma versão nova é desenhada com a sua correção.',
      okLabel: 'Aprovar desenho',
      noLabel: 'Recusar',
      async pending() {
        return (await services.prototypes.list())
          .map((prototype) => ({ prototype, latest: prototype.versions.at(-1) }))
          .filter(
            ({ prototype, latest }) =>
              latest?.status === 'ready' && (prototype.approvedVersion ?? 0) < latest.number,
          )
          .map(({ prototype, latest }) => ({
            refId: prototype.id,
            refNumber: latest?.number ?? 1,
            title: `${prototype.title} (versão ${latest?.number ?? 1})`,
            ...(prototype.designUrl ? { link: prototype.designUrl } : {}),
            details: [
              ...(prototype.designUrl ? [`Desenho: ${prototype.designUrl}`] : []),
              `Pedido: ${clip(prototype.brief, 400)}`,
              ...(latest?.comments ? [`Correção anterior: ${clip(latest.comments, 300)}`] : []),
            ],
            createdAt: latest?.finishedAt ?? latest?.createdAt ?? prototype.updatedAt,
          }));
      },
      async ok(item) {
        await services.prototypes.approve(item.refId, item.refNumber);
        return 'desenho aprovado; o épico é escrito a partir dele.';
      },
      async no(item, reason) {
        await services.pipeline.prototypeRefused(item.refId, reason);
        return 'recusado; o pedido parou.';
      },
      async text(item, text, via) {
        await services.prototypes.redo(item.refId, { comments: text }, via);
        return 'uma versão nova está sendo desenhada com a sua correção.';
      },
    },
    {
      kind: 'epico',
      label: 'Épico',
      question: 'Este épico e as subtasks podem ser criados no Work?',
      ifOk: 'O épico e as subtasks são criados no Work (Equipe Sigma, 3433, etiqueta, App vazio), ligados ao pedido, e o Lucas é avisado.',
      ifNo: 'O rascunho é descartado; nada vai para o Work.',
      ifText: 'O autor reescreve o rascunho com a sua correção.',
      okLabel: 'Criar no Work',
      noLabel: 'Descartar',
      async pending() {
        return (await services.epics.list())
          .filter((draft) => draft.state === 'rascunho')
          .map((draft) => ({
            refId: draft.id,
            refNumber: draft.number,
            title: draft.title,
            ...(draft.prototypeUrl ? { link: draft.prototypeUrl } : {}),
            details: [
              ...(draft.pauta ? [`Pauta: ${draft.pauta}`] : []),
              clip(draft.description, 600),
              ...draft.tasks
                .slice(0, 8)
                .map((task, index) => `Subtask ${index + 1}: ${task.title}`),
              ...(draft.problems.length
                ? draft.problems.map((problem) => `Conferência: ${clip(problem, 200)}`)
                : ['Conferência: nada a corrigir.']),
            ],
            highImpact: draft.problems.length > 0,
            createdAt: draft.createdAt,
          }));
      },
      async ok(item) {
        const created = await services.epics.create(item.refId);

        if (created.error) throw new Error(created.error);
        return `criado no Work${created.work?.epicUrl ? `: ${created.work.epicUrl}` : ''}.`;
      },
      async no(item) {
        await services.epics.discard(item.refId);
        return 'descartado.';
      },
      async text(item, text) {
        return services.pipeline.revise(item.refId, text);
      },
    },
    {
      kind: 'priorizacao',
      label: 'Priorização',
      question: 'Esta ordem do Priorizado pode ser aplicada no Work?',
      ifOk: 'A coluna Priorizado da Entrada é reordenada no Work.',
      ifNo: 'A proposta é descartada; nada muda no Work.',
      okLabel: 'Aplicar ordem',
      noLabel: 'Descartar',
      async pending() {
        // One held by a plan is answered as that plan.
        return (await services.priorities.list())
          .filter((proposal) => proposal.state === 'proposta' && !proposal.planNumber)
          .map((proposal) => ({
            refId: proposal.id,
            refNumber: proposal.number,
            title: clip(proposal.summary, 160),
            details: proposal.cards
              .slice(0, 8)
              .map(
                (card, index) =>
                  `${index + 1}. ${clip(card.title, 120)}${card.reason ? `: ${clip(card.reason, 160)}` : ''}`,
              ),
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
