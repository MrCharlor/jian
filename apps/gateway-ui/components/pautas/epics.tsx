'use client';

import { Check, ExternalLink, ImagePlus, Plus, Save, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { EpicDraft, EpicDraftPatch } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, Modal } from '../ui';

type Task = EpicDraft['tasks'][number];
type Image = NonNullable<EpicDraftPatch['addImages']>[number];

const LABELS: Task['label'][] = ['feature', 'bugfix', 'refactor', 'style', 'docs', 'hotfix'];

const stateLabel: Record<EpicDraft['state'], string> = {
  rascunho: 'Rascunho',
  criado: 'Criado no Work',
  descartado: 'Descartado',
};

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** The topic's epics: the agent drafts, the owner edits and creates them on the board. */
export function EpicDrafts({ api, pautaId }: { api: SectionProps['api']; pautaId: string }) {
  const [drafts, setDrafts] = useState<EpicDraft[]>();
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api
        .epicDrafts(pautaId)
        .then((list) => {
          setDrafts(list);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Os épicos não carregaram.'),
        ),
    [api, pautaId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h3>Épico</h3>
      {error && <p className="error">{error}</p>}
      {drafts && !drafts.length && (
        <p className="note">
          Nenhum rascunho ainda. Peça ao Subaru: "escreve o épico desta pauta".
        </p>
      )}
      <div className="request-list">
        {drafts?.map((draft) =>
          draft.state === 'rascunho' ? (
            <DraftEditor key={draft.id} api={api} draft={draft} reload={load} />
          ) : (
            <article className="request-card" key={draft.id}>
              <header>
                <div className="grow">
                  <h4>
                    #{draft.number} · {draft.title}{' '}
                    <Badge tone={draft.state === 'criado' ? 'good' : 'neutral'}>
                      {stateLabel[draft.state]}
                    </Badge>
                  </h4>
                  <small>
                    {draft.tasks.length} task{draft.tasks.length === 1 ? '' : 's'}
                    {draft.proposedBy ? ` · escrito por ${draft.proposedBy}` : ''}
                  </small>
                </div>
                <time dateTime={draft.updatedAt}>{date(draft.updatedAt)}</time>
              </header>
              {draft.work.epicUrl && (
                <a href={draft.work.epicUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> Abrir o épico no Work
                </a>
              )}
            </article>
          ),
        )}
      </div>
    </section>
  );
}

function DraftEditor({
  api,
  draft,
  reload,
}: {
  api: SectionProps['api'];
  draft: EpicDraft;
  reload: () => Promise<void>;
}) {
  const [title, setTitle] = useState(draft.title);
  const [label, setLabel] = useState(draft.label);
  const [description, setDescription] = useState(draft.description);
  const [requestWorkId, setRequestWorkId] = useState(draft.requestWorkId ?? '');
  const [prototypeUrl, setPrototypeUrl] = useState(draft.prototypeUrl ?? '');
  const [tasks, setTasks] = useState<Task[]>(draft.tasks);
  // Stable keys for the task forms, so removing one does not move another's text.
  const [keys, setKeys] = useState(() => draft.tasks.map(() => crypto.randomUUID()));
  const [images, setImages] = useState<Image[]>();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(draft.error ?? '');

  const patch = (): EpicDraftPatch => ({
    title,
    label,
    description,
    tasks,
    ...(requestWorkId.trim() ? { requestWorkId: requestWorkId.trim() } : {}),
    ...(prototypeUrl.trim() ? { prototypeUrl: prototypeUrl.trim() } : {}),
    ...(images?.length ? { addImages: images } : {}),
  });

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      setImages(undefined);
      await reload();
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  const setTask = (index: number, change: Partial<Task>) =>
    setTasks(tasks.map((task, at) => (at === index ? { ...task, ...change } : task)));

  const addImage = async (file: File, task?: number) => {
    const contentType = file.type as Image['contentType'];

    if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) {
      setError('Só PNG, JPEG ou WebP.');
      return;
    }

    const caption = window.prompt('Legenda do print (o que ele mostra):', file.name);

    if (!caption) return;

    setImages([
      ...(images ?? []),
      {
        name: file.name,
        caption,
        contentType,
        data: await readFile(file),
        ...(task === undefined ? {} : { task }),
      },
    ]);
  };

  return (
    <article className="request-card epic-draft">
      <header>
        <div className="grow">
          <h4>
            Rascunho #{draft.number} <Badge tone="accent">Para você revisar</Badge>
          </h4>
          <small>
            {draft.proposedBy ? `Escrito por ${draft.proposedBy} · ` : ''}
            {date(draft.updatedAt)}
          </small>
        </div>
      </header>

      {draft.problems.length > 0 && (
        <div className="epic-problems">
          <strong>A Atena achou {draft.problems.length} problema(s):</strong>
          <ul>
            {draft.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <div className="settings-fields">
        <Field label="Título do épico">
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Etiqueta">
          <select value={label} onChange={(event) => setLabel(event.target.value as Task['label'])}>
            {LABELS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </Field>
        <Field label="Pedido na Entrada" hint="Id do card; ele passa a depender do épico.">
          <input value={requestWorkId} onChange={(event) => setRequestWorkId(event.target.value)} />
        </Field>
        <Field label="Protótipo" hint="Link do Claude Design; compartilhe com o time pelo Share.">
          <input value={prototypeUrl} onChange={(event) => setPrototypeUrl(event.target.value)} />
        </Field>
        <Field label="Texto do épico">
          <textarea
            rows={14}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <label className="epic-image">
          <ImagePlus size={16} /> Print no épico
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void addImage(file);
            }}
          />
        </label>
      </div>

      {tasks.map((task, index) => (
        <fieldset className="epic-task" key={keys[index]}>
          <legend>
            Task {index + 1}
            <Button
              variant="quiet"
              aria-label={`Tirar a task ${index + 1}`}
              onClick={() => {
                setTasks(tasks.filter((_, at) => at !== index));
                setKeys(keys.filter((_, at) => at !== index));
              }}
            >
              <Trash2 size={14} />
            </Button>
          </legend>
          <div className="settings-fields">
            <Field label="Título">
              <input
                value={task.title}
                onChange={(event) => setTask(index, { title: event.target.value })}
              />
            </Field>
            <Field label="Etiqueta">
              <select
                value={task.label}
                onChange={(event) => setTask(index, { label: event.target.value as Task['label'] })}
              >
                {LABELS.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </Field>
            <Field label="Texto">
              <textarea
                rows={10}
                value={task.description}
                onChange={(event) => setTask(index, { description: event.target.value })}
              />
            </Field>
            <Field label="Critérios de aceite" hint="Um por linha. O último é o make test.">
              <textarea
                rows={5}
                value={task.criteria.join('\n')}
                onChange={(event) =>
                  setTask(index, {
                    criteria: event.target.value.split('\n').filter((line) => line.trim()),
                  })
                }
              />
            </Field>
            <label className="epic-image">
              <ImagePlus size={16} /> Print nesta task
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void addImage(file, index);
                }}
              />
            </label>
          </div>
        </fieldset>
      ))}

      <Button
        variant="quiet"
        onClick={() => {
          setKeys([...keys, crypto.randomUUID()]);
          setTasks([
            ...tasks,
            {
              title: '',
              label: 'feature',
              description:
                '## Contexto\n\n## Hoje\n\n## Regras de negócio\n\n## Referências técnicas\n',
              criteria: ['make test-web passa'],
            },
          ]);
        }}
      >
        <Plus size={16} /> Nova task
      </Button>

      {[...draft.images, ...(images ?? [])].length > 0 && (
        <ul className="note">
          {[...draft.images, ...(images ?? [])].map((image) => (
            <li key={`${image.name}-${image.caption}`}>
              Print "{image.caption}" ·{' '}
              {image.task === undefined ? 'no épico' : `na task ${image.task + 1}`}
            </li>
          ))}
        </ul>
      )}

      <footer className="prototype-buttons">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => void act(() => api.discardEpicDraft(draft.id))}
        >
          <X size={16} /> Descartar
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void act(() => api.updateEpicDraft(draft.id, patch()))}
        >
          <Save size={16} /> Salvar
        </Button>
        <Button busy={busy} disabled={busy} onClick={() => setConfirming(true)}>
          <Check size={16} /> Criar no Work
        </Button>
      </footer>

      {confirming && (
        <Modal
          title="Criar no Work"
          close={() => setConfirming(false)}
          footer={
            <>
              <Button variant="quiet" onClick={() => setConfirming(false)}>
                Voltar
              </Button>
              <Button
                busy={busy}
                onClick={() =>
                  void act(async () => {
                    await api.updateEpicDraft(draft.id, patch());
                    await api.createEpicOnBoard(draft.id);
                    setConfirming(false);
                  })
                }
              >
                Criar épico e {tasks.length} task{tasks.length === 1 ? '' : 's'}
              </Button>
            </>
          }
        >
          <p>
            O épico e as tasks vão para o board Epics, em A fazer, com Equipe Sigma e Solicitante
            3433. O pedido da Entrada passa a depender do épico e o Lucas recebe um comentário para
            assumir.
          </p>
          {draft.problems.length > 0 && (
            <p className="error">
              Ainda há {draft.problems.length} problema(s) apontado(s). Salve para conferir de novo.
            </p>
          )}
        </Modal>
      )}
    </article>
  );
}
