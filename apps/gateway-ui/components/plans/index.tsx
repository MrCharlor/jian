'use client';

import { Check, CornerUpLeft, RefreshCw, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Plan, PlanSettings, PlanState } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import {
  Badge,
  Button,
  Disclosure,
  Empty,
  Field,
  MoreText,
  SectionHeading,
  SwitchField,
} from '../ui';
import { Markdown } from '../ui/markdown';

export const planStateLabel: Record<PlanState, string> = {
  escrevendo: 'Escrevendo',
  em_revisao: 'Com o Revisor',
  devolvido: 'Devolvido ao autor',
  aguardando_po: 'Esperando você',
  aprovado: 'Aprovado',
  executado: 'Executado',
  recusado: 'Recusado',
};

const stateTone: Record<PlanState, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  escrevendo: 'neutral',
  em_revisao: 'neutral',
  devolvido: 'warn',
  aguardando_po: 'accent',
  aprovado: 'good',
  executado: 'good',
  recusado: 'bad',
};

const findingLabel: Record<Plan['findings'][number]['kind'], string> = {
  divergencia: 'Divergência',
  regra_sensivel: 'Regra sensível',
  lacuna: 'Lacuna',
};

/** The order the list shows: what waits for the owner first, what ended last. */
const ORDER: PlanState[] = [
  'aguardando_po',
  'em_revisao',
  'devolvido',
  'escrevendo',
  'aprovado',
  'executado',
  'recusado',
];

const OPEN = new Set<PlanState>(['escrevendo', 'em_revisao', 'devolvido', 'aguardando_po']);

type Action = Plan['action'];

const ACTIONS: Action[] = ['prototype', 'priority', 'entry_sync'];

export const actionLabel: Record<Action, string> = {
  prototype: 'Protótipo',
  priority: 'Priorização',
  entry_sync: 'Entrada segue o épico',
};

const actionHint: Record<Action, { direct: string; author: string }> = {
  prototype: {
    direct: 'Sem Revisor, o protótipo é gerado direto, sem plano.',
    author: 'Vazio: o agente que pediu, ou o Subaru.',
  },
  priority: {
    direct: 'Sem Revisor, a proposta vai direto para a página Priorização, como antes.',
    author: 'Vazio: o agente que propôs a ordem, ou o Otto.',
  },
  entry_sync: {
    direct:
      'Sem Revisor, o plano vem direto para você e nunca roda sozinho, mesmo com Automático ligado.',
    author: 'Vazio: o agente que leu os boards, ou o Otto.',
  },
};

/** How a plan is named in a list. */
export const planTitle = (plan: Pick<Plan, 'action' | 'title'>) =>
  plan.action === 'prototype' ? `Protótipo "${plan.title}"` : plan.title;

const resultTone = { feito: 'good', pulado: 'warn', falhou: 'bad' } as const;
const resultLabel = { feito: 'Feito', pulado: 'Pulado', falhou: 'Falhou' } as const;

/** Where a plan's texts are read: Markdown, cut at a screenful with "ver mais". */
function PlanText({ text, empty }: { text?: string; empty: string }) {
  if (!text) return <p className="note my-0">{empty}</p>;

  return (
    <MoreText lines={10}>
      <div className="markdown">
        <Markdown text={text} />
      </div>
    </MoreText>
  );
}

/**
 * Plans written before a prototype, a prioritization or the Entrada moves: the original beside
 * the Reviewer's, and the owner's OK. What waits for the owner comes first; the settings of
 * each action are closed at the end.
 */
