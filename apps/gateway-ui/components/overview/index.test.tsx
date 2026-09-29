import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { GatewayApi, ProfileData, ProfileStats } from '../../lib/api';
import { profiles, statsFor } from '../../stories/fixtures';
import { Overview } from '.';

const profile = profiles[0];
if (!profile) throw new Error('Missing profile fixture');

it('waits for stats before showing any overview content', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let resolveStats: (stats: ProfileStats) => void = () => {};
  const api = {
    stats: () => new Promise<ProfileStats>((resolve) => (resolveStats = resolve)),
    activityCalendar: vi.fn(async () => []),
  } as unknown as GatewayApi;
  const element = document.createElement('div');
  const root = createRoot(element);

  await act(async () =>
    root.render(<Overview profile={profile} data={{} as ProfileData} api={api} />),
  );
  expect(element.querySelector('[aria-label="Loading overview"]')).not.toBeNull();
  expect(element.querySelector('.overview-profile')).toBeNull();
  expect(element.querySelector('.heatmap-panel')).toBeNull();
  expect(api.activityCalendar).not.toHaveBeenCalled();

  await act(async () => resolveStats(statsFor(30) as ProfileStats));
  expect(element.querySelector('.overview-profile')).not.toBeNull();
  expect(element.querySelector('.stat-subscriptions')).not.toBeNull();
  expect(element.querySelector('.heatmap-panel')).not.toBeNull();

  await act(async () => root.unmount());
});

it('offers retry if the first stats load fails', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const stats = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(statsFor(30));
  const api = { stats, activityCalendar: async () => [] } as unknown as GatewayApi;
  const element = document.createElement('div');
  const root = createRoot(element);

  await act(async () =>
    root.render(<Overview profile={profile} data={{} as ProfileData} api={api} />),
  );
  expect(element.textContent).toContain('Could not load overview.');
  expect(element.querySelector('.overview-profile')).toBeNull();

  await act(async () => element.querySelector<HTMLButtonElement>('button')?.click());
  expect(stats).toHaveBeenCalledTimes(2);
  expect(element.querySelector('.overview-profile')).not.toBeNull();

  await act(async () => root.unmount());
});
