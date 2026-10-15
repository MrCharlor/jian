'use client';

import { Archive, Check, Library, Pencil, Settings, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  KnowledgeFilter,
  KnowledgeProposal,
  KnowledgeRule,
  KnowledgeSettings,
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
  ResourceRow,
  SectionHeading,
  SwitchField,
} from '../ui';

type Scope = KnowledgeRule['scope'];
type RuleState = KnowledgeRule['state'];

const stateLabel: Record<RuleState, string> = {
  ativa: 'Ativa',
  pendente: 'Pendente',
  aposentada: 'Aposentada',
};

const stateTone: Record<RuleState, 'good' | 'warn' | 'neutral'> = {
  ativa: 'good',
  pendente: 'warn',
  aposentada: 'neutral',
};

const kindLabel: Record<KnowledgeProposal['kind'], string> = {
  incluir: 'Incluir',
  mudar: 'Mudar',
  aposentar: 'Aposentar',
};

const sourceLabel: Record<KnowledgeRule['source']['kind'], string> = {
  inventario: 'inventário',
  plano: 'plano',
  correcao: 'correção',
  decisao: 'decisão',
  validacao: 'validação',
  mencao: 'menção no Work',
  roadmap: 'roadmap',
  manual: 'manual',
};

/** The scope as the owner says it: "toda listagem do ERP", "tela Cores de Aparelhos". */
export function scopeText(scope: Scope) {
  switch (scope.kind) {
    case 'geral':
      return 'Geral';
    case 'aplicacao':
      return `Aplicação ${scope.application}`;
    case 'tipo_de_tela':
      return `Toda ${scope.screen}${scope.application ? ` do ${scope.application}` : ''}`;
    case 'tela':
      return `Tela ${scope.screen}${scope.application ? ` (${scope.application})` : ''}`;
  }
}

const sourceText = (source: KnowledgeRule['source']) =>
  `${sourceLabel[source.kind]}${source.ref ? `: ${source.ref}` : ''}${source.date ? ` (${source.date})` : ''}`;

/**
 * The knowledge base: the rules every agent reads before asking the owner, the Curator's
 * proposals waiting for an OK, and how the base is kept.
 */
