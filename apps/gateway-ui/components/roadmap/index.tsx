'use client';

import {
  ArrowRight,
  Ban,
  Check,
  ExternalLink,
  Pencil,
  Play,
  Settings,
  Sparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  Application,
  RoadmapItem,
  RoadmapKind,
  RoadmapLane,
  RoadmapProposal,
  RoadmapSettings,
} from '../../lib/api';
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

export const laneLabel: Record<RoadmapLane, string> = {
  agora: 'Agora',
  proximo: 'Próximo',
  depois: 'Depois',
};

const LANES: RoadmapLane[] = ['agora', 'proximo', 'depois'];

const kindLabel: Record<RoadmapKind, string> = {
  feature: 'Feature',
  melhoria: 'Melhoria',
  divida: 'Dívida',
  ideia: 'Ideia',
};

const originLabel: Record<RoadmapItem['origin'], string> = {
  moabe: 'seu',
  pedido: 'do pedido',
  pauta: 'da pauta',
  sugestao: 'sugestão do Estrategista',
};

const proposalVerb: Record<RoadmapProposal['kind'], string> = {
  incluir: 'Incluir',
  mover: 'Mover',
  concluir: 'Concluir',
  descartar: 'Descartar',
};

type Act = (work: () => Promise<unknown>) => Promise<void>;

/** What the proposal does, in one line: "Mover "Encomendas" de Próximo para Agora". */
function proposalLine(proposal: RoadmapProposal) {
  const title = proposal.item?.title ?? proposal.itemTitle ?? 'item';

  if (proposal.kind === 'incluir') {
    return `Incluir "${title}" em ${laneLabel[proposal.lane ?? 'depois']}`;
  }
  if (proposal.kind === 'mover') {
    return `Mover "${title}"${proposal.fromLane ? ` de ${laneLabel[proposal.fromLane]}` : ''} para ${laneLabel[proposal.lane ?? 'depois']}`;
  }

  return `${proposalVerb[proposal.kind]} "${title}"`;
}

/**
 * The products' roadmap (B24): what waits for the owner on top, the three lanes, and the
 * settings at the end. The Estrategista proposes; whatever the owner does here is direct.
 */
