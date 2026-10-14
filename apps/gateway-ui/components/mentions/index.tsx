'use client';

import { Check, ExternalLink, Pencil, Send, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Mention, MentionSettings, MentionState } from '../../lib/api';
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

export const mentionStateLabel: Record<MentionState, string> = {
  received: 'Na triagem',
  ignored_scope: 'Fora da Sigma',
  not_po: 'Não é do PO',
  analyzing: 'Em análise',
  answered: 'Respondida pela Atena',
  waiting: 'Esperando você',
  held: 'Esperando você (avisado no card)',
  owner_answered: 'Respondida por você',
  owner_ignored: 'Ignorada',
  failed: 'Falhou',
};

const stateTone: Record<MentionState, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  received: 'neutral',
  ignored_scope: 'neutral',
  not_po: 'neutral',
  analyzing: 'neutral',
  answered: 'good',
  waiting: 'accent',
  held: 'warn',
  owner_answered: 'good',
  owner_ignored: 'neutral',
  failed: 'bad',
};

const kindLabel: Record<NonNullable<Mention['kind']>, string> = {
  comum: 'Comum',
  tecnica: 'Técnica (com o Lucas)',
  alto_impacto: 'Alto impacto',
};

/** What waits for the owner first, what the agent is still reading, then what ended. */
const GROUPS: Array<{ id: string; title: string; states: MentionState[] }> = [
  { id: 'waiting', title: 'Esperando você', states: ['waiting', 'held'] },
  { id: 'running', title: 'Em andamento', states: ['received', 'analyzing'] },
  {
    id: 'history',
    title: 'Histórico',
    states: ['answered', 'owner_answered', 'owner_ignored', 'not_po', 'failed'],
  },
];

const WAITING = new Set<MentionState>(['waiting', 'held']);

/**
 * Comments on the Work answered for the owner (B22): the high-impact ones wait here for the
 * owner's OK; the rest is the history of what the agent answered alone. Settings close the page.
 */
export function Mentions({ api, data }: SectionProps) {
  const [list, setList] = useState<Mention[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .mentions()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As menções não carregaram.'),
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

  const groups = GROUPS.map((group) => ({
    ...group,
    items: (list ?? []).filter((item) => group.states.includes(item.state)),
  }));

  return (
    <>
      <SectionHeading
        title="Menções"
        description="Comentários no Work com dúvida do PO. A Atena responde no card na hora; o que cai na lista de alto impacto espera aqui o seu OK."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list && !list.length ? (
        <Empty title="Nenhuma menção ainda">
          Quando alguém comentar num card da Sigma com uma dúvida do PO, a resposta da Atena aparece
          aqui.
        </Empty>
      ) : (
        list &&
        groups.map((group) =>
          group.items.length || group.id === 'waiting' ? (
            <section key={group.id} className="row-group" aria-labelledby={`mentions-${group.id}`}>
              <h2 id={`mentions-${group.id}`}>
                {group.title} <Badge dot={false}>{group.items.length}</Badge>
              </h2>
              {group.items.length ? (
                <div className="request-list">
                  {group.items.map((item) => (
                    <MentionCard key={item.id} mention={item} api={api} act={act} busy={busy} />
                  ))}
                </div>
              ) : (
                <p className="note">Nada esperando você agora.</p>
              )}
            </section>
          ) : null,
        )
      )}
      <Disclosure
        title="Configurações"
        hint="Ligado, onde vale, assinatura, modelo da triagem, prazo do aviso e a lista de alto impacto."
        icon={<Settings size={18} />}
      >
        <MentionSettingsCard api={api} data={data} />
      </Disclosure>
    </>
  );
}