export function Knowledge({ api }: SectionProps) {
  const [rules, setRules] = useState<KnowledgeRule[]>();
  const [proposals, setProposals] = useState<KnowledgeProposal[]>([]);
  const [filter, setFilter] = useState<KnowledgeFilter>({ state: 'ativa' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.knowledge(filter), api.knowledgeProposals()])
        .then(([loaded, proposed]) => {
          setRules(loaded);
          setProposals(proposed);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'A base não carregou.'),
        ),
    [api, filter],
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

  const waiting = proposals.filter((item) => item.state === 'aguardando_po');
  const decided = proposals.filter((item) => item.state !== 'aguardando_po').slice(0, 10);
  const set = (patch: Partial<KnowledgeFilter>) => {
    const next: KnowledgeFilter = { ...filter, ...patch };
    for (const key of Object.keys(next) as Array<keyof KnowledgeFilter>) {
      if (!next[key]) delete next[key];
    }
    setFilter(next);
  };

  return (
    <>
      <SectionHeading
        title="Conhecimento"
        description="As regras que todo agente procura antes de perguntar a você, cada uma com o escopo e a fonte. O Curador propõe incluir, mudar ou aposentar a partir das suas respostas."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <section className="row-group" aria-labelledby="knowledge-waiting">
        <h2 id="knowledge-waiting">
          Propostas esperando você <Badge dot={false}>{waiting.length}</Badge>
        </h2>
        {waiting.length ? (
          <div className="request-list">
            {waiting.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} api={api} act={act} busy={busy} />
            ))}
          </div>
        ) : (
          <p className="note">
            Nenhuma. O Curador propõe quando você responde um plano, corrige, decide uma pauta ou
            valida.
          </p>
        )}
      </section>

      <section className="row-group" aria-labelledby="knowledge-rules">
        <h2 id="knowledge-rules">Regras {rules && <Badge dot={false}>{rules.length}</Badge>}</h2>
        <div className="owner-fields knowledge-filters">
          <Field label="Busca" hint="Palavras do texto da regra.">
            <input
              value={filter.q ?? ''}
              placeholder="Ex.: filtro rápido"
              onChange={(event) => set({ q: event.target.value })}
            />
          </Field>
          <Field label="Aplicação" hint="Onde a regra vale.">
            <input
              value={filter.application ?? ''}
              placeholder="Ex.: ERP, App Gestores"
              onChange={(event) => set({ application: event.target.value })}
            />
          </Field>
          <Field label="Tela" hint="A tela, ou o tipo de tela.">
            <input
              value={filter.screen ?? ''}
              placeholder="Ex.: Cores de Aparelhos, listagem"
              onChange={(event) => set({ screen: event.target.value })}
            />
          </Field>
          <Field label="Situação" hint="Ativa é o que os agentes leem.">
            <select
              value={filter.state ?? ''}
              onChange={(event) => set({ state: (event.target.value || undefined) as RuleState })}
            >
              <option value="">Todas</option>
              {(Object.keys(stateLabel) as RuleState[]).map((state) => (
                <option key={state} value={state}>
                  {stateLabel[state]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {rules && !rules.length ? (
          <Empty title="Nenhuma regra">
            Nada com esse filtro. A carga inicial entra pela API (importação em lote).
          </Empty>
        ) : (
          <div className="request-list">
            {rules?.map((rule) => (
              <RuleCard key={rule.id} rule={rule} api={api} act={act} busy={busy} />
            ))}
          </div>
        )}
      </section>

      {decided.length > 0 && (
        <section className="row-group" aria-labelledby="knowledge-decided">
          <h2 id="knowledge-decided">Últimas propostas decididas</h2>
          <div className="resource-list">
            {decided.map((proposal) => (
              <ResourceRow
                key={proposal.id}
                id={`knowledge-proposal-${proposal.id}`}
                icon={<Library size={20} strokeWidth={1.6} />}
                name={`Proposta #${proposal.number} · ${kindLabel[proposal.kind]}`}
                badges={
                  <Badge tone={proposal.state === 'aplicada' ? 'good' : 'bad'}>
                    {proposal.state === 'aplicada'
                      ? proposal.appliedBy === 'automatico'
                        ? 'Aplicada sozinha'
                        : 'Aplicada'
                      : 'Recusada'}
                  </Badge>
                }
                description={proposal.text ?? proposal.ruleText ?? ''}
                facts={[`fonte ${sourceText(proposal.source)}`, date(proposal.createdAt)]}
              />
            ))}
          </div>
        </section>
      )}

      <KnowledgeSettingsCard api={api} />
    </>
  );
}

function RuleCard({
  rule,
  api,
  act,
  busy,
}: {
  rule: KnowledgeRule;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const [sensitive, setSensitive] = useState(rule.sensitive);

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            Regra #{rule.number}
            {rule.code ? ` (${rule.code})` : ''}
            <Badge tone={stateTone[rule.state]}>{stateLabel[rule.state]}</Badge>
            {rule.sensitive && <Badge tone="bad">Sensível</Badge>}
          </h4>
          <small>
            {scopeText(rule.scope)} · fonte {sourceText(rule.source)}
            {rule.replaces ? ` · substitui a #${rule.replaces}` : ''} · {date(rule.updatedAt)}
          </small>
        </div>
      </header>
      <div className="request-body">
        {editing ? (
          <>
            <Field label="Texto da regra" hint="Como os agentes vão ler.">
              <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
            </Field>
            <SwitchField
              label="Sensível"
              hint="Faturamento, fiscal, dado de cliente, preço, permissão ou produção. Mudança nela sempre pede o seu OK."
              checked={sensitive}
              onChange={setSensitive}
            />
          </>
        ) : (
          <MoreText lines={4}>
            <p className="text-sm text-ink">{rule.text}</p>
          </MoreText>
        )}
      </div>
      <footer>
        {editing ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancelar
            </Button>
            <Button
              busy={busy}
              disabled={busy || !text.trim()}
              onClick={() =>
                void act(async () => {
                  await api.updateKnowledge(rule.id, { text: text.trim(), sensitive });
                  setEditing(false);
                })
              }
            >
              <Check size={16} /> Salvar
            </Button>
          </>
        ) : (
          <>
            <Button variant="quiet" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={16} /> Editar
            </Button>
            {rule.state !== 'aposentada' ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void act(() => api.updateKnowledge(rule.id, { state: 'aposentada' }))
                }
              >
                <Archive size={16} /> Aposentar
              </Button>
            ) : (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => void act(() => api.updateKnowledge(rule.id, { state: 'ativa' }))}
              >
                Reativar
              </Button>
            )}
            {rule.state === 'pendente' && (
              <Button
                disabled={busy}
                onClick={() => void act(() => api.updateKnowledge(rule.id, { state: 'ativa' }))}
              >
                <Check size={16} /> Ativar
              </Button>
            )}
          </>
        )}
      </footer>
    </article>
  );
}

