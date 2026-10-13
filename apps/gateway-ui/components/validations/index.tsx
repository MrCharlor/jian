'use client';

import { Check, ExternalLink, Plus, RefreshCw, Send, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Validation } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, MoreText, SectionHeading } from '../ui';

type Answer = { result?: 'passou' | 'falhou'; reason: string; taskId: string };

const stateLabel: Record<Validation['state'], string> = {
  aberta: 'Para você validar',
  aprovada: 'Aprovada',
  reprovada: 'Reprovada',
};

/** The gateway keeps each note of the tester or the team up to this many characters. */
const NOTE_LIMIT = 600;

/** Notes shown before "ver todas". */
const NOTES_SHOWN = 3;

/** What still needs the owner: the items to answer, or a refusal comment to publish. */
const waitsForOwner = (item: Validation) =>
  item.state === 'aberta' ||
  item.comment?.state === 'rascunho' ||
  item.returns.some((draft) => draft.state === 'rascunho');

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

  const waiting = (list ?? []).filter(waitsForOwner);
  const decided = (list ?? []).filter((item) => !waitsForOwner(item));

  return (
    <>
      <SectionHeading
        title="Validações"
        description="Épicos que o Tester passou para você. Responda item a item: aprovado vira comentário no épico; reprovado vira um rascunho de comentário que você publica, e card de retorno só se você pedir."
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
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list && !list.length ? (
        <Empty title="Nada para validar">
          A Atena olha o Work de hora em hora, das 8h às 19h, e traz aqui os épicos com
          stts::awaiting-po.
        </Empty>
      ) : (
        list && (
          <>
            <section className="row-group" aria-labelledby="validations-waiting">
              <h2 id="validations-waiting">
                Esperando você <Badge dot={false}>{waiting.length}</Badge>
              </h2>
              {waiting.length ? (
                <div className="request-list">
                  {waiting.map((item) => (
                    <ValidationCard
                      key={item.id}
                      validation={item}
                      api={api}
                      act={act}
                      busy={busy}
                    />
                  ))}
                </div>
              ) : (
                <p className="note">Nada esperando você agora.</p>
              )}
            </section>
            {decided.length > 0 && (
              <section className="row-group" aria-labelledby="validations-decided">
                <h2 id="validations-decided">
                  Decididas <Badge dot={false}>{decided.length}</Badge>
                </h2>
                <div className="request-list">
                  {decided.map((item) => (
                    <ValidationCard
                      key={item.id}
                      validation={item}
                      api={api}
                      act={act}
                      busy={busy}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )
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
  const answered = answers.filter((answer) => answer.result).length;
  const ready =
    answers.every((answer) => answer.result) &&
    answers.every((answer) => answer.result === 'passou' || answer.reason.trim());
  const canAskReturn = validation.state === 'reprovada' && validation.returns.length === 0;

  const set = (index: number, change: Partial<Answer>) =>
    setAnswers(answers.map((answer, at) => (at === index ? { ...answer, ...change } : answer)));

  return (
    <article className="request-card">
      <header>
        <div className="grow">
          <h4>
            #{validation.number} · {validation.epicTitle}
            <Badge tone={open ? 'accent' : validation.state === 'aprovada' ? 'good' : 'warn'}>
              {stateLabel[validation.state]}
            </Badge>
          </h4>
          <small>
            {validation.pauta ? `Pauta: ${validation.pauta} · ` : ''}
            {date(validation.createdAt)}
          </small>
        </div>
      </header>

      <div className="request-body">
        <nav className="request-links" aria-label={`Links da validação #${validation.number}`}>
          <a className="text-button" href={validation.epicUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Épico no Work
          </a>
          {validation.previewUrl && (
            <a
              className="text-button"
              href={validation.previewUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} /> Preview
            </a>
          )}
          {validation.prototypeUrl && (
            <a
              className="text-button"
              href={validation.prototypeUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} /> Protótipo
            </a>
          )}
        </nav>

        {validation.comment?.state === 'rascunho' && (
          <CommentEditor validation={validation} api={api} act={act} busy={busy} />
        )}

        <div>
          <h5>Pronto quando</h5>
          <ol className="validation-list">
            {validation.items.map((item, index) => (
              <li key={item.text}>
                <p>
                  <b>{index + 1}.</b>
                  {item.text}
                </p>
                {open ? (
                  <ItemAnswer
                    index={index}
                    answer={answers[index]}
                    tasks={validation.tasks}
                    set={(change) => set(index, change)}
                  />
                ) : (
                  <ItemResult item={item} />
                )}
              </li>
            ))}
          </ol>
        </div>

        {validation.notes.length > 0 && <Notes validation={validation} />}

        {validation.comment?.state === 'publicado' && (
          <div className="owner-callout good">
            <strong>
              <Check size={14} /> Comentário publicado no épico
            </strong>
            <MoreText lines={3}>{validation.comment.body}</MoreText>
          </div>
        )}
        {validation.comment?.state === 'descartado' && (
          <p className="note my-0">Comentário descartado; nada foi publicado no épico.</p>
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

        {open && (
          <Field label="Observação" hint="Opcional. Vai junto no comentário do épico.">
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
        )}
      </div>

      {open && (
        <footer>
          <p>
            {ready
              ? 'Tudo respondido.'
              : `${answered} de ${validation.items.length} itens respondidos. Item que falhou precisa do que aconteceu.`}
          </p>
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

      {canAskReturn && (
        <footer>
          <p>Card de retorno é opcional: só se você pedir.</p>
          <Button
            variant="quiet"
            busy={busy}
            disabled={busy}
            onClick={() => void act(() => api.draftValidationReturns(validation.id))}
          >
            <Plus size={16} /> Criar card de retorno
          </Button>
        </footer>
      )}
    </article>
  );
}

/** Passou or Falhou for one item, and what happened when it failed. */
function ItemAnswer({
  index,
  answer,
  tasks,
  set,
}: {
  index: number;
  answer: Answer | undefined;
  tasks: Validation['tasks'];
  set: (change: Partial<Answer>) => void;
}) {
  return (
    <>
      <div className="validation-buttons">
        <Button
          variant={answer?.result === 'passou' ? 'primary' : 'secondary'}
          aria-pressed={answer?.result === 'passou'}
          onClick={() => set({ result: 'passou' })}
        >
          <Check size={14} /> Passou
        </Button>
        <Button
          variant={answer?.result === 'falhou' ? 'danger' : 'secondary'}
          aria-pressed={answer?.result === 'falhou'}
          onClick={() => set({ result: 'falhou' })}
        >
          <X size={14} /> Falhou
        </Button>
      </div>
      {answer?.result === 'falhou' && (
        <div className="owner-fields">
          <Field
            label={`O que aconteceu no item ${index + 1}`}
            hint="Vai no comentário de reprovação."
          >
            <input
              placeholder="Ex.: as colunas voltaram todas ao sair e voltar"
              value={answer.reason}
              onChange={(event) => set({ reason: event.target.value })}
            />
          </Field>
          <Field label="Task original" hint="A task que volta, se você pedir card de retorno.">
            <select value={answer.taskId} onChange={(event) => set({ taskId: event.target.value })}>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
    </>
  );
}

function ItemResult({ item }: { item: Validation['items'][number] }) {
  if (item.result !== 'falhou') {
    return (
      <div>
        <Badge tone={item.result === 'passou' ? 'good' : 'neutral'}>
          {item.result === 'passou' ? 'Passou' : 'Sem resposta'}
        </Badge>
      </div>
    );
  }

  return (
    <div className="owner-callout warn">
      <strong>Falhou</strong>
      {item.reason ? <MoreText lines={3}>{item.reason}</MoreText> : 'Sem motivo escrito.'}
    </div>
  );
}

/** What the tester and the team wrote, newest first; long notes and long lists open on demand. */
function Notes({ validation }: { validation: Validation }) {
  const [all, setAll] = useState(false);
  const shown = all ? validation.notes : validation.notes.slice(0, NOTES_SHOWN);
  const hidden = validation.notes.length - shown.length;

  return (
    <div>
      <h5>O que o Tester e o time escreveram ({validation.notes.length})</h5>
      <ul>
        {shown.map((line) => (
          <li key={line}>
            <MoreText lines={3}>
              {line}
              {line.length >= NOTE_LIMIT && (
                <>
                  {'… '}
                  <a href={validation.epicUrl} target="_blank" rel="noreferrer">
                    continua no Work
                  </a>
                </>
              )}
            </MoreText>
          </li>
        ))}
      </ul>
      {(hidden > 0 || all) && validation.notes.length > NOTES_SHOWN && (
        <button
          type="button"
          className="text-button"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Mostrar só as últimas' : `Ver todas (mais ${hidden})`}
        </button>
      )}
    </div>
  );
}

/** The refusal comment the agent drafted: published as it is, edited first, or dropped. */
function CommentEditor({
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
  const drafted = validation.comment?.body ?? '';
  const [body, setBody] = useState(drafted);

  return (
    <section className="owner-focus" aria-label="Comentário de reprovação">
      <header>
        <h5>Comentário de reprovação (rascunho)</h5>
        <p>Revise e publique no épico. Nada vai para o Work antes de você publicar.</p>
      </header>
      <Field label="Texto do comentário" hint="Marca quem pegou a task e o Lucas.">
        <textarea rows={4} value={body} onChange={(event) => setBody(event.target.value)} />
      </Field>
      <div className="owner-focus-actions">
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => void act(() => api.discardValidationComment(validation.id))}
        >
          <X size={16} /> Descartar
        </Button>
        <Button
          busy={busy}
          disabled={busy || !body.trim()}
          onClick={() =>
            void act(() =>
              api.publishValidationComment(
                validation.id,
                body.trim() === drafted ? undefined : body.trim(),
              ),
            )
          }
        >
          <Send size={16} /> Publicar no épico
        </Button>
      </div>
    </section>
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
      <div className="owner-callout good">
        <strong>
          <Check size={14} /> Card de retorno criado
        </strong>
        {draft.title}
      </div>
    );
  }

  return (
    <section className="owner-block" aria-label={`Card de retorno do item ${draft.item + 1}`}>
      <h5>Card de retorno do item {draft.item + 1} (rascunho)</h5>
      {draft.problems.length > 0 && (
        <div className="owner-callout warn">
          <strong>O que a conferência achou</strong>
          <ul>
            {draft.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {draft.error && (
        <p className="form-error my-0" role="alert">
          {draft.error}
        </p>
      )}
      <div className="owner-fields">
        <Field label="Título" hint="Como o card aparece no board.">
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </Field>
        <Field label="Task original" hint="O card de retorno depende dela.">
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            {validation.tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </Field>
        <div className="wide">
          <Field label="Texto" hint="A descrição do card, com a origem e o que falhou.">
            <textarea
              rows={8}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
        </div>
        <div className="wide">
          <Field label="Critérios de aceite" hint="Um por linha. O último é o make test.">
            <textarea
              rows={3}
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="owner-focus-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void act(() => api.updateReturnDraft(validation.id, index, patch))}
        >
          Salvar rascunho
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
      </div>
    </section>
  );
}