function MentionCard({
  mention,
  api,
  act,
  busy,
}: {
  mention: Mention;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(mention.proposedReply ?? '');
  const waiting = WAITING.has(mention.state);

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{mention.number} · {mention.cardTitle ?? 'Card sem título'}
            <Badge tone={stateTone[mention.state]}>{mentionStateLabel[mention.state]}</Badge>
          </h4>
          <small>
            {[
              mention.authorName ?? 'Autor desconhecido',
              mention.kind && kindLabel[mention.kind],
              mention.highImpactItem && `item ${mention.highImpactItem} da lista`,
              date(mention.createdAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </div>
      </header>

      <div className="request-body">
        {mention.cardUrl && (
          <nav className="request-links" aria-label={`Links da menção #${mention.number}`}>
            <a className="text-button" href={mention.cardUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Card no Work
            </a>
          </nav>
        )}

        <div>
          <h5>Comentário</h5>
          <MoreText lines={4}>{mention.body}</MoreText>
        </div>

        {waiting && mention.proposedReply && !editing && (
          <div className="owner-callout accent">
            <strong>Resposta proposta</strong>
            <MoreText lines={4}>{mention.proposedReply}</MoreText>
          </div>
        )}

        {waiting && editing && (
          <Field
            label="Sua resposta"
            hint="Vai no card depois de marcar quem perguntou e da assinatura. Só os acentos e o travessão são ajustados."
          >
            <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
        )}

        {mention.publishedReply && (
          <div className="owner-callout good">
            <strong>
              <Check size={14} /> Publicado no card
            </strong>
            <MoreText lines={4}>{mention.publishedReply}</MoreText>
          </div>
        )}

        {mention.reason && <p className="note my-0">{mention.reason}</p>}
      </div>

      {waiting && (
        <footer>
          <p>
            {mention.state === 'held'
              ? 'O card já foi avisado de que você vai responder.'
              : 'Nada foi publicado no card ainda.'}
          </p>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => void act(() => api.ignoreMention(mention.number))}
          >
            <X size={16} /> Ignorar
          </Button>
          {editing ? (
            <Button
              busy={busy}
              disabled={busy || !text.trim()}
              onClick={() => void act(() => api.answerMention(mention.number, text.trim()))}
            >
              <Send size={16} /> Publicar o meu texto
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                <Pencil size={16} /> Editar e publicar
              </Button>
              <Button
                busy={busy}
                disabled={busy || !mention.proposedReply}
                onClick={() => void act(() => api.answerMention(mention.number))}
              >
                <Send size={16} /> Publicar
              </Button>
            </>
          )}
        </footer>
      )}
    </article>
  );
}

/** One card: whether it runs, where, how it signs, the triage model and the high-impact list. */
function MentionSettingsCard({ api, data }: Pick<SectionProps, 'api' | 'data'>) {
  const [settings, setSettings] = useState<MentionSettings>();
  const [list, setList] = useState('');
  const [signature, setSignature] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .mentionSettings()
      .then((saved) => {
        setSettings(saved);
        setList(saved.highImpact.join('\n'));
        setSignature(saved.signature);
      })
      .catch(() => setMessage('A configuração não carregou.'));
  }, [api]);

  const save = (patch: Parameters<typeof api.updateMentionSettings>[0]) =>
    api
      .updateMentionSettings(patch)
      .then((saved) => {
        setSettings(saved);
        setMessage('Salvo.');
      })
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não salvou.'));

  if (!settings) {
    return message ? (
      <p className="form-error my-0" role="alert">
        {message}
      </p>
    ) : null;
  }

  const model = settings.triageModel;
  const models = model ? (data.providerModels[model.providerId]?.models ?? []) : [];
  const items = list
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>Menções no Work</h4>
          <small>Vale para todo comentário que a automação do Work manda para a Atena.</small>
        </div>
      </header>
      <div className="request-body">
        <SwitchField
          label="Ligado"
          hint="Desligado: os comentários chegam e são descartados, sem triagem nem resposta."
          checked={settings.enabled}
          onChange={(enabled) => void save({ enabled })}
        />
        <div className="owner-fields">
          <Field label="Onde vale" hint="Sigma: Entrada, Épicos e Tasks. Workspace: qualquer card.">
            <select
              value={settings.scope}
              onChange={(event) =>
                void save({ scope: event.target.value as MentionSettings['scope'] })
              }
            >
              <option value="sigma">Só a Sigma</option>
              <option value="workspace">Todo o workspace</option>
            </select>
          </Field>
          <Field
            label="Aviso sem OK"
            hint="Depois desse prazo o card recebe que o Moabe vai responder."
          >
            <select
              value={settings.holdHours}
              onChange={(event) => void save({ holdHours: Number(event.target.value) })}
            >
              {[1, 2, 4, 8, 24].map((hours) => (
                <option key={hours} value={hours}>
                  {hours}h
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assinatura" hint="Vem depois de marcar quem perguntou.">
            <input
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              onBlur={() =>
                signature.trim() &&
                signature.trim() !== settings.signature &&
                void save({ signature: signature.trim() })
              }
            />
          </Field>
          <Field
            label="Provedor da triagem"
            hint="Padrão: o Haiku 5.5 no provedor do modelo de conversa do agente."
          >
            <select
              value={model?.providerId ?? ''}
              onChange={(event) =>
                void save({
                  triageModel: event.target.value
                    ? {
                        providerId: event.target.value,
                        modelId:
                          data.providerModels[event.target.value]?.models[0]?.id ??
                          model?.modelId ??
                          'claude-haiku-5-5',
                      }
                    : null,
                })
              }
            >
              <option value="">Padrão</option>
              {data.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </Field>
          {model && (
            <Field label="Modelo da triagem" hint="Barato: só decide se a dúvida é do PO.">
              <select
                value={model.modelId}
                onChange={(event) =>
                  void save({ triageModel: { ...model, modelId: event.target.value } })
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
        <Field
          label="Lista de alto impacto"
          hint="Um item por linha. Dúvida que cai num item espera o seu OK; o número é a ordem da linha."
        >
          <textarea rows={8} value={list} onChange={(event) => setList(event.target.value)} />
        </Field>
      </div>
      <footer>
        <p role="status">{message}</p>
        <Button
          variant="secondary"
          disabled={!items.length || items.join('\n') === settings.highImpact.join('\n')}
          onClick={() => void save({ highImpact: items })}
        >
          <Check size={16} /> Salvar a lista
        </Button>
      </footer>
    </article>
  );
}