export function Roadmap({ api }: SectionProps) {
  const [items, setItems] = useState<RoadmapItem[]>();
  const [waiting, setWaiting] = useState<RoadmapProposal[]>([]);
  const [settings, setSettings] = useState<RoadmapSettings>();
  const [product, setProduct] = useState('');
  const [kind, setKind] = useState<RoadmapKind | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.roadmap(), api.roadmapProposals('aguardando_po'), api.roadmapSettings()])
        .then(([list, proposals, saved]) => {
          setItems(list);
          setWaiting(proposals);
          setSettings(saved);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'O roadmap não carregou.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const act: Act = async (work) => {
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

  const products = [
    ...new Map(
      (items ?? []).map((item) => [item.application, item.applicationName || item.application]),
    ),
  ];
  for (const slug of settings?.applications ?? []) {
    if (!products.some(([known]) => known === slug)) products.push([slug, slug]);
  }

  const shown = (items ?? []).filter(
    (item) => (!product || item.application === product) && (!kind || item.kind === kind),
  );
  const active = shown.filter((item) => item.state === 'ativo');
  const closed = shown.filter((item) => item.state !== 'ativo');
  const proposals = waiting.filter((proposal) => !product || proposal.application === product);

  return (
    <>
      <SectionHeading
        title="Roadmap"
        description="O que vem agora, a seguir e depois em cada produto, sem data. O Estrategista lê o Work e as pautas e propõe; o que você muda aqui vale na hora."
      />
      <div className="page-toolbar">
        <Field label="Produto">
          <select value={product} onChange={(event) => setProduct(event.target.value)}>
            <option value="">Todos</option>
            {products.map(([slug, name]) => (
              <option key={slug} value={slug}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as RoadmapKind | '')}
          >
            <option value="">Todos</option>
            {(Object.keys(kindLabel) as RoadmapKind[]).map((value) => (
              <option key={value} value={value}>
                {kindLabel[value]}
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

      <section className="row-group" aria-labelledby="roadmap-waiting">
        <h2 id="roadmap-waiting">
          Esperando você <Badge dot={false}>{proposals.length}</Badge>
        </h2>
        {proposals.length ? (
          <div className="request-list">
            {proposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} api={api} act={act} busy={busy} />
            ))}
          </div>
        ) : (
          <p className="note">Nenhuma proposta do Estrategista esperando você agora.</p>
        )}
      </section>

      {items && !items.length ? (
        <Empty title="Roadmap vazio">
          Mande "roadmap: sua ideia no App Gestores" no chat, ou espere a leitura do Estrategista.
        </Empty>
      ) : (
        items && (
          <div className="roadmap-lanes">
            {LANES.map((lane) => {
              const inLane = active.filter((item) => item.lane === lane);

              return (
                <section key={lane} className="row-group" aria-labelledby={`roadmap-${lane}`}>
                  <h2 id={`roadmap-${lane}`}>
                    {laneLabel[lane]} <Badge dot={false}>{inLane.length}</Badge>
                  </h2>
                  {inLane.length ? (
                    <div className="request-list">
                      {inLane.map((item) => (
                        <ItemCard key={item.id} item={item} api={api} act={act} busy={busy} />
                      ))}
                    </div>
                  ) : (
                    <p className="note">Nada aqui.</p>
                  )}
                </section>
              );
            })}
          </div>
        )
      )}

      {closed.length > 0 && (
        <Disclosure
          title="Concluídos e descartados"
          hint={`${closed.length} ${closed.length === 1 ? 'item' : 'itens'} fora das faixas.`}
          icon={<Check size={18} />}
        >
          <div className="request-list">
            {closed.map((item) => (
              <ItemCard key={item.id} item={item} api={api} act={act} busy={busy} />
            ))}
          </div>
        </Disclosure>
      )}

      <Disclosure
        title="Configurações"
        hint="Automático das movimentações, sugestões por rodada, Estrategista e produtos."
        icon={<Settings size={18} />}
      >
        <RoadmapSettingsCard api={api} settings={settings} onSaved={setSettings} />
      </Disclosure>
    </>
  );
}

function ProposalCard({
  proposal,
  api,
  act,
  busy,
}: {
  proposal: RoadmapProposal;
  api: SectionProps['api'];
  act: Act;
  busy: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'refuse'>('view');
  const [text, setText] = useState(proposal.kind === 'incluir' ? (proposal.item?.title ?? '') : '');

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{proposal.number} · {proposalLine(proposal)}
            {proposal.highImpact && <Badge tone="warn">Alto impacto</Badge>}
          </h4>
          <small>
            {[
              proposal.applicationName,
              proposal.item && kindLabel[proposal.item.kind],
              proposal.item?.theme,
              proposal.proposedBy ?? 'Estrategista',
              date(proposal.createdAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </div>
      </header>

      <div className="request-body">
        {proposal.item?.summary && <MoreText lines={3}>{proposal.item.summary}</MoreText>}
        <div>
          <h5>Por quê</h5>
          <MoreText lines={3}>{proposal.reason}</MoreText>
        </div>
        {proposal.counterpoint && (
          <div className="owner-callout warn">
            <strong>Contraponto</strong>
            <MoreText lines={3}>{proposal.counterpoint}</MoreText>
          </div>
        )}
        {proposal.evidence.length > 0 && (
          <div>
            <h5>Evidência</h5>
            <ul>
              {proposal.evidence.map((entry) => (
                <li key={entry}>
                  {/^https?:\/\//.test(entry) ? (
                    <a href={entry} target="_blank" rel="noreferrer">
                      {entry}
                    </a>
                  ) : (
                    entry
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {mode === 'edit' && (
          <Field
            label={proposal.kind === 'incluir' ? 'Título com o seu ajuste' : 'Seu ajuste'}
            hint={
              proposal.kind === 'incluir'
                ? 'O item entra com este título.'
                : 'Fica registrado junto da proposta aplicada.'
            }
          >
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
        )}
        {mode === 'refuse' && (
          <Field
            label="Motivo"
            hint="O Estrategista guarda e não repete a sugestão por 60 dias; o Curador aprende com ele."
          >
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
        )}
      </div>

      <footer>
        <p>Responda também no chat: "ok roadmap {proposal.number}".</p>
        {mode === 'view' ? (
          <>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setText('');
                setMode('refuse');
              }}
            >
              <X size={16} /> Recusar
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setMode('edit')}>
              <Pencil size={16} /> Ajustar
            </Button>
            <Button
              busy={busy}
              disabled={busy}
              onClick={() =>
                void act(() => api.decideRoadmapProposal(proposal.number, { action: 'ok' }))
              }
            >
              <Check size={16} /> Aplicar
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" disabled={busy} onClick={() => setMode('view')}>
              Cancelar
            </Button>
            <Button
              busy={busy}
              variant={mode === 'refuse' ? 'danger' : 'primary'}
              disabled={busy || (mode === 'edit' && !text.trim())}
              onClick={() =>
                void act(() =>
                  api.decideRoadmapProposal(proposal.number, {
                    action: mode === 'refuse' ? 'refuse' : 'edit',
                    ...(text.trim() ? { text: text.trim() } : {}),
                  }),
                )
              }
            >
              {mode === 'refuse' ? (
                <>
                  <X size={16} /> Recusar
                </>
              ) : (
                <>
                  <Check size={16} /> Aplicar com ajuste
                </>
              )}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}

function ItemCard({
  item,
  api,
  act,
  busy,
}: {
  item: RoadmapItem;
  api: SectionProps['api'];
  act: Act;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.summary);
  const [theme, setTheme] = useState(item.theme ?? '');
  const active = item.state === 'ativo';
  const update = (patch: Parameters<typeof api.updateRoadmapItem>[1]) =>
    act(() => api.updateRoadmapItem(item.id, patch));

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{item.number} · {item.title}
            {item.blocked && <Badge tone="warn">Bloqueado</Badge>}
            {item.state === 'concluido' && <Badge tone="good">Concluído</Badge>}
            {item.state === 'descartado' && <Badge>Descartado</Badge>}
          </h4>
          <small>
            {[
              item.applicationName || item.application,
              kindLabel[item.kind],
              item.theme,
              originLabel[item.origin],
            ]
              .filter(Boolean)
              .join(' · ')}
          </small>
        </div>
      </header>

      <div className="request-body">
        {editing ? (
          <>
            <Field label="Título">
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Field label="Resumo" hint="Por quê, e para quem.">
              <textarea
                rows={3}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
              />
            </Field>
            <Field label="Tema" hint="Agrupa itens: Fiscal, Encomendas. Vazio tira o tema.">
              <input value={theme} onChange={(event) => setTheme(event.target.value)} />
            </Field>
          </>
        ) : (
          item.summary && <MoreText lines={3}>{item.summary}</MoreText>
        )}
        {(item.pautaTitle || item.requestUrl || item.epicWorkIds.length > 0) && (
          <nav className="request-links" aria-label={`Links do item #${item.number}`}>
            {item.pautaTitle && <span>Pauta: {item.pautaTitle}</span>}
            {item.requestUrl && (
              <a className="text-button" href={item.requestUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Pedido no Work
              </a>
            )}
            {item.epicWorkIds.length > 0 && (
              <span>
                {item.epicWorkIds.length === 1 ? '1 épico' : `${item.epicWorkIds.length} épicos`}
              </span>
            )}
          </nav>
        )}
      </div>

      <footer>
        {editing ? (
          <>
            <Button variant="quiet" disabled={busy} onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button
              busy={busy}
              disabled={busy || !title.trim()}
              onClick={() =>
                void update({
                  title: title.trim(),
                  summary: summary.trim(),
                  theme: theme.trim() || null,
                }).then(() => setEditing(false))
              }
            >
              <Check size={16} /> Salvar
            </Button>
          </>
        ) : active ? (
          <>
            {LANES.filter((lane) => lane !== item.lane).map((lane) => (
              <Button
                key={lane}
                variant="secondary"
                disabled={busy}
                aria-label={`Mover #${item.number} para ${laneLabel[lane]}`}
                onClick={() => void update({ lane })}
              >
                <ArrowRight size={16} /> {laneLabel[lane]}
              </Button>
            ))}
            <Button variant="quiet" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={16} /> Editar
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => void update({ state: 'descartado' })}
            >
              <Ban size={16} /> Descartar
            </Button>
            <Button
              variant="quiet"
              disabled={busy}
              onClick={() => void update({ state: 'concluido' })}
            >
              <Check size={16} /> Concluir
            </Button>
          </>
        ) : (
          <Button variant="quiet" disabled={busy} onClick={() => void update({ state: 'ativo' })}>
            Voltar para {laneLabel[item.lane]}
          </Button>
        )}
      </footer>
    </article>
  );
}

/** The switch, how many suggestions, who keeps it, which products, and a run on demand. */
function RoadmapSettingsCard({
  api,
  settings,
  onSaved,
}: {
  api: SectionProps['api'];
  settings?: RoadmapSettings;
  onSaved: (settings: RoadmapSettings) => void;
}) {
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .profiles()
      .then((items) => setProfiles(items.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
    void api
      .applications()
      .then(setApplications)
      .catch(() => {});
  }, [api]);

  const save = (patch: Parameters<typeof api.updateRoadmapSettings>[0]) =>
    api
      .updateRoadmapSettings(patch)
      .then((saved) => {
        onSaved(saved);
        setMessage('Salvo.');
      })
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não salvou.'));

  const run = (kind: 'leitura' | 'sugestoes') =>
    api
      .runRoadmapSync(kind)
      .then(() =>
        setMessage(
          kind === 'leitura'
            ? 'O Estrategista começou a leitura; as propostas chegam aqui e no chat.'
            : 'O Estrategista começou a rodada de sugestões.',
        ),
      )
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não rodou.'));

  if (!settings) return null;

  const options = [
    ...applications.map((app) => ({ slug: app.slug, name: app.name })),
    ...settings.applications
      .filter((slug) => !applications.some((app) => app.slug === slug))
      .map((slug) => ({ slug, name: slug })),
  ];
  const toggle = (slug: string, on: boolean) => {
    const next = on
      ? [...settings.applications, slug]
      : settings.applications.filter((item) => item !== slug);

    if (next.length) void save({ applications: next });
  };

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>Estrategista</h4>
          <small>
            Só ele propõe e lê o Work para o roadmap; os outros agentes só leem. Sem Estrategista, o
            roadmap muda só pelas suas mãos.
          </small>
        </div>
      </header>
      <div className="request-body">
        <SwitchField
          label="Automático das movimentações"
          hint="Ligado: o que anda para frente no Work muda de faixa sozinho. Voltar faixa e descartar sempre pedem o seu OK."
          checked={settings.automaticMoves}
          onChange={(automaticMoves) => void save({ automaticMoves })}
        />
        <div className="owner-fields">
          <Field label="Estrategista" hint="O agente que mantém o roadmap e sugere.">
            <select
              value={settings.strategistProfileId ?? ''}
              onChange={(event) => void save({ strategistProfileId: event.target.value || null })}
            >
              <option value="">Nenhum</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sugestões por rodada" hint="Toda segunda, junto da priorização.">
            <select
              value={settings.suggestionsPerRound}
              onChange={(event) => void save({ suggestionsPerRound: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <fieldset className="roadmap-products">
          <legend>Produtos</legend>
          {options.map((option) => (
            <label key={option.slug}>
              <input
                type="checkbox"
                checked={settings.applications.includes(option.slug)}
                disabled={
                  settings.applications.length === 1 && settings.applications.includes(option.slug)
                }
                onChange={(event) => toggle(option.slug, event.target.checked)}
              />
              {option.name}
            </label>
          ))}
        </fieldset>
      </div>
      <footer>
        <p role="status">{message}</p>
        <Button
          variant="secondary"
          disabled={!settings.strategistProfileId}
          onClick={() => void run('sugestoes')}
        >
          <Sparkles size={16} /> Pedir sugestões agora
        </Button>
        <Button
          variant="secondary"
          disabled={!settings.strategistProfileId}
          onClick={() => void run('leitura')}
        >
          <Play size={16} /> Ler o Work agora
        </Button>
      </footer>
    </article>
  );
}
