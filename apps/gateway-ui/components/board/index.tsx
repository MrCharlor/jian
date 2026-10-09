'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BoardCard } from '../../lib/api';
import type { SectionProps } from '../props';
import { Badge, Empty, SectionHeading } from '../ui';

const columns: Array<{ status: BoardCard['status']; label: string }> = [
  { status: 'todo', label: 'A fazer' },
  { status: 'in_progress', label: 'Fazendo' },
  { status: 'review', label: 'Em revisão' },
  { status: 'blocked', label: 'Bloqueado' },
  { status: 'done', label: 'Feito' },
];

/** The board is read again on this beat: agents move their tasks while the owner looks. */
const REFRESH_MS = 30_000;

/** "3 min", "2 h 10 min", "4 d 2 h": how long, as a person says it. */
export function duration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** Every agent's tasks on one board: who is doing what, for which topic, and for how long. */
export function Board({ api }: SectionProps) {
  const [cards, setCards] = useState<BoardCard[]>();
  const [error, setError] = useState('');
  const [agent, setAgent] = useState('');
  const [pauta, setPauta] = useState('');
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(
    () =>
      api
        .board()
        .then((items) => {
          setCards(items);
          setNow(Date.now());
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'O quadro não carregou.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const agents = useMemo(
    () => [...new Set((cards ?? []).map((card) => card.agent))].sort(),
    [cards],
  );
  const pautas = useMemo(
    () =>
      [
        ...new Set(
          (cards ?? []).map((card) => card.pauta).filter((item): item is string => Boolean(item)),
        ),
      ].sort(),
    [cards],
  );
  const shown = (cards ?? []).filter(
    (card) => (!agent || card.agent === agent) && (!pauta || card.pauta === pauta),
  );

  return (
    <>
      <SectionHeading
        title="Quadro"
        description="As tarefas que cada agente assumiu, de todos os agentes, e quanto tempo levaram."
      />
      <div className="board-filters">
        <select
          aria-label="Agente"
          value={agent}
          onChange={(event) => setAgent(event.target.value)}
        >
          <option value="">Todos os agentes</option>
          {agents.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
        <select aria-label="Pauta" value={pauta} onChange={(event) => setPauta(event.target.value)}>
          <option value="">Todas as pautas</option>
          {pautas.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {cards && !cards.length ? (
        <Empty title="Nenhuma tarefa ainda">
          Quando um agente assume um trabalho, ele aparece aqui.
        </Empty>
      ) : (
        <div className="board">
          {columns.map((column) => {
            const here = shown.filter((card) => card.status === column.status);

            return (
              <section key={column.status} className="board-column" aria-label={column.label}>
                <h3>
                  {column.label} <Badge dot={false}>{here.length}</Badge>
                </h3>
                {here.map((card) => (
                  <article key={card.id} className="board-card">
                    <strong>{card.title}</strong>
                    <small>{card.agent}</small>
                    {card.pauta && <Badge dot={false}>{card.pauta}</Badge>}
                    <small>
                      {card.status === 'done' && card.workedMs !== undefined
                        ? `Levou ${duration(card.workedMs)}`
                        : `Há ${duration(now - Date.parse(card.statusSince))} nesta coluna`}
                    </small>
                  </article>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
