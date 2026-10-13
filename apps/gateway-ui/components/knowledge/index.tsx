'use client';

import { Archive, Check, Pencil, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  KnowledgeFilter,
  KnowledgeProposal,
  KnowledgeRule,
  KnowledgeSettings,
} from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, SectionHeading, Switch } from '../ui';

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
      <KnowledgeSettingsCard api={api} />
      {error && <p className="error">{error}</p>}

      <h3>Propostas esperando você ({waiting.length})</h3>
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

      <h3>Regras</h3>
      <div className="settings-fields">
        <Field label="Busca">
          <input
            value={filter.q ?? ''}
            placeholder="Palavras da regra"
            onChange={(event) => set({ q: event.target.value })}
          />
        </Field>
        <Field label="Aplicação">
          <input
            value={filter.application ?? ''}
            placeholder="ERP, App Gestores"
            onChange={(event) => set({ application: event.target.value })}
          />
        </Field>
        <Field label="Tela">
          <input
            value={filter.screen ?? ''}
            placeholder="Cores de Aparelhos, listagem"
            onChange={(event) => set({ screen: event.target.value })}
          />
        </Field>
        <Field label="Situação">
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

      {decided.length > 0 && (
        <>
          <h3>Últimas propostas decididas</h3>
          <ul>
            {decided.map((proposal) => (
              <li key={proposal.id}>
                #{proposal.number} · {kindLabel[proposal.kind]}{' '}
                {proposal.text ?? proposal.ruleText ?? ''}{' '}
                <Badge tone={proposal.state === 'aplicada' ? 'good' : 'bad'}>
                  {proposal.state === 'aplicada'
                    ? proposal.appliedBy === 'automatico'
                      ? 'Aplicada sozinha'
                      : 'Aplicada'
                    : 'Recusada'}
                </Badge>
              </li>
            ))}
          </ul>
        </>
      )}
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
            {rule.code ? ` (${rule.code})` : ''}{' '}
            <Badge tone={stateTone[rule.state]}>{stateLabel[rule.state]}</Badge>{' '}
            {rule.sensitive && <Badge tone="bad">Sensível</Badge>}
          </h4>
          <small>
            {scopeText(rule.scope)} · fonte {sourceText(rule.source)}
            {rule.replaces ? ` · substitui a #${rule.replaces}` : ''} · {date(rule.updatedAt)}
          </small>
        </div>
      </header>
      {editing ? (
        <div className="settings-fields">
          <Field label="Texto">
            <textarea rows={3} value={text} onChange={(event) => setText(event.target.value)} />
          </Field>
          <Switch
            label="Sensível: faturamento, fiscal, dado de cliente, preço, permissão ou produção"
            checked={sensitive}
            onChange={setSensitive}
          />
          <p className="prototype-buttons">
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
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </p>
        </div>
      ) : (
        <p>{rule.text}</p>
      )}
      {!editing && (
        <footer>
          <p className="prototype-buttons">
            <Button variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
              <Pencil size={16} /> Editar
            </Button>
            {rule.state === 'pendente' && (
              <Button
                disabled={busy}
                onClick={() => void act(() => api.updateKnowledge(rule.id, { state: 'ativa' }))}
              >
                <Check size={16} /> Ativar
              </Button>
            )}
            {rule.state !== 'aposentada' ? (
              <Button
                variant="danger"
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
          </p>
        </footer>
      )}
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
            {proposal.ruleNumber ? ` a regra #${proposal.ruleNumber}` : ''}{' '}
            {proposal.sensitive && <Badge tone="bad">Sensível</Badge>}
          </h4>
          <small>
            {proposal.proposedBy ? `por ${proposal.proposedBy} · ` : ''}
            fonte {sourceText(proposal.source)} · {date(proposal.createdAt)}
          </small>
        </div>
      </header>
      <div className="plan-texts">
        {proposal.ruleText && (
          <div>
            <h5>Hoje</h5>
            <p>{proposal.ruleText}</p>
          </div>
        )}
        {proposal.text && (
          <div>
            <h5>Nova</h5>
            <p>{proposal.text}</p>
          </div>
        )}
      </div>
      {proposal.scope && <p className="note">Escopo: {scopeText(proposal.scope)}</p>}
      <p className="note">Motivo: {proposal.reason}</p>
      <footer className="settings-fields">
        <Field label="Motivo da recusa" hint="Opcional.">
          <input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <p className="prototype-buttons">
          <Button
            busy={busy}
            disabled={busy}
            onClick={() => void act(() => api.approveKnowledgeProposal(proposal.id))}
          >
            <Check size={16} /> Aprovar
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void act(() => api.rejectKnowledgeProposal(proposal.id, reason.trim() || undefined))
            }
          >
            <X size={16} /> Recusar
          </Button>
        </p>
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

  if (!settings) return message ? <p className="error">{message}</p> : null;

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>Curadoria da base</h4>
          <small>
            Só o Curador propõe mudanças; os outros agentes só leem. Sem Curador, a base não aprende
            sozinha.
          </small>
        </div>
      </header>
      <div className="settings-fields">
        <Field label="Curador">
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
        <Switch
          label="Automático: a proposta do Curador entra sem o seu OK"
          checked={settings.automatic}
          onChange={(automatic) => void save({ automatic })}
        />
        <Switch
          label="Sensível sempre pede OK, mesmo no Automático"
          checked={settings.sensitiveAlwaysAsks}
          onChange={(sensitiveAlwaysAsks) => void save({ sensitiveAlwaysAsks })}
        />
      </div>
      {message && <p className="note">{message}</p>}
    </article>
  );
}
