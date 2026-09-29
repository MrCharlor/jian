'use client';

import { Fragment, useEffect, useState } from 'react';
import type { GatewayApi, Person, Run, ToolStep } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import { Badge, Button, Empty, Orb } from '../ui';
import { useFollowBottom } from './follow-bottom';
import { MessageMedia } from './media';
import { authored, ChatMessage } from './message';
import { RunProgress } from './progress';
import { running, statusLabels } from './status';
import { ToolTimeline } from './timeline';

export function History({
  api,
  profileId,
  sessionId,
  initialRun,
  revision = 0,
  empty = 'Messages arriving through the channel show up here.',
  group = false,
}: {
  api: Pick<GatewayApi, 'messages' | 'activities'> &
    Partial<Pick<GatewayApi, 'media' | 'people' | 'timeline' | 'run'>>;
  profileId: string;
  sessionId: string;
  initialRun?: Run;
  /** A change reads the history again at once, as after sending a message. */
  revision?: number;
  empty?: string;
  /** A room: the other side is several people, each shown with their face and name. */
  group?: boolean;
}) {
  const [messages, setMessages] = useState<Awaited<ReturnType<GatewayApi['messages']>>>([]);
  const [people, setPeople] = useState(new Map<string, Person>());
  const [tools, setTools] = useState(new Map<string, ToolStep[]>());
  // In an agent conversation this profile started, the other agent's runs and their tools.
  const [callTools, setCallTools] = useState(new Map<string, ToolStep[]>());
  const [callRun, setCallRun] = useState<Run>();
  // Bumped by an event about this conversation, so it reads again the moment something happens.
  const [heard, setHeard] = useState(0);
  const { subscribe } = useWorkspace();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const stop = subscribe((event) => {
      if (!event.type.startsWith('run.') && !event.type.startsWith('session.')) return;
      const about = (event.data as { sessionId?: string } | undefined)?.sessionId;

      if (about && about !== sessionId) return;
      // Several events arrive together as a turn moves; one read covers them all.
      clearTimeout(timer);
      timer = setTimeout(() => setHeard((value) => value + 1), 150);
    });

    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [subscribe, sessionId]);
  const [run, setRun] = useState(initialRun);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const isRunning = running(run);
  const { scroller, follow, onScroll } = useFollowBottom();

  // Sending is a return to the end, wherever the reader had scrolled.
  useEffect(() => {
    if (revision) follow();
  }, [revision, follow]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and revision explicitly restart the read.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const [history, activities, members, timeline] = await Promise.all([
          api.messages(profileId, sessionId),
          api.activities(profileId),
          group && api.people ? api.people(profileId, sessionId) : [],
          api.timeline ? api.timeline(profileId, sessionId).catch(() => undefined) : undefined,
        ]);
        // The other agent's tools are read where it worked: its own session, in its profile.
        const places = [
          ...new Map(
            history.flatMap((message) =>
              message.call
                ? [[`${message.call.profileId}/${message.call.sessionId}`, message.call]]
                : [],
            ),
          ).values(),
        ];
        const worked =
          api.timeline && places.length
            ? await Promise.all(
                places.map((call) =>
                  api.timeline?.(call.profileId, call.sessionId).catch(() => undefined),
                ),
              )
            : [];
        if (stopped) return;
        if (worked.every((item) => item !== undefined)) {
          setCallTools(new Map(worked.flat().map((item) => [item.runId, item.steps])));
        }
        if (timeline) setTools(new Map(timeline.map((item) => [item.runId, item.steps])));
        setMessages(history);
        setPeople(new Map(members.map((person) => [person.id, person])));
        setRun(
          activities
            .filter((activity) => activity.sessionId === sessionId)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .at(-1),
        );
        setError('');
        // The stream says when to read; this only covers an event lost while it reconnected.
        timer = setTimeout(poll, isRunning ? 10_000 : 30_000);
      } catch (failure) {
        if (!stopped)
          setError(failure instanceof Error ? failure.message : 'The history could not be loaded.');
      } finally {
        if (!stopped) setLoading(false);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, profileId, sessionId, isRunning, retry, revision, group, heard]);

  // The last question this profile carried to another agent, while its answer has not come back.
  const lastCall = messages
    .filter((message) => message.call && message.role === 'assistant')
    .at(-1)?.call;
  const pendingCall =
    lastCall &&
    !messages.some((message) => message.role === 'user' && message.call?.runId === lastCall.runId)
      ? lastCall
      : undefined;

  // The other agent's work reaches this profile's stream only when it ends, so it is followed
  // here while it runs; its end reads the history again, where the answer lands. Keyed by its
  // ids, not by the object, which is new on every read of the history.
  const callKey = pendingCall
    ? `${pendingCall.profileId} ${pendingCall.sessionId} ${pendingCall.runId}`
    : '';

  useEffect(() => {
    const [callProfile, callSession, callRunId] = callKey.split(' ');
    if (!callProfile || !callSession || !callRunId || !api.run) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const follow = async () => {
      const [current, steps] = await Promise.all([
        api.run?.(callProfile, callRunId).catch(() => undefined),
        api.timeline?.(callProfile, callSession).catch(() => []) ?? [],
      ]);

      if (stopped) return;
      setCallRun(current);
      setCallTools(
        (known) => new Map([...known, ...steps.map((item) => [item.runId, item.steps] as const)]),
      );

      if (running(current)) {
        timer = setTimeout(follow, 1500);
      } else {
        setHeard((value) => value + 1);
      }
    };

    void follow();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, callKey]);

  return (
    <div className="session-history">
      <section
        ref={scroller}
        className={`message-history ${loading ? 'loading' : ''}`}
        aria-label="Session history"
        aria-busy={loading}
        onScroll={(event) => {
          onScroll(event.currentTarget);
        }}
      >
        <div className="message-list">
          {loading ? (
            <div className="history-loading" role="status" aria-label="Loading conversation">
              <Orb size={64} />
            </div>
          ) : messages.length ? (
            messages.map((message, index) => {
              const previous = messages[index - 1];
              // Who answers: the agent, or — on a question this profile carried to another
              // agent — that agent, whose run is kept in its own profile.
              const answers = (item: typeof message) =>
                item.call ? item.role === 'user' : item.role === 'assistant';
              const turn = (item: typeof message) => item.call?.runId ?? item.runId;
              // The tools of a turn go above the first thing said in answer to it.
              const opensAnswer =
                answers(message) &&
                !messages
                  .slice(0, index)
                  .some((item) => answers(item) && turn(item) === turn(message));
              const answering = turn(message);
              const steps =
                opensAnswer && answering
                  ? (message.call ? callTools : tools).get(answering)
                  : undefined;
              const unansweredSteps =
                message.role === 'user' &&
                !message.call &&
                message.runId &&
                !(run?.id === message.runId && isRunning) &&
                !messages.some(
                  (item) => item.role === 'assistant' && item.runId === message.runId,
                ) &&
                !messages
                  .slice(index + 1)
                  .some((item) => item.role === 'user' && item.runId === message.runId)
                  ? tools.get(message.runId)
                  : undefined;
              const who = (item: typeof message) =>
                answers(item) ? 'agent' : (authored(item).id ?? authored(item).name ?? '');

              return (
                <Fragment key={message.id}>
                  <ChatMessage
                    message={message}
                    group={group}
                    people={people}
                    opensRun={!previous || who(previous) !== who(message)}
                    before={steps && <ToolTimeline steps={steps} />}
                  >
                    {api.media && (
                      <MessageMedia
                        api={{ media: api.media }}
                        profileId={profileId}
                        content={message.content}
                      />
                    )}
                  </ChatMessage>
                  {unansweredSteps && (
                    <div className="chat-line theirs">
                      <ToolTimeline steps={unansweredSteps} />
                    </div>
                  )}
                </Fragment>
              );
            })
          ) : (
            !error && <Empty title="No messages in this session">{empty}</Empty>
          )}
          {!loading && pendingCall && callRun && running(callRun) && (
            <RunProgress
              run={callRun}
              toolShown={Boolean(
                callTools.get(callRun.id)?.some((step) => step.status === 'running'),
              )}
            >
              <ToolTimeline steps={callTools.get(callRun.id) ?? []} live />
            </RunProgress>
          )}
          {!loading && run && isRunning && (
            <RunProgress
              run={run}
              toolShown={Boolean(tools.get(run.id)?.some((step) => step.status === 'running'))}
            >
              <ToolTimeline steps={tools.get(run.id) ?? []} live />
            </RunProgress>
          )}
        </div>
      </section>
      {error && (
        <div className="history-error" role="alert">
          <p>{error}</p>
          <Button
            variant="secondary"
            onClick={() => {
              setLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      )}
      {/* The dots already say the agent is working; the bar speaks only when a turn went wrong. */}
      {run && ['failed', 'interrupted', 'cancelled'].includes(run.status) && (
        <div className="run-status">
          <Badge tone={run.status === 'cancelled' ? 'neutral' : 'bad'}>
            {statusLabels[run.status]}
          </Badge>
          {run.error && <p className="text-bad">{run.error}</p>}
        </div>
      )}
    </div>
  );
}
