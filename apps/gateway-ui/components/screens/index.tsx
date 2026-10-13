'use client';

import { ArrowLeft, Check, ExternalLink, LayoutTemplate } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { Screen } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, ResourceRow, SectionHeading } from '../ui';

type State = Screen['state'];
type Sheet = NonNullable<Screen['sheet']>;
type Source = Sheet['today'][number]['source'];

const states: State[] = ['listed', 'mapping', 'draft', 'reviewed', 'published'];

export const stateLabel: Record<State, string> = {
  listed: 'Listada',
  mapping: 'Mapeando',
  draft: 'Para revisar',
  reviewed: 'Revisada',
  published: 'Publicada',
};

const stateTone: Record<State, 'neutral' | 'accent' | 'good' | 'warn'> = {
  listed: 'neutral',
  mapping: 'warn',
  draft: 'accent',
  reviewed: 'good',
  published: 'good',
};

const sourceLabel: Record<Source, string> = {
  screen: 'vi na tela',
  code: 'li no código',
  unknown: 'sem fonte',
};

const sections: Array<{ key: keyof Sheet; title: string }> = [
  { key: 'today', title: 'O que existe hoje' },
  { key: 'requirements', title: 'Requisitos inferidos' },
  { key: 'questions', title: 'Dúvidas em aberto' },
  { key: 'problems', title: 'Problemas identificados' },
];

/** The map of the system: every screen listed, the sheet the agent wrote, and the owner's review. */
export function Screens({ api }: SectionProps) {
  const router = useRouter();
  const query = useSearchParams();
  const open = query.get('tela') ?? undefined;
  const [list, setList] = useState<Screen[]>();
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<State | 'all'>('all');

  const load = useCallback(
    () =>
      api
        .screens()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As telas não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const show = (id?: string) => router.replace(id ? `/screens/?tela=${id}` : '/screens/');
  const current = list?.find((item) => item.id === open);

  if (current) return <ScreenSheet screen={current} api={api} back={() => show()} reload={load} />;

  const count = (state: State) => (list ?? []).filter((item) => item.state === state).length;
  const visible = (list ?? []).filter((item) => filter === 'all' || item.state === filter);

  return (
    <>
      <SectionHeading
        title="Telas"
        description="O mapa do sistema: cada tela listada do código e do menu, a ficha que a Atena escreveu ao percorrê-la, e a sua revisão."
      />
      <div className="owner-tabs" role="tablist" aria-label="Filtrar as telas pela situação">
        {(['all', ...states] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={filter === item}
            onClick={() => setFilter(item)}
          >
            {item === 'all'
              ? `Todas (${list?.length ?? 0})`
              : `${stateLabel[item]} (${count(item)})`}
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list && !visible.length ? (
        <Empty title="Nenhuma tela aqui">
          A Atena lista as telas a partir das rotas do código e do menu do sistema; elas aparecem
          aqui.
        </Empty>
      ) : (
        <div className="resource-list">
          {visible.map((item) => (
            <ResourceRow
              key={item.id}
              id={`screen-${item.id}`}
              icon={<LayoutTemplate size={20} strokeWidth={1.6} />}
              name={item.title}
              badges={
                <>
                  <Badge tone={stateTone[item.state]}>{stateLabel[item.state]}</Badge>
                  <Badge dot={false}>{item.application}</Badge>
                </>
              }
              description={item.menuPath || 'Fora do menu'}
              facts={[
                item.route,
                ...(item.squad ? [`Squad proposto: ${item.squad}`] : []),
                ...(item.prints.length ? [`${item.prints.length} prints`] : []),
              ]}
              actions={
                <Button variant="secondary" onClick={() => show(item.id)}>
                  Abrir ficha
                </Button>
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

function ScreenSheet({
  screen,
  api,
  back,
  reload,
}: {
  screen: Screen;
  api: SectionProps['api'];
  back: () => void;
  reload: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const review = async () => {
    setBusy(true);
    try {
      await api.reviewScreen(screen.id);
      await reload();
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não foi possível marcar a revisão.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeading
        title={screen.title}
        description={[screen.menuPath, screen.application].filter(Boolean).join(' · ')}
        action={
          <Button variant="secondary" onClick={back}>
            <ArrowLeft size={16} />
            Todas as telas
          </Button>
        }
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="owner-meta">
        <Badge tone={stateTone[screen.state]}>{stateLabel[screen.state]}</Badge>
        {screen.squad && <Badge dot={false}>Squad proposto: {screen.squad}</Badge>}
        <code>{screen.route}</code>
        {screen.mappedAt && <small>Mapeada em {date(screen.mappedAt)}</small>}
        {screen.reviewedAt && <small>Revisada em {date(screen.reviewedAt)}</small>}
        {screen.workUrl && (
          <a className="text-button" href={screen.workUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Documento no Work
          </a>
        )}
      </div>

      {screen.sheet ? (
        <div className="screen-sheet">
          {sections.map(({ key, title }) => (
            <section key={key} aria-label={title}>
              <h3>{title}</h3>
              {screen.sheet?.[key].length ? (
                <ul>
                  {screen.sheet[key].map((item) => (
                    <li key={item.text}>
                      {item.text}{' '}
                      <Badge dot={false} tone={item.source === 'unknown' ? 'warn' : 'neutral'}>
                        {sourceLabel[item.source]}
                      </Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="note my-0">Nada anotado.</p>
              )}
            </section>
          ))}
        </div>
      ) : (
        <Empty title="Sem ficha ainda">
          A Atena escreve a ficha quando percorre a tela; ela aparece aqui para você revisar.
        </Empty>
      )}

      {screen.prints.length > 0 && (
        <div className="screen-gallery">
          {screen.prints.map((name) => (
            <Print key={name} screenId={screen.id} name={name} api={api} />
          ))}
        </div>
      )}

      {screen.state === 'draft' && (
        <div className="section-row mt-6">
          <p className="text-xs">Leu a ficha e confere com a tela? Marque para seguir.</p>
          <Button busy={busy} disabled={busy} onClick={() => void review()}>
            <Check size={16} /> Marcar como revisada
          </Button>
        </div>
      )}
    </>
  );
}

/** A print travels as base64 in JSON, like a chat attachment, and shows as a data address. */
function Print({
  screenId,
  name,
  api,
}: {
  screenId: string;
  name: string;
  api: SectionProps['api'];
}) {
  const [src, setSrc] = useState('');

  useEffect(() => {
    let live = true;
    api
      .screenPrint(screenId, name)
      .then((print) => {
        if (live) setSrc(`data:${print.contentType};base64,${print.data}`);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, screenId, name]);

  return (
    <figure>
      {src ? (
        // biome-ignore lint/performance/noImgElement: a data URL has nothing for next/image to optimize.
        <img src={src} alt={name} />
      ) : (
        <div className="note">Carregando…</div>
      )}
      <figcaption>{name}</figcaption>
    </figure>
  );
}
