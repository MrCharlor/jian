import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Run } from '../../lib/api';
import { History } from './history';

let hear: ((event: { type: string }) => void) | undefined;
vi.mock('../../lib/workspace', () => ({
  useWorkspace: () => ({
    subscribe: (listener: () => void) => {
      hear = listener;
      return () => {
        hear = undefined;
      };
    },
  }),
}));

it('centers a spinner while a conversation is loading', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let settle!: (messages: Awaited<ReturnType<GatewayApi['messages']>>) => void;
  const api = {
    messages: () =>
      new Promise<Awaited<ReturnType<GatewayApi['messages']>>>((resolve) => {
        settle = resolve;
      }),
    activities: async () => [],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    expect(element.querySelector('.message-history.loading .history-loading .spin')).not.toBeNull();
    expect(element.textContent).not.toContain('Loading the history');
    await act(async () => settle([]));
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});

it('shows a new run failure when the open session was previously completed', async () => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous: Run = {
    id: 'previous',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'first',
    input: 'First request',
    output: 'Done.',
    status: 'completed',
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:01:00Z',
  };
  let latest = previous;
  const api = {
    messages: async () => [
      {
        id: 'message',
        profileId: 'profile',
        sessionId: 'session',
        runId: latest.id,
        role: 'assistant' as const,
        content: latest.id === previous.id ? 'Done.' : 'Found it.',
        createdAt: latest.createdAt,
      },
    ],
    activities: async () => [previous, latest],
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => {
      root.render(
        <History api={api} profileId="profile" sessionId="session" initialRun={previous} />,
      );
    });
    expect(element.textContent).toContain('Done.');
    expect(element.textContent).not.toContain('Failed');

    latest = {
      ...previous,
      id: 'next',
      status: 'failed',
      output: undefined,
      error: 'The provider ended without a final response.',
      createdAt: '2026-09-22T00:02:00Z',
      updatedAt: '2026-09-22T00:03:00Z',
    };
    await act(async () => {
      hear?.({ type: 'run.failed' });
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(element.textContent).toContain('Found it.');
    expect(element.textContent).toContain('Failed');
    expect(element.textContent).toContain('The provider ended without a final response.');
    expect(element.textContent).not.toContain('Completed');
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.useRealTimers();
  }
});

it('keeps tool history visible when a failed run never wrote an answer', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const failed: Run = {
    id: 'failed-run',
    profileId: 'profile',
    sessionId: 'session',
    requestKey: 'failed',
    input: 'Review the change',
    status: 'failed',
    error: 'The run failed.',
    createdAt: '2026-09-29T17:58:17Z',
    updatedAt: '2026-09-29T17:59:23Z',
  };
  let timelineFails = false;
  const api = {
    messages: async () => [
      {
        id: 'request',
        profileId: 'profile',
        sessionId: 'session',
        runId: failed.id,
        role: 'user' as const,
        content: 'Review the change',
        createdAt: failed.createdAt,
      },
    ],
    activities: async () => [failed],
    timeline: async () => {
      if (timelineFails) throw new Error('Gateway time-out');
      return [
        {
          runId: failed.id,
          steps: [
            {
              toolCallId: 'tool-1',
              toolName: 'read_artifact',
              status: 'done' as const,
              startedAt: '2026-09-29T17:58:18Z',
              finishedAt: '2026-09-29T17:58:19Z',
            },
          ],
        },
      ];
    },
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" />),
    );
    expect(element.textContent).toContain('Review the change');
    expect(element.textContent).toContain('Used 1 tool');
    timelineFails = true;
    await act(async () =>
      root.render(<History api={api} profileId="profile" sessionId="session" revision={1} />),
    );
    expect(element.textContent).toContain('Used 1 tool');
  } finally {
    await act(async () => root.unmount());
    element.remove();
  }
});