function ProposalCard({
  proposal,
  api,
  act,
  busy,
}: {
  proposal: KnowledgeProposal;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [reason, setReason] = useState('');

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            Proposta #{proposal.number} · {kindLabel[proposal.kind]}
            {proposal.ruleNumber ? ` a regra #${proposal.ruleNumber}` : ''}
            {proposal.sensitive && <Badge tone="bad">Sensível</Badge>}
          </h4>
          <small>
            {proposal.proposedBy ? `por ${proposal.proposedBy} · ` : ''}
            fonte {sourceText(proposal.source)} · {date(proposal.createdAt)}
          </small>
        </div>
      </header>
      <div className="request-body">
        <div className="owner-columns">
          {proposal.ruleText && (
            <div>
              <h5>Hoje</h5>
              <MoreText lines={5}>
                <p>{proposal.ruleText}</p>
              </MoreText>
            </div>
          )}
          {proposal.text && (
            <div>
              <h5>{proposal.kind === 'incluir' ? 'Nova regra' : 'Fica assim'}</h5>
              <MoreText lines={5}>
                <p>{proposal.text}</p>
              </MoreText>
            </div>
          )}
        </div>
        <div className="owner-callout">
          <strong>Por que o Curador propõe</strong>
          <MoreText lines={3}>{proposal.reason}</MoreText>
          {proposal.scope && (
            <small className="mt-2 block text-muted">Escopo: {scopeText(proposal.scope)}</small>
          )}
        </div>
        <Field label="Motivo da recusa" hint="Opcional. O Curador lê antes da próxima proposta.">
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
      <footer>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() =>
            void act(() => api.rejectKnowledgeProposal(proposal.id, reason.trim() || undefined))
          }
        >
          <X size={16} /> Recusar
        </Button>
        <Button
          busy={busy}
          disabled={busy}
          onClick={() => void act(() => api.approveKnowledgeProposal(proposal.id))}
        >
          <Check size={16} /> Aprovar
        </Button>
      </footer>
    </article>
  );
}

/** Who keeps the base, and whether the Curator's proposals need the owner's OK. */
function KnowledgeSettingsCard({ api }: Pick<SectionProps, 'api'>) {
  const [settings, setSettings] = useState<KnowledgeSettings>();
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void api
      .knowledgeSettings()
      .then(setSettings)
      .catch(() => setMessage('A configuração não carregou.'));
    void api
      .profiles()
      .then((items) => setProfiles(items.map(({ id, name }) => ({ id, name }))))
      .catch(() => {});
  }, [api]);

  const save = (patch: Parameters<typeof api.updateKnowledgeSettings>[0]) =>
    api
      .updateKnowledgeSettings(patch)
      .then((saved) => {
        setSettings(saved);
        setMessage('Salvo.');
      })
      .catch((failure) => setMessage(failure instanceof Error ? failure.message : 'Não salvou.'));

  return (
    <Disclosure
      title="Configurações"
      hint="Quem cuida da base e se as propostas do Curador pedem o seu OK."
      icon={<Settings size={18} />}
    >
      {settings ? (
        <article className="request-card">
          <header>
            <div className="grow">
              <h4>Curadoria da base</h4>
              <small>
                Só o Curador propõe mudanças; os outros agentes só leem. Sem Curador, a base não
                aprende sozinha.
              </small>
            </div>
          </header>
          <div className="request-body">
            <div className="owner-fields">
              <Field label="Curador" hint="O agente que propõe incluir, mudar ou aposentar regras.">
                <select
                  value={settings.curatorProfileId ?? ''}
                  onChange={(event) => void save({ curatorProfileId: event.target.value || null })}
                >
                  <option value="">Nenhum</option>
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <SwitchField
              label="Automático"
              hint="Ligado: a proposta do Curador entra na base sem o seu OK."
              checked={settings.automatic}
              onChange={(automatic) => void save({ automatic })}
            />
            <SwitchField
              label="Sensível sempre pede OK"
              hint="Regra sensível (faturamento, fiscal, cliente, preço, permissão, produção) espera você, mesmo no Automático."
              checked={settings.sensitiveAlwaysAsks}
              onChange={(sensitiveAlwaysAsks) => void save({ sensitiveAlwaysAsks })}
            />
          </div>
          {message && (
            <footer>
              <p role="status">{message}</p>
            </footer>
          )}
        </article>
      ) : (
        message && (
          <p className="form-error my-0" role="alert">
            {message}
          </p>
        )
      )}
    </Disclosure>
  );
}
