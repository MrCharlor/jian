import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, Run } from '../../lib/api';
import { History } from './history';

// No stream here: the history falls back to reading again on its own.
vi.mock('../../lib/workspace', () => ({ useWorkspace: () => ({ subscribe: () => () => {} }) }));

it('centers the standard orb while a conversation is loading', async () => {
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
    expect(element.querySelector('.message-history.loading .history-loading .orb')).not.toBeNull();
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
      await vi.advanceTimersByTimeAsync(30_000);
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
