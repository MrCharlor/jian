'use client';

import { ArrowLeft, Check, Gavel, Plus, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Pauta } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, Modal, SectionHeading } from '../ui';
import { Markdown } from '../ui/markdown';

export const stateLabel: Record<Pauta['state'], string> = {
  descoberta: 'Descoberta',
  'pronta-para-epico': 'Pronta para épico',
  'em-execucao': 'Em execução',
  'em-teste': 'Em teste',
  'em-producao': 'Em produção',
  pausada: 'Pausada',
  concluida: 'Concluída',
  descartada: 'Descartada',
};

const priorityLabel: Record<Pauta['priority'], string> = {
  alta: 'Alta',
  media: 'Média',
  baixa: 'Baixa',
  'a-definir': 'A definir',
};

const linkLabel = { pedido: 'Pedido', epico: 'Épico', task: 'Task' } as const;

/** The owner's topics: what each is, where it stands on the board, and what was decided. */
export function Pautas({ api }: SectionProps) {
  const router = useRouter();
  const query = useSearchParams();
  const open = query.get('pauta') ?? undefined;
  const [list, setList] = useState<Pauta[]>();
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'ativas' | 'todas'>('ativas');

  const load = useCallback(
    () =>
      api
        .pautas()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As pautas não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const show = (id?: string) => router.replace(id ? `/pautas/?pauta=${id}` : '/pautas/');
  const current = list?.find((item) => item.id === open);

  if (current) return <PautaDetail pauta={current} api={api} back={() => show()} reload={load} />;

  const visible = (list ?? []).filter((item) =>
    filter === 'todas' ? true : !['concluida', 'descartada'].includes(item.state),
  );

  return (
    <>
      <SectionHeading
        title="Pautas"
        description="Os temas de produto que você carrega, com as telas, os cards do Work e as decisões."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            Nova pauta
          </Button>
        }
      />
      <div className="application-tabs" role="tablist">
        {(['ativas', 'todas'] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={filter === item}
            className={filter === item ? 'active' : ''}
            onClick={() => setFilter(item)}
          >
            {item === 'ativas' ? 'Ativas' : 'Todas'}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      {list && !visible.length ? (
        <Empty title="Nenhuma pauta aqui">
          Os agentes e você criam pautas; elas aparecem aqui.
        </Empty>
      ) : (
        <div className="prototype-list">
          {visible.map((item) => {
            const pending = item.decisions.filter(
              (decision) => decision.state === 'proposta',
            ).length;
            const moved = item.links.filter((link) => link.previousColumn).length;

            return (
              <button
                key={item.id}
                type="button"
                className="prototype-row"
                onClick={() => show(item.id)}
              >
                <strong>{item.title}</strong>
                <span>
                  <Badge>{stateLabel[item.state]}</Badge>
                  <Badge dot={false}>Prioridade {priorityLabel[item.priority]}</Badge>
                  {item.application && <Badge dot={false}>{item.application}</Badge>}
                  {pending > 0 && <Badge tone="accent">{pending} decisão a tomar</Badge>}
                  {moved > 0 && <Badge tone="warn">{moved} card mudou de coluna</Badge>}
                </span>
                <small>
                  {item.waitingOn ? `Espera: ${item.waitingOn} · ` : ''}Atualizada em{' '}
                  {date(item.updatedAt)}
                </small>
              </button>
            );
          })}
        </div>
      )}
      {creating && (
        <NewPauta
          close={() => setCreating(false)}
          create={async (input) => {
            const created = await api.createPauta(input);
            setCreating(false);
            await load();
            show(created.id);
          }}
        />
      )}
    </>
  );
}

function NewPauta({
  close,
  create,
}: {
  close: () => void;
  create: (input: { title: string; context: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [context, setContext] = useState('');

  return (
    <Modal
      title="Nova pauta"
      close={close}
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancelar
          </Button>
          <Button
            disabled={!title.trim()}
            onClick={() => void create({ title: title.trim(), context: context.trim() })}
          >
            Criar pauta
          </Button>
        </>
      }
    >
      <div className="settings-fields">
        <Field label="Título">
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Contexto" hint="De onde veio, para quem, o que já se sabe.">
          <textarea rows={6} value={context} onChange={(event) => setContext(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function PautaDetail({
  pauta,
  api,
  back,
  reload,
}: {
  pauta: Pauta;
  api: SectionProps['api'];
  back: () => void;
  reload: () => Promise<void>;
}) {
  const [choices, setChoices] = useState<Record<string, { choice: string; reason: string }>>({});
  const [error, setError] = useState('');

  const decide = async (id: string) => {
    const answer = choices[id];
    if (!answer?.choice.trim()) return;

    try {
      await api.decide(id, answer.choice.trim(), answer.reason.trim() || undefined);
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível decidir.');
    }
  };

  return (
    <>
      <SectionHeading
        title={pauta.title}
        description={[
          stateLabel[pauta.state],
          `Prioridade ${priorityLabel[pauta.priority]}`,
          pauta.application,
        ]
          .filter(Boolean)
          .join(' · ')}
        action={
          <Button variant="quiet" onClick={back}>
            <ArrowLeft size={16} />
            Pautas
          </Button>
        }
      />
      {error && <p className="error">{error}</p>}

      <section className="pauta-chain">
        <div>
          <h3>Pauta</h3>
          {pauta.context ? (
            <Markdown text={pauta.context} />
          ) : (
            <p className="note">Sem contexto escrito.</p>
          )}
          {pauta.waitingOn && <p className="note">Espera: {pauta.waitingOn}</p>}
        </div>
        <div>
          <h3>Telas</h3>
          {pauta.screens.length ? (
            <ul>
              {pauta.screens.map((screen) => (
                <li key={`${screen.route}-${screen.name}`}>
                  {screen.name}
                  {screen.route && <code> {screen.route}</code>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">Nenhuma tela ligada.</p>
          )}
        </div>
        <div>
          <h3>Demanda no Work</h3>
          {pauta.links.length ? (
            <ul>
              {pauta.links.map((link) => (
                <li key={`${link.kind}-${link.workId}`}>
                  {linkLabel[link.kind]} {link.title ?? link.workId}
                  {link.column && (
                    <>
                      {' · '}
                      <Badge tone={link.previousColumn ? 'warn' : 'neutral'}>
                        {link.previousColumn
                          ? `${link.previousColumn} → ${link.column}`
                          : link.column}
                      </Badge>
                    </>
                  )}
                  {link.readAt && <small> lido em {date(link.readAt)}</small>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="note">Nenhum card ligado.</p>
          )}
        </div>
      </section>

      {pauta.nextSteps && (
        <section>
          <h3>Próximos passos</h3>
          <Markdown text={pauta.nextSteps} />
        </section>
      )}

      <section>
        <h3>
          <Gavel size={16} /> Decisões
        </h3>
        {!pauta.decisions.length && <p className="note">Nenhuma decisão registrada.</p>}
        <div className="request-list">
          {[...pauta.decisions].reverse().map((decision) => (
            <article className="request-card" key={decision.id}>
              <header>
                <div className="grow">
                  <h4>
                    #{decision.number} · {decision.question}
                    <Badge
                      tone={
                        decision.state === 'proposta'
                          ? 'accent'
                          : decision.state === 'decidida'
                            ? 'good'
                            : 'neutral'
                      }
                    >
                      {decision.state === 'proposta'
                        ? 'Para você decidir'
                        : decision.state === 'decidida'
                          ? 'Decidida'
                          : 'Descartada'}
                    </Badge>
                  </h4>
                  <small>
                    {decision.proposedBy ? `Proposta por ${decision.proposedBy}` : 'Registrada'}
                    {decision.replaces ? ` · substitui a #${decision.replaces}` : ''}
                  </small>
                </div>
                <time dateTime={decision.createdAt}>{date(decision.createdAt)}</time>
              </header>
              <ol>
                {decision.options.map((option) => (
                  <li key={option}>{option}</li>
                ))}
              </ol>
              <p>
                <strong>Contraponto:</strong> {decision.counterpoint}
              </p>
              <p>
                <strong>Recomendação:</strong> {decision.recommendation}
              </p>
              {decision.state === 'decidida' && (
                <p>
                  <strong>Escolha:</strong> {decision.choice}
                  {decision.reason && ` · ${decision.reason}`}
                </p>
              )}
              {decision.state === 'proposta' && (
                <footer>
                  <input
                    aria-label={`Escolha da decisão ${decision.number}`}
                    placeholder="Sua escolha"
                    value={choices[decision.id]?.choice ?? ''}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [decision.id]: {
                          choice: event.target.value,
                          reason: current[decision.id]?.reason ?? '',
                        },
                      }))
                    }
                  />
                  <input
                    aria-label={`Motivo da decisão ${decision.number}`}
                    placeholder="Motivo, opcional"
                    value={choices[decision.id]?.reason ?? ''}
                    onChange={(event) =>
                      setChoices((current) => ({
                        ...current,
                        [decision.id]: {
                          choice: current[decision.id]?.choice ?? '',
                          reason: event.target.value,
                        },
                      }))
                    }
                  />
                  <Button
                    variant="quiet"
                    onClick={() => void api.discardDecision(decision.id).then(reload)}
                    aria-label={`Descartar decisão ${decision.number}`}
                  >
                    <X size={16} />
                  </Button>
                  <Button variant="secondary" onClick={() => void decide(decision.id)}>
                    <Check size={16} />
                    Decidir
                  </Button>
                </footer>
              )}
            </article>
          ))}
        </div>
      </section>

      {pauta.prototypes.length > 0 && (
        <section>
          <h3>Protótipos</h3>
          <ul>
            {pauta.prototypes.map((item) => (
              <li key={item.id}>
                {item.title}
                {item.approvedVersion ? ` · versão ${item.approvedVersion} aprovada` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
