'use client';

import { ExternalLink, LogIn, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Pipeline, PipelineSettings } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, SectionHeading, SwitchField } from '../ui';

const stageLabel: Record<Pipeline['stage'], string> = {
  fora: 'De fora (já estava em Priorizado)',
  fila: 'Na fila',
  pauta: 'Pauta e cadeia',
  prototipo: 'Protótipo',
  epico: 'Escrevendo o épico',
  aguardando_epico: 'Épico esperando você',
  criado: 'Épico criado',
  parado: 'Parado',
  falhou: 'Falhou',
};

const stageTone: Record<Pipeline['stage'], 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  fora: 'neutral',
  fila: 'neutral',
  pauta: 'accent',
  prototipo: 'accent',
  epico: 'accent',
  aguardando_epico: 'warn',
  criado: 'good',
  parado: 'bad',
  falhou: 'bad',
};

const ACTIVE = new Set<Pipeline['stage']>([
  'fila',
  'pauta',
  'prototipo',
  'epico',
  'aguardando_epico',
]);

/**
 * The requests walking from Priorizado to an epic (B23): what stage each is in and why it
 * stopped. The gates themselves are answered in Esperando você.
 */
export function Requests({ api }: SectionProps) {
  const [list, setList] = useState<Pipeline[]>();
  const [settings, setSettings] = useState<PipelineSettings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      Promise.all([api.pipelines(), api.pipelineSettings()])
        .then(([items, saved]) => {
          setList(items);
          setSettings(saved);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Os pedidos não carregaram.'),
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
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  const active = (list ?? []).filter((item) => ACTIVE.has(item.stage));
  const rest = (list ?? []).filter((item) => !ACTIVE.has(item.stage));

  return (
    <>
      <SectionHeading
        title="Pedidos → épico"
        description="Pedido que entra em Priorizado vira épico sozinho: pauta, protótipo (se tiver tela) e rascunho. Você só decide nos portões, em Esperando você."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {settings && (
        <SwitchField
          label="Cadeia ligada"
          hint={`Até ${settings.maxActive} pedidos andando ao mesmo tempo. Ao ligar, os que já estão em Priorizado ficam de fora até você mandar entrar.`}
          checked={settings.enabled}
          disabled={busy}
          onChange={(enabled) => void act(() => api.updatePipelineSettings({ enabled }))}
        />
      )}
      {list && !list.length ? (
        <Empty title="Nenhum pedido na cadeia">
          Quando um pedido entrar em Priorizado com a cadeia ligada, ele aparece aqui.
        </Empty>
      ) : (
        list &&
        [
          { id: 'active', title: 'Andando', items: active },
          { id: 'rest', title: 'Criados, parados e de fora', items: rest },
        ].map((group) =>
          group.items.length ? (
            <section key={group.id} className="row-group" aria-labelledby={`requests-${group.id}`}>
              <h2 id={`requests-${group.id}`}>
                {group.title} <Badge dot={false}>{group.items.length}</Badge>
              </h2>
              <div className="request-list">
                {group.items.map((item) => (
                  <article key={item.id} className="request-card">
                    <header>
                      <div className="grow">
                        <h4>
                          #{item.number} · {item.requestTitle}
                          <Badge tone={stageTone[item.stage]}>{stageLabel[item.stage]}</Badge>
                        </h4>
                        <small>
                          {[
                            item.pautaTitle && `Pauta: ${item.pautaTitle}`,
                            `desde ${date(item.createdAt)}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </div>
                    </header>
                    <div className="request-body">
                      {item.requestUrl && (
                        <nav
                          className="request-links"
                          aria-label={`Links do pedido #${item.number}`}
                        >
                          <a
                            className="text-button"
                            href={item.requestUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={14} /> Pedido no Work
                          </a>
                        </nav>
                      )}
                      {item.note && <p className="note my-0">{item.note}</p>}
                    </div>
                    {item.stage !== 'criado' && item.stage !== 'falhou' && (
                      <footer>
                        <p />
                        {ACTIVE.has(item.stage) ? (
                          <Button
                            variant="quiet"
                            disabled={busy}
                            onClick={() => void act(() => api.stopPipeline(item.id))}
                          >
                            <Square size={16} /> Parar
                          </Button>
                        ) : (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void act(() => api.enterPipeline(item.id))}
                          >
                            <LogIn size={16} /> Entrar na cadeia
                          </Button>
                        )}
                      </footer>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ) : null,
        )
      )}
    </>
  );
}
