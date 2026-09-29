import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, ProfileData, WorkItem } from '../../lib/api';
import { profiles } from '../../stories/fixtures';
import { WorkBoard } from './board';

const profile = profiles[0];
if (!profile) throw new Error('Missing profile fixture');

it('shows agent work and its read-only activity', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const item: WorkItem = {
    id: '11111111-1111-4111-8111-111111111111',
    profileId: profile.id,
    sourceSessionId: null,
    title: 'Review release',
    description: 'Check the build before publishing.',
    mediaIds: ['55555555-5555-4555-8555-555555555555'],
    status: 'review',
    note: 'Build passed.',
    version: 1,
    updatedBy: 'agent',
    createdAt: '2026-09-29T08:00:00.000Z',
    updatedAt: '2026-09-29T08:00:00.000Z',
  };
  const api = {
    work: vi.fn(async () => [item]),
    workExecutions: vi.fn(async () => [
      {
        runId: '22222222-2222-4222-8222-222222222222',
        sessionId: '33333333-3333-4333-8333-333333333333',
        name: 'Verifier',
        role: 'execute',
        status: 'completed',
        input: 'Check the build.',
        output: 'Build passed.',
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      },
    ]),
    messages: vi.fn(async () => [
      {
        id: '44444444-4444-4444-8444-444444444444',
        profileId: profile.id,
        sessionId: '33333333-3333-4333-8333-333333333333',
        runId: '22222222-2222-4222-8222-222222222222',
        role: 'assistant',
        content: 'Build passed.',
        createdAt: item.updatedAt,
      },
    ]),
    timeline: vi.fn(async () => []),
    media: vi.fn(async () => ({
      id: item.mediaIds[0],
      profileId: profile.id,
      mimeType: 'image/png',
      bytes: 1,
      data: 'AA==',
      createdAt: item.createdAt,
    })),
    workHistory: vi.fn(async () => [
      { id: 1, type: 'work.created', status: 'todo', note: '', createdAt: item.createdAt },
      {
        id: 2,
        type: 'work.updated',
        status: 'review',
        note: 'Build passed.',
        createdAt: item.updatedAt,
      },
    ]),
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <WorkBoard
        profile={profile}
        data={{} as ProfileData}
        api={api}
        mutate={async (action) => {
          await action();
          return true;
        }}
        busy={false}
      />,
    ),
  );

  expect(element.querySelector('[aria-label="In review"] .work-card')?.textContent).toContain(
    'Review release',
  );
  await act(async () => element.querySelector<HTMLButtonElement>('.work-card')?.click());
  expect(api.workHistory).toHaveBeenCalledWith(profile.id, item.id);
  expect(element.querySelector('.work-detail-content h1')?.textContent).toBe('Review release');
  expect(element.querySelector('.work-detail-status[data-status="review"]')?.textContent).toContain(
    'In review',
  );
  expect(element.querySelector('.work-detail-description .mosaic-tile img')).not.toBeNull();
  expect(element.querySelector('.work-activity')?.textContent).toContain('Build passed.');
  expect(element.querySelector('.work-activity')?.textContent).toContain('Verifier');
  expect(element.querySelector('dialog.work-detail-page')).not.toBeNull();
  expect(element.querySelector('select, textarea, .modal-footer')).toBeNull();
  await act(async () => element.querySelector<HTMLButtonElement>('.work-back')?.click());
  expect(element.querySelector('dialog.work-detail-page')?.getAttribute('data-closing')).toBe(
    'true',
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));
  expect(element.querySelector('dialog.work-detail-page')).toBeNull();
  expect(element.querySelector('.work-board')).not.toBeNull();
  await act(async () => root.unmount());
  element.remove();
});
