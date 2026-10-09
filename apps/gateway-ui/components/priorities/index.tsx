'use client';

import { ArrowDown, ArrowUp, Check, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { PriorityProposal } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, SectionHeading } from '../ui';
import { Markdown } from '../ui/markdown';

const stateLabel: Record<PriorityProposal['state'], string> = {
  proposta: 'Para você aplicar',
  aplicada: 'Aplicada',
  descartada: 'Descartada',
};

/** The order of the column the team pulls first: the agent proposes, the owner adjusts and applies. */
export function Priorities({ api }: SectionProps) {
  const [criteria, setCriteria] = useState<string>();
  const [savedCriteria, setSavedCriteria] = useState('');
  const [proposals, setProposals] = useState<PriorityProposal[]>();
  const [error, setError] = useState('');

  const fail = (failure: unknown, fallback: string) =>
    setError(failure instanceof Error ? failure.message : fallback);

  const load = useCallback(
    () =>
      Promise.all([api.priorityCriteria(), api.priorityProposals()])
        .then(([read, list]) => {
          setCriteria(read.text);
          setSavedCriteria(read.text);
          setProposals(list);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'A priorização não carregou.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const open = proposals?.find((item) => item.state === 'proposta');
  const past = (proposals ?? []).filter((item) => item.state !== 'proposta');

  return (
    <>
      <SectionHeading
        title="Priorização"
        description="A ordem do que o time puxa primeiro. O agente propõe com um motivo por card; você ajusta e aplica no Work."
      />
      {error && <p className="error">{error}</p>}

      <section className="priority-criteria">
        <Field
          label="Critérios"
          hint="O agente lê antes de propor. Ex.: loja parada primeiro, depois urgência do suporte."
        >
          <textarea
            rows={5}
            value={criteria ?? ''}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </Field>
        <Button
          variant="secondary"
          disabled={criteria === undefined || criteria === savedCriteria}
          onClick={() =>
            void api
              .setPriorityCriteria(criteria ?? '')
              .then((saved) => {
                setSavedCriteria(saved.text);
                setError('');
              })
              .catch((failure) => fail(failure, 'Os critérios não foram salvos.'))
          }
        >
          Salvar critérios
        </Button>
      </section>

      {open ? (
        <OpenProposal key={open.id} proposal={open} api={api} reload={load} />
      ) : (
        proposals && (
          <Empty title="Nenhuma proposta aberta">
            O agente propõe toda segunda às 8h, ou quando você pedir no chat.
          </Empty>
        )
      )}

      {past.length > 0 && (
        <section>
          <h3>Anteriores</h3>
          <div className="prototype-list">
            {past.map((item) => (
              <div key={item.id} className="prototype-row">
                <strong>
                  #{item.number} · {item.summary.split('\n')[0]}
                </strong>
                <span>
                  <Badge tone={item.state === 'aplicada' ? 'good' : 'neutral'}>
                    {stateLabel[item.state]}
                  </Badge>
                  {item.adjusted && <Badge tone="warn">Com seus ajustes</Badge>}
                  {item.proposedBy && <Badge dot={false}>{item.proposedBy}</Badge>}
                </span>
                <small>
                  Proposta em {date(item.createdAt)}
                  {item.decidedAt ? ` · decidida em ${date(item.decidedAt)}` : ''}
                  {item.note ? ` · ${item.note}` : ''}
                </small>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function OpenProposal({
  proposal,
  api,
  reload,
}: {
  proposal: PriorityProposal;
  api: SectionProps['api'];
  reload: () => Promise<void>;
}) {
  const [order, setOrder] = useState(proposal.cards);
  const [left, setLeft] = useState<PriorityProposal['cards']>([]);
  const [dragging, setDragging] = useState<number>();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(proposal.error ?? '');

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [card] = next.splice(from, 1);
    if (card) next.splice(to, 0, card);
    setOrder(next);
  };

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'O Work não respondeu.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h3>
        Proposta #{proposal.number} <Badge tone="accent">{stateLabel.proposta}</Badge>
      </h3>
      <small>
        {proposal.proposedBy ? `Por ${proposal.proposedBy} · ` : ''}
        {date(proposal.createdAt)}
      </small>
      <Markdown text={proposal.summary} />
      {error && <p className="error">{error}</p>}

      <div className="priority-compare">
        <div>
          <h4>Hoje no Work</h4>
          <ol>
            {proposal.current.map((card) => (
              <li key={card.workId}>{card.title}</li>
            ))}
          </ol>
        </div>
        <div>
          <h4>Ordem para aplicar</h4>
          <ol className="priority-order">
            {order.map((card, index) => (
              <li
                key={card.workId}
                className={`priority-item${dragging === index ? ' dragging' : ''}`}
                draggable
                onDragStart={() => setDragging(index)}
                onDragEnd={() => setDragging(undefined)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragging !== undefined) move(dragging, index);
                  setDragging(undefined);
                }}
              >
                <b>{index + 1}.</b>
                <div>
                  {card.title} {card.raise && <Badge tone="warn">Sobe do Aprovado</Badge>}
                  {card.reason ? <small>{card.reason}</small> : <small>Sem motivo do agente</small>}
                </div>
                <nav>
                  <Button
                    variant="quiet"
                    aria-label={`Subir ${card.title}`}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="quiet"
                    aria-label={`Descer ${card.title}`}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, index + 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  {card.raise && (
                    <Button
                      variant="quiet"
                      aria-label={`Deixar ${card.title} no Aprovado`}
                      onClick={() => {
                        setOrder(order.filter((item) => item.workId !== card.workId));
                        setLeft([...left, card]);
                      }}
                    >
                      <X size={14} />
                    </Button>
                  )}
                </nav>
              </li>
            ))}
          </ol>
          {left.length > 0 && (
            <>
              <h4>Fica no Aprovado</h4>
              <ul>
                {left.map((card) => (
                  <li key={card.workId}>
                    {card.title}{' '}
                    <Button
                      variant="quiet"
                      aria-label={`Voltar ${card.title} para a ordem`}
                      onClick={() => {
                        setLeft(left.filter((item) => item.workId !== card.workId));
                        setOrder([...order, card]);
                      }}
                    >
                      <Undo2 size={14} />
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="prototype-buttons">
        <input
          aria-label="Motivo para descartar"
          placeholder="Motivo para descartar, opcional"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() =>
            void act(() => api.discardPriorities(proposal.id, note.trim() || undefined))
          }
        >
          <X size={16} />
          Descartar
        </Button>
        <Button
          busy={busy}
          disabled={busy || !order.length}
          onClick={() =>
            void act(() =>
              api.applyPriorities(
                proposal.id,
                order.map((card) => card.workId),
              ),
            )
          }
        >
          <Check size={16} />
          Aplicar no Work
        </Button>
      </div>
    </section>
  );
}
