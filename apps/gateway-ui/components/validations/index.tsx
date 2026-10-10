'use client';

import { Check, ExternalLink, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Validation } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, SectionHeading } from '../ui';

type Answer = { result?: 'passou' | 'falhou'; reason: string; taskId: string };

const stateLabel: Record<Validation['state'], string> = {
  aberta: 'Para você validar',
  aprovada: 'Aprovada',
  reprovada: 'Reprovada',
};

/** Epics the tester passed: the owner checks the product, and a failure becomes a return. */
export function Validations({ api }: SectionProps) {
  const [list, setList] = useState<Validation[]>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      api
        .validations()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As validações não carregaram.'),
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
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Não deu certo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Validações"
        description="Épicos que o Tester passou para você. Responda item a item: aprovado vira comentário no épico, e o que falhar vira card de retorno."
        action={
          <Button
            variant="secondary"
            busy={busy}
            onClick={() => void act(() => api.scanValidations())}
          >
            <RefreshCw size={16} /> Olhar o Work agora
          </Button>
        }
      />
      {error && <p className="error">{error}</p>}
      {list && !list.length ? (
        <Empty title="Nada para validar">
          A Atena olha o Work de hora em hora, das 8h às 19h, e traz aqui os épicos com
          stts::awaiting-po.
        </Empty>
      ) : (
        <div className="request-list">
          {list?.map((item) => (
            <ValidationCard key={item.id} validation={item} api={api} act={act} busy={busy} />
          ))}
        </div>
      )}
    </>
  );
}

function ValidationCard({
  validation,
  api,
  act,
  busy,
}: {
  validation: Validation;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const [answers, setAnswers] = useState<Answer[]>(() =>
    validation.items.map(() => ({ reason: '', taskId: validation.tasks[0]?.id ?? '' })),
  );
  const [note, setNote] = useState('');
  const open = validation.state === 'aberta';
  const ready =
    answers.every((answer) => answer.result) &&
    answers.every((answer) => answer.result === 'passou' || answer.reason.trim());

  const set = (index: number, change: Partial<Answer>) =>
    setAnswers(answers.map((answer, at) => (at === index ? { ...answer, ...change } : answer)));

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{validation.number} · {validation.epicTitle}{' '}
            <Badge tone={open ? 'accent' : validation.state === 'aprovada' ? 'good' : 'warn'}>
              {stateLabel[validation.state]}
            </Badge>
          </h4>
          <small>
            {validation.pauta ? `${validation.pauta} · ` : ''}
            {date(validation.createdAt)}
          </small>
        </div>
      </header>
      <p className="prototype-buttons">
        <a href={validation.epicUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> Épico
        </a>
        {validation.previewUrl && (
          <a href={validation.previewUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Preview
          </a>
        )}
        {validation.prototypeUrl && (
          <a href={validation.prototypeUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Protótipo
          </a>
        )}
      </p>

      {validation.notes.length > 0 && (
        <details>
          <summary>O que o Tester e o time escreveram ({validation.notes.length})</summary>
          <ul>
            {validation.notes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <ol className="validation-items">
        {validation.items.map((item, index) => (
          <li key={item.text}>
            <span>{item.text}</span>
            {open ? (
              <span className="validation-answer">
                <Button
                  variant={answers[index]?.result === 'passou' ? 'primary' : 'quiet'}
                  onClick={() => set(index, { result: 'passou' })}
                >
                  <Check size={14} /> Passou
                </Button>
                <Button
                  variant={answers[index]?.result === 'falhou' ? 'danger' : 'quiet'}
                  onClick={() => set(index, { result: 'falhou' })}
                >
                  <X size={14} /> Falhou
                </Button>
                {answers[index]?.result === 'falhou' && (
                  <>
                    <input
                      aria-label={`O que aconteceu no item ${index + 1}`}
                      placeholder="O que aconteceu"
                      value={answers[index]?.reason ?? ''}
                      onChange={(event) => set(index, { reason: event.target.value })}
                    />
                    <select
                      aria-label={`Task original do item ${index + 1}`}
                      value={answers[index]?.taskId ?? ''}
                      onChange={(event) => set(index, { taskId: event.target.value })}
                    >
                      {validation.tasks.map((task) => (
                        <option key={task.id} value={task.id}>
                          {task.title}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </span>
            ) : (
              <Badge tone={item.result === 'falhou' ? 'warn' : 'good'}>
                {item.result === 'falhou' ? `Falhou: ${item.reason ?? ''}` : 'Passou'}
              </Badge>
            )}
          </li>
        ))}
      </ol>

      {open && (
        <footer className="settings-fields">
          <Field label="Observação" hint="Vai no comentário do épico.">
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <Button
            busy={busy}
            disabled={busy || !ready}
            onClick={() =>
              void act(() =>
                api.answerValidation(validation.id, {
                  items: answers.map((answer) => ({
                    result: answer.result ?? 'passou',
                    ...(answer.reason.trim() ? { reason: answer.reason.trim() } : {}),
                    ...(answer.taskId ? { taskId: answer.taskId } : {}),
                  })),
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              )
            }
          >
            <Send size={16} /> Enviar validação
          </Button>
        </footer>
      )}

      {validation.returns.map((draft, index) => (
        <ReturnEditor
          key={`${validation.id}-${draft.item}`}
          validation={validation}
          index={index}
          api={api}
          act={act}
          busy={busy}
        />
      ))}
    </article>
  );
}

function ReturnEditor({
  validation,
  index,
  api,
  act,
  busy,
}: {
  validation: Validation;
  index: number;
  api: SectionProps['api'];
  act: (work: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
}) {
  const draft = validation.returns[index];
  const [title, setTitle] = useState(draft?.title ?? '');
  const [description, setDescription] = useState(draft?.description ?? '');
  const [criteria, setCriteria] = useState(draft?.criteria.join('\n') ?? '');
  const [taskId, setTaskId] = useState(draft?.taskId ?? '');

  if (!draft) return null;

  const patch = {
    title,
    description,
    taskId,
    criteria: criteria.split('\n').filter((line) => line.trim()),
  };

  if (draft.state === 'criado') {
    return (
      <p className="note">
        <Check size={14} /> Card de retorno criado: {draft.title}
      </p>
    );
  }

  return (
    <fieldset className="epic-task">
      <legend>Card de retorno do item {draft.item + 1}</legend>
      {draft.problems.length > 0 && (
        <div className="epic-problems">
          <ul>
            {draft.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.error && <p className="error">{draft.error}</p>}
      <div className="settings-fields">
        <Field label="Título">
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Task original">
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            {validation.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Texto">
          <textarea
            rows={10}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label="Critérios de aceite" hint="Um por linha. O último é o make test.">
          <textarea
            rows={3}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </Field>
      </div>
      <footer className="prototype-buttons">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void act(() => api.updateReturnDraft(validation.id, index, patch))}
        >
          Salvar
        </Button>
        <Button
          busy={busy}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api.updateReturnDraft(validation.id, index, patch);
              await api.createReturnCard(validation.id, index);
            })
          }
        >
          <Check size={16} /> Criar retorno no Work
        </Button>
      </footer>
    </fieldset>
  );
}
