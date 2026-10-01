'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type {
  GatewayApi,
  Message,
  ToolStep,
  WorkExecution,
  WorkHistory,
  WorkItem,
} from '../../lib/api';
import { useEvents } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { useFollowBottom } from '../sessions/follow-bottom';
import { MessageMedia } from '../sessions/media';
import { ChatMessage } from '../sessions/message';
import { ToolTimeline } from '../sessions/timeline';
import { Button, Empty, SectionHeading, Spinner } from '../ui';
import { useDialogMotion } from '../ui/dialog-motion';
import { Markdown } from '../ui/markdown';

const columns = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'review', label: 'In review' },
  { status: 'blocked', label: 'Blocked' },
  { status: 'done', label: 'Done' },
] as const;

export function WorkBoard({ profile, api }: SectionProps) {
  const subscribe = useEvents();
  const [items, setItems] = useState<WorkItem[]>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<WorkItem>();

  const load = useCallback(
    () =>
      api
        .work(profile.id)
        .then((work) => {
          setItems(work);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Could not load work.'),
        ),
    [api, profile.id],
  );

  useEffect(() => {
    void load();
    return subscribe((event) => {
      if (event.type.startsWith('work.')) void load();
    });
  }, [load, subscribe]);

  return (
    <div className="work-page">
      <div className="work-page-heading">
        <SectionHeading
          title="Work"
          description="Your agent's commitments across chats. Cards never start work on their own."
        />
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!items && error ? (
        <Button variant="secondary" onClick={() => void load()}>
          Try loading again
        </Button>
      ) : !items ? (
        <div className="loading-state" role="status" aria-label="Loading work">
          <Spinner size={32} />
        </div>
      ) : items.length === 0 ? (
        <Empty title="No work yet">
          Ask your agent to track work that should continue beyond this conversation.
        </Empty>
      ) : (
        <div className="work-board-scroll">
          <section className="work-board" aria-label="Agent work board">
            {columns.map((column) => {
              const cards = items.filter((item) => item.status === column.status);
              return (
                <section
                  className="work-column"
                  data-status={column.status}
                  aria-label={column.label}
                  key={column.status}
                >
                  <header>
                    <h2>
                      <span className="work-status-dot" aria-hidden="true" />
                      {column.label}
                    </h2>
                    <span className="work-column-count">{cards.length}</span>
                  </header>
                  <div className="work-column-cards">
                    {cards.map((item) => (
                      <button
                        type="button"
                        className="work-card"
                        key={item.id}
                        onClick={() => setSelected(item)}
                      >
                        <strong>{item.title}</strong>
                        <span className="work-card-description">{item.description}</span>
                        {item.note && <small className="work-card-note">{item.note}</small>}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </section>
        </div>
      )}
      {selected && (
        <WorkDetail
          key={selected.id}
          item={items?.find((item) => item.id === selected.id) ?? selected}
          api={api}
          profileId={profile.id}
          close={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}

function WorkDetail({
  item,
  api,
  profileId,
  close,
}: {
  item: WorkItem;
  api: GatewayApi;
  profileId: string;
  close: () => void;
}) {
  const [history, setHistory] = useState<WorkHistory>();
  const [executions, setExecutions] = useState<WorkExecution[]>([]);
  const [liveSteps, setLiveSteps] = useState(new Map<string, ToolStep[]>());
  const [workerMessages, setWorkerMessages] = useState<
    Array<{ message: Message; worker: WorkExecution; steps?: ToolStep[] }>
  >([]);
  const [error, setError] = useState('');
  const { ref: dialog, closing, requestClose } = useDialogMotion(close);
  const subscribe = useEvents();
  const { scroller, onScroll } = useFollowBottom();

  // The dialog keeps keyboard focus inside it without highlighting a control on open.
  useEffect(() => dialog.current?.focus({ preventScroll: true }), [dialog]);

  useEffect(() => {
    let active = true;
    const load = () =>
      Promise.all([api.workHistory(profileId, item.id), api.workExecutions(profileId, item.id)])
        .then(async ([entries, workers]) => {
          const transcripts = await Promise.all(
            workers.map(async (worker) => {
              const [messages, timelines] = await Promise.all([
                api.messages(profileId, worker.sessionId),
                api.timeline(profileId, worker.sessionId),
              ]);
              const steps = new Map(timelines.map((timeline) => [timeline.runId, timeline.steps]));
              const shown = new Set<string>();
              const transcript = messages.map((message) => {
                const runId = message.runId;
                const firstAnswer = message.role === 'assistant' && runId && !shown.has(runId);
                if (firstAnswer && runId) shown.add(runId);
                return {
                  message,
                  worker,
                  steps: firstAnswer && runId ? steps.get(runId) : undefined,
                };
              });
              return { transcript, steps: steps.get(worker.runId) ?? [] };
            }),
          );
          if (active) {
            setHistory(entries);
            setExecutions(workers);
            setWorkerMessages(transcripts.flatMap((entry) => entry.transcript));
            setLiveSteps(
              new Map(
                workers.map((worker, index) => [worker.runId, transcripts[index]?.steps ?? []]),
              ),
            );
            setError('');
          }
        })
        .catch(() => {
          if (active) setError('Could not load task history.');
        });
    void load();
    const stop = subscribe((event) => {
      if (event.type.startsWith('work.') || event.type.startsWith('run.')) void load();
    });
    return () => {
      active = false;
      stop();
    };
  }, [api, profileId, item.id, subscribe]);

  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className="work-detail-page"
      data-closing={closing}
      aria-label={item.title}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <button type="button" className="work-back" onClick={requestClose}>
        ← Close task
      </button>
      <div className="work-detail-layout">
        <section className="work-detail-content" aria-label="Task details">
          <div className="work-detail-summary">
            <span className="work-detail-status" data-status={item.status}>
              <span className="work-status-dot" aria-hidden="true" />
              {columns.find((column) => column.status === item.status)?.label}
            </span>
            <time dateTime={item.updatedAt}>
              Updated {new Date(item.updatedAt).toLocaleString()}
            </time>
          </div>
          <h1>{item.title}</h1>
          <div className="work-detail-description markdown">
            <Markdown text={item.description} breaks />
            {item.mediaIds?.length ? (
              <MessageMedia
                api={{ media: api.media }}
                profileId={profileId}
                content={item.mediaIds.map((id) => `[Attached media: ${id}]`).join(' ')}
              />
            ) : null}
          </div>
          {item.note && (
            <section className="work-detail-latest">
              <h2>Latest update</h2>
              <div className="markdown">
                <Markdown text={item.note} breaks />
              </div>
            </section>
          )}
          <dl className="work-detail-facts">
            <div>
              <dt>Created</dt>
              <dd>{new Date(item.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Last updated by</dt>
              <dd>{item.updatedBy === 'agent' ? 'Agent' : 'Owner'}</dd>
            </div>
            {item.sourceSessionId && (
              <div>
                <dt>Origin</dt>
                <dd>
                  <Link href={`/sessions?session=${item.sourceSessionId}`}>Open source chat ↗</Link>
                </dd>
              </div>
            )}
            {item.repositories.map((repository) => (
              <div key={repository}>
                <dt>Repository</dt>
                <dd>{repository}</dd>
              </div>
            ))}
          </dl>
        </section>
        <aside className="work-activity" aria-label="Task activity">
          <h2>Activity</h2>
          <section
            ref={scroller}
            className={`message-history${!history && !error ? ' work-activity-loading' : ''}`}
            aria-label="Task activity history"
            onScroll={(event) => onScroll(event.currentTarget)}
          >
            <div className="message-list">
              {!history && !error && (
                <div className="history-loading" role="status" aria-label="Loading task activity">
                  <Spinner size={20} />
                </div>
              )}
              {error && (
                <p role="alert" className="form-error">
                  {error}
                </p>
              )}
              {[
                ...(history ?? []).map((entry) => ({
                  kind: 'event' as const,
                  at: entry.createdAt,
                  entry,
                })),
                ...workerMessages.map((entry) => ({
                  kind: 'message' as const,
                  at: entry.message.createdAt,
                  entry,
                })),
              ]
                .sort((a, b) => a.at.localeCompare(b.at))
                .map((activity) =>
                  activity.kind === 'event' ? (
                    <div className="work-activity-entry" key={`event:${activity.entry.id}`}>
                      <time dateTime={activity.entry.createdAt}>
                        {new Date(activity.entry.createdAt).toLocaleString()}
                      </time>
                      <ChatMessage
                        message={{
                          id: `${item.id}:${activity.entry.id}`,
                          profileId,
                          sessionId: item.sourceSessionId ?? item.id,
                          role: 'assistant',
                          content: [
                            activity.entry.type === 'work.created'
                              ? 'Task created'
                              : `Moved to ${columns.find((column) => column.status === activity.entry.status)?.label}`,
                            activity.entry.note,
                          ]
                            .filter(Boolean)
                            .join('\n\n'),
                          createdAt: activity.entry.createdAt,
                        }}
                        group={false}
                        people={new Map()}
                        opensRun
                      />
                    </div>
                  ) : (
                    <div
                      className="work-activity-entry"
                      key={`message:${activity.entry.message.id}`}
                    >
                      <time dateTime={activity.entry.message.createdAt}>
                        {activity.entry.worker.name} · {activity.entry.worker.role} ·{' '}
                        {new Date(activity.entry.message.createdAt).toLocaleString()}
                      </time>
                      <ChatMessage
                        message={activity.entry.message}
                        group={false}
                        people={new Map()}
                        opensRun
                        before={
                          activity.entry.steps?.length ? (
                            <ToolTimeline steps={activity.entry.steps} />
                          ) : undefined
                        }
                      >
                        <MessageMedia
                          api={{ media: api.media }}
                          profileId={profileId}
                          content={activity.entry.message.content}
                        />
                      </ChatMessage>
                    </div>
                  ),
                )}
              {executions
                .filter((worker) =>
                  ['queued', 'running', 'failed', 'interrupted', 'cancelled'].includes(
                    worker.status,
                  ),
                )
                .map((worker) => (
                  <div className="work-activity-entry" key={`status:${worker.runId}`}>
                    <small>
                      {worker.name} · {worker.role}: {worker.status}
                      {worker.error ? ` — ${worker.error}` : ''}
                    </small>
                    {worker.status === 'running' && (
                      <ToolTimeline steps={liveSteps.get(worker.runId) ?? []} live />
                    )}
                  </div>
                ))}
            </div>
          </section>
        </aside>
      </div>
    </dialog>
  );
}
