'use client';

import { Check, ImagePlus, Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Application, Prototype } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, Modal } from '../ui';

const statusLabel: Record<Prototype['versions'][number]['status'], string> = {
  queued: 'Na fila',
  generating: 'Gerando',
  ready: 'Pronta',
  failed: 'Falhou',
};

const statusTone = {
  queued: 'accent',
  generating: 'accent',
  ready: 'good',
  failed: 'bad',
} as const;

/** While a version is being drawn the list is read again, so it turns ready without a reload. */
const POLL_MS = 5000;

type Print = { name: string; contentType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string };

async function readPrint(file: File): Promise<Print | undefined> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return undefined;

  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

  return {
    name: file.name.replace(/[^\w.-]+/g, '-').slice(0, 120),
    contentType: file.type as Print['contentType'],
    data,
  };
}

/**
 * The screens drawn for an application. The owner asks for one, reads each version as it
 * comes, comments for the next, and approves the one that goes to the board.
 */
export function Prototypes({
  application,
  api,
  profileId,
}: {
  application: Application;
  api: SectionProps['api'];
  profileId: string;
}) {
  const [list, setList] = useState<Prototype[]>();
  const [open, setOpen] = useState<string>();
  const [version, setVersion] = useState<number>();
  const [preview, setPreview] = useState<string>();
  const [comments, setComments] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const load = useCallback(
    () =>
      api
        .prototypes(application.slug)
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Os protótipos não carregaram.'),
        ),
    [api, application.slug],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const busy = (list ?? []).some((item) =>
    item.versions.some((entry) => entry.status === 'queued' || entry.status === 'generating'),
  );

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  const current = list?.find((item) => item.id === open);
  const shown =
    current?.versions.find((entry) => entry.number === version) ?? current?.versions.at(-1);

  useEffect(() => {
    setPreview(undefined);
    if (!current || shown?.status !== 'ready') return;

    void api
      .prototypePreview(current.id, shown.number)
      .then((link) => setPreview(link.url))
      .catch(() => setPreview(undefined));
  }, [api, current?.id, shown?.number, shown?.status, current]);

  const act = async (action: () => Promise<unknown>) => {
    setWorking(true);
    try {
      await action();
      await load();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setWorking(false);
    }
  };

  if (current) {
    return (
      <div className="prototype-detail">
        <header className="prototype-head">
          <div>
            <h3>{current.title}</h3>
            <small>
              {current.requestUrl ? (
                <a href={current.requestUrl} target="_blank" rel="noreferrer">
                  Pedido no Work
                </a>
              ) : (
                'Sem pedido ligado'
              )}
              {current.approvedVersion && ` · Versão ${current.approvedVersion} aprovada`}
            </small>
          </div>
          <Button variant="quiet" onClick={() => setOpen(undefined)}>
            Todos os protótipos
          </Button>
        </header>

        <div className="prototype-versions" role="tablist" aria-label="Versões">
          {current.versions.map((entry) => (
            <button
              key={entry.number}
              type="button"
              role="tab"
              aria-selected={entry.number === shown?.number}
              className={entry.number === shown?.number ? 'active' : ''}
              onClick={() => setVersion(entry.number)}
            >
              Versão {entry.number}
              <Badge tone={statusTone[entry.status]}>{statusLabel[entry.status]}</Badge>
              {current.approvedVersion === entry.number && <Badge tone="good">Aprovada</Badge>}
            </button>
          ))}
        </div>

        {shown?.comments && (
          <p className="note">
            <strong>Comentários que pediram esta versão:</strong> {shown.comments}
          </p>
        )}

        {shown?.status === 'ready' ? (
          preview ? (
            <iframe
              title={`${current.title}, versão ${shown.number}`}
              src={preview}
              sandbox="allow-scripts"
              className="prototype-frame"
            />
          ) : (
            <p className="note">Abrindo a tela…</p>
          )
        ) : shown?.status === 'failed' ? (
          <p className="error">A geração falhou: {shown.error}</p>
        ) : (
          <p className="note">
            O Claude Code está desenhando esta versão no servidor. Leva alguns minutos; esta página
            atualiza sozinha.
          </p>
        )}

        {shown?.status === 'ready' && (
          <div className="settings-fields prototype-actions">
            <Field
              label="Comentários para a próxima versão"
              hint="Diga o que muda. A versão atual fica guardada."
            >
              <textarea
                rows={5}
                value={comments}
                onChange={(event) => setComments(event.target.value)}
              />
            </Field>
            <div className="prototype-buttons">
              <Button
                variant="secondary"
                disabled={working || busy || !comments.trim()}
                onClick={() =>
                  void act(async () => {
                    await api.redoPrototype(current.id, comments.trim());
                    setComments('');
                    setVersion(undefined);
                  })
                }
              >
                <RefreshCw size={16} />
                Refazer com os comentários
              </Button>
              <Button
                disabled={working || current.approvedVersion === shown.number}
                onClick={() => void act(() => api.approvePrototype(current.id, shown.number))}
              >
                <Check size={16} />
                Aprovar esta versão
              </Button>
            </div>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="prototype-list">
      <div className="prototype-buttons">
        <Button onClick={() => setCreating(true)} disabled={!application.files}>
          <Plus size={16} />
          Novo protótipo
        </Button>
        {!application.files && <small>Traga o design system antes de prototipar.</small>}
      </div>
      {error && <p className="error">{error}</p>}
      {list && !list.length && <p className="note">Nenhum protótipo ainda.</p>}
      {(list ?? []).map((item) => {
        const last = item.versions.at(-1);

        return (
          <button
            key={item.id}
            type="button"
            className="prototype-row"
            onClick={() => {
              setOpen(item.id);
              setVersion(undefined);
            }}
          >
            <strong>{item.title}</strong>
            <span>
              {last && (
                <Badge
                  tone={statusTone[last.status]}
                >{`Versão ${last.number}: ${statusLabel[last.status]}`}</Badge>
              )}
              {item.approvedVersion && <Badge tone="good">Aprovada a {item.approvedVersion}</Badge>}
            </span>
            <small>
              {item.createdBy === 'agent' ? 'Pedido por um agente' : 'Pedido por você'} ·{' '}
              {date(item.updatedAt)}
            </small>
          </button>
        );
      })}
      {creating && (
        <NewPrototype
          close={() => setCreating(false)}
          create={(input) =>
            act(async () => {
              const created = await api.createPrototype(
                { application: application.slug, ...input },
                profileId,
              );
              setCreating(false);
              setOpen(created.id);
            })
          }
          working={working}
        />
      )}
    </div>
  );
}

function NewPrototype({
  close,
  create,
  working,
}: {
  close: () => void;
  create: (input: {
    title: string;
    brief: string;
    requestUrl?: string;
    prints: Print[];
  }) => Promise<void>;
  working: boolean;
}) {
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [requestUrl, setRequestUrl] = useState('');
  const [prints, setPrints] = useState<Print[]>([]);

  return (
    <Modal
      title="Novo protótipo"
      description="O Claude Code desenha a tela no servidor com o design system desta aplicação e as suas preferências."
      close={close}
      wide
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancelar
          </Button>
          <Button
            disabled={working || !title.trim() || !brief.trim()}
            onClick={() =>
              void create({
                title: title.trim(),
                brief: brief.trim(),
                ...(requestUrl.trim() ? { requestUrl: requestUrl.trim() } : {}),
                prints,
              })
            }
          >
            Desenhar a tela
          </Button>
        </>
      }
    >
      <div className="settings-fields">
        <Field label="Título">
          <input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Pedido no Work" hint="O link do card que originou esta tela.">
          <input
            value={requestUrl}
            type="url"
            onChange={(event) => setRequestUrl(event.target.value)}
          />
        </Field>
        <Field
          label="O que a tela precisa fazer"
          hint="Filtros, colunas, ações, regras. Quanto mais exato, menos rodadas."
        >
          <textarea rows={10} value={brief} onChange={(event) => setBrief(event.target.value)} />
        </Field>
        <Field label="Prints" hint="A tela de hoje ou um rascunho. Até 6 imagens.">
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            onChange={(event) => {
              const files = [...(event.target.files ?? [])].slice(0, 6);
              void Promise.all(files.map(readPrint)).then((read) =>
                setPrints(read.filter((item): item is Print => Boolean(item))),
              );
            }}
          />
        </Field>
        {prints.length > 0 && (
          <p className="note">
            <ImagePlus size={14} /> {prints.map((print) => print.name).join(', ')}
          </p>
        )}
      </div>
    </Modal>
  );
}
