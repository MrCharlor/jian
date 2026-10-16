'use client';

import { Check, ExternalLink, MessageSquareText, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { InboxItem, InboxList } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, SectionHeading } from '../ui';

export const inboxKindLabel: Record<InboxItem['kind'], string> = {
  aprovacao: 'Ação de agente',
  plano: 'Plano',
  regra: 'Regra da base',
  decisao: 'Decisão de pauta',
  validacao: 'Validação de épico',
  comentario: 'Comentário de reprovação',
  mencao: 'Menção no Work',
  roadmap: 'Roadmap',
  priorizacao: 'Priorização',
  prototipo: 'Protótipo',
  epico: 'Épico',
};

const minutes = (value: number) =>
  value < 60
    ? `${value} min`
    : value < 1440
      ? `${Math.round(value / 60)} h`
      : `${Math.round(value / 1440)} d`;

/**
 * Everything that waits for the owner, from every queue, under the number the chat answers
 * with (B26): the high-impact first, then the oldest. Each queue's own page still holds the
 * details; this page is where the owner decides.
 */
export function Inbox({ api }: SectionProps) {
  const [list, setList] = useState<InboxList>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .inbox()
        .then((loaded) => {
          setList(loaded);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'A caixa não carregou.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (item: InboxItem, action: 'ok' | 'no' | 'text', text?: string) => {
    setBusy(true);
    try {
      await api.decideInbox(item.number, { action, ...(text ? { text } : {}) });
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  const timing = (list?.stats ?? []).filter((stat) => stat.medianMinutes !== undefined);

  return (
    <>
      <SectionHeading
        title="Esperando você"
        description='Tudo o que espera a sua decisão, de todas as filas, com um número só. No Telegram vale o mesmo: "ok N", "não N: motivo" ou "N: texto".'
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {timing.length > 0 && (
        <p className="note">
          Tempo até a sua decisão (mediana, 30 dias):{' '}
          {timing
            .map((stat) => `${inboxKindLabel[stat.kind]} ${minutes(stat.medianMinutes ?? 0)}`)
            .join(' · ')}
        </p>
      )}
      {list && !list.items.length ? (
        <Empty title="Nada esperando você">Quando um agente precisar de você, aparece aqui.</Empty>
      ) : (
        list && (
          <section className="row-group" aria-labelledby="inbox-open">
            <h2 id="inbox-open">
              Abertos <Badge dot={false}>{list.items.length}</Badge>
            </h2>
            <div className="request-list">
              {list.items.map((item) => (
                <InboxCard key={item.number} item={item} busy={busy} decide={decide} />
              ))}
            </div>
          </section>
        )
      )}
    </>
  );
}

function InboxCard({
  item,
  busy,
  decide,
}: {
  item: InboxItem;
  busy: boolean;
  decide: (item: InboxItem, action: 'ok' | 'no' | 'text', text?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'no' | 'text'>();
  const [text, setText] = useState('');

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{item.number} · {item.title}
            {item.highImpact && <Badge tone="accent">Alto impacto</Badge>}
          </h4>
          <small>
            {inboxKindLabel[item.kind]} {item.refNumber} · esperando desde {date(item.createdAt)}
          </small>
        </div>
      </header>
      <div className="request-body">
        <p className="my-0">
          <strong>{item.question}</strong>
        </p>
        {item.link && (
          <nav className="request-links" aria-label={`Links do item #${item.number}`}>
            <a className="text-button" href={item.link} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Abrir
            </a>
          </nav>
        )}
        {item.details.length > 0 && (
          <ul className="my-0">
            {item.details.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        <div className="owner-callout">
          <p className="my-0">
            <strong>{item.okLabel}:</strong> {item.ifOk}
          </p>
          <p className="my-0">
            <strong>{item.noLabel}:</strong> {item.ifNo}
          </p>
          {item.ifText && (
            <p className="my-0">
              <strong>Responder:</strong> {item.ifText}
            </p>
          )}
        </div>
        {mode && (
          <Field
            label={mode === 'no' ? 'Motivo' : 'Sua resposta'}
            hint={
              mode === 'no'
                ? 'Opcional. Vira lição para o agente.'
                : 'Vale como o "N: texto" do Telegram.'
            }
          >
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
        )}
      </div>
      <footer>
        <p>{`Telegram: "ok ${item.number}", "não ${item.number}: motivo"${item.acceptsText ? ` ou "${item.number}: texto"` : ''}`}</p>
        {mode ? (
          <>
            <Button variant="quiet" disabled={busy} onClick={() => setMode(undefined)}>
              Cancelar
            </Button>
            <Button
              busy={busy}
              disabled={busy || (mode === 'text' && !text.trim())}
              onClick={() => void decide(item, mode, text.trim() || undefined)}
            >
              {mode === 'no' ? item.noLabel : 'Enviar'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" disabled={busy} onClick={() => setMode('no')}>
              <X size={16} /> {item.noLabel}
            </Button>
            {item.acceptsText && (
              <Button variant="secondary" disabled={busy} onClick={() => setMode('text')}>
                <MessageSquareText size={16} /> Responder
              </Button>
            )}
            <Button busy={busy} disabled={busy} onClick={() => void decide(item, 'ok')}>
              <Check size={16} /> {item.okLabel}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}
