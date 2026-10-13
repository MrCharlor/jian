'use client';

import { ArrowDown, ArrowUp, Check, ListOrdered, Save, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { PriorityProposal } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, MoreText, ResourceRow, SectionHeading } from '../ui';
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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
  const changed = criteria !== undefined && criteria !== savedCriteria;

  const saveCriteria = async () => {
    setSaving(true);
    try {
      const result = await api.setPriorityCriteria(criteria ?? '');

      setSavedCriteria(result.text);
      setSaved(true);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Os critérios não foram salvos.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Priorização"
        description="A ordem do que o time puxa primeiro. O agente propõe com um motivo por card; você ajusta e aplica no Work."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="row-group" aria-labelledby="priorities-open">
        <h2 id="priorities-open">Proposta aberta</h2>
        {open ? (
          <OpenProposal key={open.id} proposal={open} api={api} reload={load} />
        ) : (
          proposals && (
            <Empty title="Nenhuma proposta aberta">
              O agente propõe toda segunda às 8h, ou quando você pedir no chat.
            </Empty>
          )
        )}
      </section>

      <section className="row-group" aria-labelledby="priorities-criteria">
        <h2 id="priorities-criteria">Critérios</h2>
        <article className="request-card">
          <div className="request-body">
            <Field
              label="Critérios de priorização"
              hint="O agente lê antes de propor. Ex.: loja parada primeiro, depois urgência do suporte."
            >
              <textarea
                rows={5}
                value={criteria ?? ''}
                onChange={(event) => {
                  setCriteria(event.target.value);
                  setSaved(false);
                }}
              />
            </Field>
          </div>
          <footer>
            <p role="status">
              {changed
                ? 'Alterações não salvas.'
                : saved
                  ? 'Critérios salvos.'
                  : 'Sem alterações desde o último salvamento.'}
            </p>
            <Button
              variant={changed ? 'primary' : 'secondary'}
              busy={saving}
              disabled={criteria === undefined}
              onClick={() => void saveCriteria()}
            >
              <Save size={16} /> Salvar critérios
            </Button>
          </footer>
        </article>
      </section>

      {past.length > 0 && (
        <section className="row-group" aria-labelledby="priorities-past">
          <h2 id="priorities-past">
            Anteriores <Badge dot={false}>{past.length}</Badge>
          </h2>
          <div className="resource-list">
            {past.map((item) => (
              <ResourceRow
                key={item.id}
                id={`priority-${item.id}`}
                icon={<ListOrdered size={20} strokeWidth={1.6} />}
                name={`#${item.number} · ${item.summary.split('\n')[0]}`}
                badges={
                  <>
                    <Badge tone={item.state === 'aplicada' ? 'good' : 'neutral'}>
                      {stateLabel[item.state]}
                    </Badge>
                    {item.adjusted && <Badge tone="warn">Com seus ajustes</Badge>}
                    {item.proposedBy && <Badge dot={false}>{item.proposedBy}</Badge>}
                  </>
                }
                description={`Proposta em ${date(item.createdAt)}${
                  item.decidedAt ? ` · decidida em ${date(item.decidedAt)}` : ''
                }`}
                extra={
                  item.note ? (
                    <div className="mt-2 text-xs text-muted">
                      <MoreText lines={2}>{`Motivo: ${item.note}`}</MoreText>
                    </div>
                  ) : undefined
                }
              />
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
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            Proposta #{proposal.number}
            <Badge tone="accent">{stateLabel.proposta}</Badge>
            {proposal.planNumber ? <Badge tone="warn">Plano #{proposal.planNumber}</Badge> : null}
          </h4>
          <small>
            {proposal.proposedBy ? `Por ${proposal.proposedBy} · ` : ''}
            {date(proposal.createdAt)}
          </small>
        </div>
      </header>
      <div className="request-body">
        {proposal.planNumber ? (
          <div className="owner-callout warn">
            <strong>Espera o plano #{proposal.planNumber}</strong>
            Esta proposta espera o plano #{proposal.planNumber} em Planos. Aplicar ou descartar aqui
            também decide o plano.
          </div>
        ) : null}
        <MoreText lines={4}>
          <div className="markdown">
            <Markdown text={proposal.summary} />
          </div>
        </MoreText>
        {error && (
          <p className="form-error my-0" role="alert">
            {error}
          </p>
        )}

        <div className="priority-board">
          <div>
            <h5>Hoje no Work</h5>
            <ol>
              {proposal.current.map((card) => (
                <li key={card.workId}>{card.title}</li>
              ))}
            </ol>
          </div>
          <div>
            <h5>Ordem para aplicar</h5>
            <ol className="priority-order grid gap-2">
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
                  <div className="min-w-0">
                    {card.title} {card.raise && <Badge tone="warn">Sobe do Aprovado</Badge>}
                    <small>{card.reason ?? 'Sem motivo do agente'}</small>
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
              <div className="mt-4">
                <h5>Fica no Aprovado</h5>
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
              </div>
            )}
          </div>
        </div>

        <Field label="Motivo para descartar" hint="Opcional. O agente lê na próxima proposta.">
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      <footer>
        <p>Use as setas ou arraste para mudar a ordem.</p>
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
      </footer>
    </article>
  );
}