export function Plans({ api, data }: SectionProps) {
  const [list, setList] = useState<Plan[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | ''>('');

  const load = useCallback(
    () =>
      api
        .plans()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Os planos não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await load();
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  const groups = ORDER.map((state) => ({
    state,
    items: (list ?? []).filter(
      (plan) => plan.state === state && (!action || plan.action === action),
    ),
  })).filter((group) => group.items.length);

  return (
    <>
      <SectionHeading
        title="Planos"
        description="Antes de um protótipo, de uma priorização ou dos movimentos da Entrada, o agente escreve o plano e o Revisor confere contra as suas regras e correções. Aprove para executar, ou devolva com o motivo."
      />
      <div className="page-toolbar">
        <Field label="Ação" hint="Mostra só os planos e a configuração desta ação.">
          <select value={action} onChange={(event) => setAction(event.target.value as Action | '')}>
            <option value="">Todas</option>
            {ACTIONS.map((item) => (
              <option key={item} value={item}>
                {actionLabel[item]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list && !groups.length ? (
        <Empty title="Nenhum plano ainda">
          Os planos aparecem aqui quando houver um Revisor configurado e alguém pedir um protótipo
          ou propuser uma priorização, e quando a leitura da Entrada achar o que mover.
        </Empty>
      ) : (
        groups.map((group) => (
          <section key={group.state} className="row-group" aria-labelledby={`plans-${group.state}`}>
            <h2 id={`plans-${group.state}`}>
              {planStateLabel[group.state]} <Badge dot={false}>{group.items.length}</Badge>
            </h2>
            <div className="request-list">
              {group.items.map((plan) => (
                <PlanCard key={plan.id} plan={plan} api={api} act={act} busy={busy} />
              ))}
            </div>
          </section>
        ))
      )}
      <Disclosure
        title="Configurações"
        hint="Por ação: quem escreve, quem revisa, quantas voltas e se executa sem o seu OK."
        icon={<Settings size={18} />}
      >
        {ACTIONS.filter((item) => !action || item === action).map((item) => (
          <ActionSettings key={item} action={item} api={api} data={data} />
        ))}
      </Disclosure>
    </>
  );
}

function PlanCard({
  plan,
  api,
  act,
  busy,
}: {
  plan: Plan;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');
  const open = OPEN.has(plan.state);

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{plan.number} · {planTitle(plan)}
            <Badge tone={stateTone[plan.state]}>{planStateLabel[plan.state]}</Badge>
          </h4>
          <small>
            {[
              actionLabel[plan.action],
              plan.application,
              plan.authorName && `autor ${plan.authorName}`,
              plan.reviewerName && `revisor ${plan.reviewerName}`,
              `${plan.rounds} ${plan.rounds === 1 ? 'volta' : 'voltas'}`,
              date(plan.updatedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </div>
      </header>

      <div className="request-body">
        {plan.questions && plan.questions.length > 0 && (
          <div className="owner-callout accent">
            <strong>Perguntas para você ({plan.questions.length})</strong>
            <ol>
              {plan.questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          </div>
        )}

        {plan.findings.length > 0 && (
          <div className="owner-callout warn">
            <strong>Achados do Revisor ({plan.findings.length})</strong>
            <ul>
              {plan.findings.map((finding) => (
                <li key={`${finding.kind}-${finding.text}`}>
                  <Badge tone={finding.kind === 'regra_sensivel' ? 'bad' : 'warn'}>
                    {findingLabel[finding.kind]}
                  </Badge>{' '}
                  {finding.text}
                  {finding.source ? (
                    <small className="text-muted"> ({finding.source})</small>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {plan.note && (
          <div className="owner-callout">
            <strong>Seu último comentário</strong>
            <MoreText lines={3}>{plan.note}</MoreText>
          </div>
        )}

        <div className="owner-columns">
          {plan.priority ? (
            <div>
              <h5>Ordem proposta</h5>
              <ol>
                {plan.priority.cards.map((card) => (
                  <li key={card.workId}>
                    {card.title} {card.raise && <Badge tone="warn">Sobe do Aprovado</Badge>}
                    <small className="block text-muted">
                      {card.reason ?? 'Sem motivo do agente'}
                    </small>
                  </li>
                ))}
              </ol>
              <p className="note mb-0">{plan.priority.summary}</p>
            </div>
          ) : plan.entrySync ? (
            <EntryMoves sync={plan.entrySync} />
          ) : (
            <div>
              <h5>Plano do autor</h5>
              <PlanText text={plan.original} empty="Ainda não escrito." />
            </div>
          )}
          <div>
            <h5>Revisado</h5>
            <PlanText text={plan.revised} empty="Ainda não revisado." />
          </div>
        </div>

        {open && (
          <Field
            label="Motivo"
            hint="Obrigatório para devolver ao autor; opcional para recusar. Vira correção em Quality."
          >
            <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        )}
      </div>

      {open && (
        <footer>
          <p>
            {plan.original
              ? 'Aprovar executa o plano revisado.'
              : 'O autor ainda não escreveu o plano; dá para devolver ou recusar.'}
          </p>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void act(() => api.rejectPlan(plan.id, reason.trim() || undefined))}
          >
            <X size={16} /> Recusar
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !reason.trim()}
            onClick={() => void act(() => api.returnPlan(plan.id, reason.trim()))}
          >
            <CornerUpLeft size={16} /> Devolver
          </Button>
          <Button
            busy={busy}
            disabled={busy || !plan.original}
            onClick={() => void act(() => api.approvePlan(plan.id))}
          >
            <Check size={16} /> Aprovar
          </Button>
        </footer>
      )}
    </article>
  );
}

/** The moves of an entry sync as "card: from → to, why", and what the owner should decide. */
function EntryMoves({ sync }: { sync: NonNullable<Plan['entrySync']> }) {
  return (
    <div className="grid gap-4">
      <div>
        <h5>Movimentos ({sync.moves.length})</h5>
        {sync.moves.length ? (
          <ol>
            {sync.moves.map((move) => (
              <li key={`${move.workId}-${move.toStatusId}`}>
                <a className="text-link" href={move.url} target="_blank" rel="noreferrer">
                  {move.board === 'epics' ? 'Épico' : 'Pedido'} "{move.title}"
                </a>
                : {move.from} → {move.to}, {move.reason}{' '}
                {move.result && (
                  <Badge tone={resultTone[move.result]}>{resultLabel[move.result]}</Badge>
                )}
                {move.resultNote ? <small className="text-muted"> {move.resultNote}</small> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="note my-0">Nenhum movimento.</p>
        )}
      </div>
      {sync.stale.length > 0 && (
        <div>
          <h5>Em Priorizado sem épico (você decide; não se movem)</h5>
          <ul>
            {sync.stale.map((item) => (
              <li key={item.workId}>
                <a className="text-link" href={item.url} target="_blank" rel="noreferrer">
                  {item.title}
                </a>
                : há {item.days} dias
              </li>
            ))}
          </ul>
        </div>
      )}
      {sync.skipped.length > 0 && (
        <div>
          <h5>Deixados de fora</h5>
          <ul>
            {sync.skipped.map((item) => (
              <li key={`${item.workId}-${item.to}`}>
                {item.title} (→ {item.to}): {item.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Per action: who writes, who reviews, how many returns, and whether it runs without the OK. */
function ActionSettings({
  action,
  api,
  data,
}: Pick<SectionProps, 'api' | 'data'> & { action: Action }) {
  const [settings, setSettings] = useState<PlanSettings>();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .planSettings(action)
      .then(setSettings)
      .catch(() => setMessage('A configuração não carregou.'));
    void api
      .profiles()
      .then((items) => setProfiles(items.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, [api, action]);

  const save = (patch: Parameters<typeof api.updatePlanSettings>[1]) =>
    api
      .updatePlanSettings(action, patch)
      .then((saved) => {
        setSettings(saved);
        setMessage('Salvo.');
      })
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não salvou.'));

  if (!settings) {
    return message ? (
      <p className="form-error my-0" role="alert">
        {actionLabel[action]}: {message}
      </p>
    ) : null;
  }

  const model = settings.reviewerModel;
  const models = model ? (data.providerModels[model.providerId]?.models ?? []) : [];

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>{actionLabel[action]}</h4>
          <small>{actionHint[action].direct}</small>
        </div>
      </header>
      <div className="request-body">
        <SwitchField
          label="Automático"
          hint="Ligado: o plano que o Revisor aprovou executa sem o seu OK. Desligado: todo plano espera você."
          checked={settings.automatic}
          onChange={(automatic) => void save({ automatic })}
        />
        <div className="owner-fields">
          <Field label="Autor" hint={actionHint[action].author}>
            <select
              value={settings.authorProfileId ?? ''}
              onChange={(event) => void save({ authorProfileId: event.target.value || null })}
            >
              <option value="">
                {action === 'prototype'
                  ? 'Quem pediu'
                  : action === 'priority'
                    ? 'Quem propôs'
                    : 'Quem leu'}
              </option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Revisor" hint="Quem confere o plano contra as suas regras e correções.">
            <select
              value={settings.reviewerProfileId ?? ''}
              onChange={(event) => void save({ reviewerProfileId: event.target.value || null })}
            >
              <option value="">Nenhum (sem plano)</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Voltas" hint="Quantas vezes o plano volta ao autor antes de vir para você.">
            <select
              value={settings.maxRounds}
              onChange={(event) => void save({ maxRounds: Number(event.target.value) })}
            >
              {[0, 1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Provedor do Revisor"
            hint="Do perfil: o Revisor usa o modelo do próprio perfil."
          >
            <select
              value={model?.providerId ?? ''}
              onChange={(event) =>
                void save({
                  reviewerModel: event.target.value
                    ? {
                        providerId: event.target.value,
                        modelId:
                          data.providerModels[event.target.value]?.models[0]?.id ??
                          model?.modelId ??
                          'default',
                      }
                    : null,
                })
              }
            >
              <option value="">Do perfil</option>
              {data.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </Field>
          {model && (
            <Field label="Modelo do Revisor" hint="O modelo que confere os planos desta ação.">
              <select
                value={model.modelId}
                onChange={(event) =>
                  void save({ reviewerModel: { ...model, modelId: event.target.value } })
                }
              >
                {!models.some((item) => item.id === model.modelId) && (
                  <option value={model.modelId}>{model.modelId}</option>
                )}
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName ?? item.id}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      </div>
      {(action === 'entry_sync' || message) && (
        <footer>
          <p role="status">{message}</p>
          {action === 'entry_sync' && (
            <Button
              variant="secondary"
              onClick={() =>
                void api
                  .runEntrySync()
                  .then((result) => setMessage(`${result.message} Recarregue a lista.`))
                  .catch((failure) =>
                    setMessage(failure instanceof Error ? failure.message : 'Não leu os boards.'),
                  )
              }
            >
              <RefreshCw size={16} /> Ler os boards agora
            </Button>
          )}
        </footer>
      )}
    </article>
  );
}
