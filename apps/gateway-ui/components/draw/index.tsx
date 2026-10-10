'use client';

import { ExternalLink, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Drawing, Pauta } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, Modal, SectionHeading } from '../ui';

/** The drawing board beside the gateway, and the drawings kept on it, by topic. */
export function Draw({ api }: SectionProps) {
  const [list, setList] = useState<Drawing[]>();
  const [pautas, setPautas] = useState<Pauta[]>([]);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [pauta, setPauta] = useState('');

  const fail = (failure: unknown, fallback: string) =>
    setError(failure instanceof Error ? failure.message : fallback);

  const load = useCallback(
    () =>
      Promise.all([api.drawings(), api.pautas()])
        .then(([drawings, topics]) => {
          setList(drawings);
          setPautas(topics);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Os desenhos não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** The board opens only through a fresh link; a drawing's own address rides inside it. */
  const open = async (url?: string) => {
    // Opened before the request so a phone does not treat the new tab as a pop-up.
    const tab = window.open('', '_blank');

    try {
      const to = url ? new URL(url).hash : '';
      const { url: link } = await api.drawLink(to ? `/${to}` : undefined);
      if (tab) tab.location.href = link;
      else window.location.href = link;
    } catch (failure) {
      tab?.close();
      fail(failure, 'O Excalidraw não abriu.');
    }
  };

  const shown = useMemo(
    () => (list ?? []).filter((item) => !pauta || item.pautaId === pauta),
    [list, pauta],
  );

  return (
    <>
      <SectionHeading
        title="Desenhos"
        description="O Excalidraw da VPS, que só abre por aqui. Os agentes desenham nele e cada desenho fica nesta lista."
        action={
          <span className="prototype-buttons">
            <Button variant="secondary" onClick={() => setAdding(true)}>
              <Plus size={16} />
              Guardar um link
            </Button>
            <Button onClick={() => void open()}>
              <ExternalLink size={16} />
              Abrir o Excalidraw
            </Button>
          </span>
        }
      />
      {error && <p className="error">{error}</p>}
      <div className="board-filters">
        <select aria-label="Pauta" value={pauta} onChange={(event) => setPauta(event.target.value)}>
          <option value="">Todas as pautas</option>
          {pautas.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </div>
      {list && !shown.length ? (
        <Empty title="Nenhum desenho aqui">
          Peça um mapa a um agente, ou guarde o link de um desenho que você fez.
        </Empty>
      ) : (
        <div className="prototype-list">
          {shown.map((item) => (
            <div key={item.id} className="prototype-row">
              <strong>{item.title}</strong>
              <span>
                {item.pauta && <Badge dot={false}>{item.pauta}</Badge>}
                <Badge dot={false}>{item.createdBy ? `Por ${item.createdBy}` : 'Por você'}</Badge>
              </span>
              <small>Atualizado em {date(item.updatedAt)}</small>
              <span>
                <Button variant="secondary" onClick={() => void open(item.url)}>
                  <ExternalLink size={16} />
                  Abrir
                </Button>
                <Button
                  variant="quiet"
                  aria-label={`Tirar ${item.title} da lista`}
                  onClick={() =>
                    void api
                      .removeDrawing(item.id)
                      .then(load)
                      .catch((failure) => fail(failure, 'Não foi possível tirar da lista.'))
                  }
                >
                  <Trash2 size={16} />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <AddDrawing
          pautas={pautas}
          close={() => setAdding(false)}
          save={async (input) => {
            await api.addDrawing(input);
            setAdding(false);
            await load();
          }}
        />
      )}
    </>
  );
}

function AddDrawing({
  pautas,
  close,
  save,
}: {
  pautas: Pauta[];
  close: () => void;
  save: (input: { title: string; url: string; pautaId?: string }) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [pautaId, setPautaId] = useState('');
  const [error, setError] = useState('');

  return (
    <Modal
      title="Guardar um link"
      close={close}
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancelar
          </Button>
          <Button
            disabled={!title.trim() || !url.trim()}
            onClick={() =>
              void save({
                title: title.trim(),
                url: url.trim(),
                ...(pautaId ? { pautaId } : {}),
              }).catch((failure) =>
                setError(failure instanceof Error ? failure.message : 'Não foi possível guardar.'),
              )
            }
          >
            Guardar
          </Button>
        </>
      }
    >
      <div className="settings-fields">
        {error && <p className="error">{error}</p>}
        <Field label="Título">
          <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Link" hint="O link de sala ou de compartilhamento que o Excalidraw mostra.">
          <input value={url} onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label="Pauta">
          <select value={pautaId} onChange={(event) => setPautaId(event.target.value)}>
            <option value="">Nenhuma</option>
            {pautas.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}
