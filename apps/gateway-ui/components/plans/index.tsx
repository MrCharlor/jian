'use client';

import { Check, CornerUpLeft, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Plan, PlanSettings, PlanState } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, SectionHeading, Switch } from '../ui';

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

/** Plans written before a prototype: the original beside the Reviewer's, and the owner's OK. */
export function Plans({ api, data }: SectionProps) {
  const [list, setList] = useState<Plan[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    items: (list ?? []).filter((plan) => plan.state === state),
  })).filter((group) => group.items.length);

  return (
    <>
      <SectionHeading
        title="Planos"
        description="Antes de um protótipo, o agente escreve o plano e o Revisor confere contra as suas regras e correções. Aprove para executar, ou devolva com o motivo."
      />
      <ActionSettings api={api} data={data} />
      {error && <p className="error">{error}</p>}
      {list && !list.length ? (
        <Empty title="Nenhum plano ainda">
          Os planos aparecem aqui quando houver um Revisor configurado e alguém pedir um protótipo.
        </Empty>
      ) : (
        groups.map((group) => (
          <section key={group.state}>
            <h3>
              {planStateLabel[group.state]} ({group.items.length})
            </h3>
            <div className="request-list">
              {group.items.map((plan) => (
                <PlanCard key={plan.id} plan={plan} api={api} act={act} busy={busy} />
              ))}
            </div>
          </section>
        ))
      )}
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
            #{plan.number} · Protótipo "{plan.title}"{' '}
            <Badge tone={stateTone[plan.state]}>{planStateLabel[plan.state]}</Badge>
          </h4>
          <small>
            {plan.application ? `${plan.application} · ` : ''}
            {plan.authorName ? `autor ${plan.authorName} · ` : ''}
            {plan.reviewerName ? `revisor ${plan.reviewerName} · ` : ''}
            {plan.rounds} volta(s) · {date(plan.updatedAt)}
          </small>
        </div>
      </header>

      {plan.note && <p className="note">Seu último comentário: {plan.note}</p>}

      {plan.findings.length > 0 && (
        <div className="epic-problems">
          <strong>Achados do Revisor</strong>
          <ul>
            {plan.findings.map((finding) => (
              <li key={`${finding.kind}-${finding.text}`}>
                <Badge tone={finding.kind === 'regra_sensivel' ? 'bad' : 'warn'}>
                  {findingLabel[finding.kind]}
                </Badge>{' '}
                {finding.text}
                {finding.source ? <small> ({finding.source})</small> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="plan-texts">
        <div>
          <h5>Plano do autor</h5>
          <pre className="request-quote">{plan.original ?? 'Ainda não escrito.'}</pre>
        </div>
        <div>
          <h5>Revisado</h5>
          <pre className="request-quote">{plan.revised ?? 'Ainda não revisado.'}</pre>
        </div>
      </div>

      {open && (
        <footer className="settings-fields">
          <Field label="Motivo" hint="Para devolver ao autor ou recusar. Vira correção em Quality.">
            <textarea rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          <p className="prototype-buttons">
            <Button
              busy={busy}
              disabled={busy || !plan.original}
              onClick={() => void act(() => api.approvePlan(plan.id))}
            >
              <Check size={16} /> Aprovar
            </Button>
            <Button
              variant="secondary"
              disabled={busy || !reason.trim()}
              onClick={() => void act(() => api.returnPlan(plan.id, reason.trim()))}
            >
              <CornerUpLeft size={16} /> Devolver
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void act(() => api.rejectPlan(plan.id, reason.trim() || undefined))}
            >
              <X size={16} /> Recusar
            </Button>
          </p>
        </footer>
      )}
    </article>
  );
}

/** Per action: who writes, who reviews, how many returns, and whether it runs without the OK. */
function ActionSettings({ api, data }: Pick<SectionProps, 'api' | 'data'>) {
  const [settings, setSettings] = useState<PlanSettings>();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .planSettings('prototype')
      .then(setSettings)
      .catch(() => setMessage('A configuração não carregou.'));
    void api
      .profiles()
      .then((items) => setProfiles(items.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, [api]);

  const save = (patch: Parameters<typeof api.updatePlanSettings>[1]) =>
    api
      .updatePlanSettings('prototype', patch)
      .then((saved) => {
        setSettings(saved);
        setMessage('Salvo.');
      })
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não salvou.'));

  if (!settings) return message ? <p className="error">{message}</p> : null;

  const model = settings.reviewerModel;
  const models = model ? (data.providerModels[model.providerId]?.models ?? []) : [];

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>Protótipo</h4>
          <small>
            Sem Revisor, o protótipo é gerado direto, sem plano. O modelo do Revisor é o do perfil
            dele, a não ser que você escolha um aqui.
          </small>
        </div>
        <Switch
          label="Automático: executa o plano aprovado pelo Revisor sem o seu OK"
          checked={settings.automatic}
          onChange={(automatic) => void save({ automatic })}
        />
      </header>
      <div className="settings-fields">
        <Field label="Autor" hint="Vazio: o agente que pediu, ou o Subaru.">
          <select
            value={settings.authorProfileId ?? ''}
            onChange={(event) => void save({ authorProfileId: event.target.value || null })}
          >
            <option value="">Quem pediu</option>
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Revisor">
          <select
            value={settings.reviewerProfileId ?? ''}
            onChange={(event) => void save({ reviewerProfileId: event.target.value || null })}
          >
            <option value="">Nenhum (gera direto)</option>
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
        <Field label="Provedor do Revisor" hint="Vazio: o modelo do perfil do Revisor.">
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
          <Field label="Modelo do Revisor">
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
      {message && <p className="note">{message}</p>}
    </article>
  );
}
