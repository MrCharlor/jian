import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { ProfileStats } from '../../lib/api';
import { statsFor } from '../../stories/fixtures';
import { ModelCards, UsageSummary } from './usage';

it('keeps a long model history compact until the owner asks for all of it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const sample = statsFor(30);
  const stats = {
    ...sample,
    models: Array.from({ length: 50 }, (_, index) => ({
      ...sample.models[0],
      modelId: `model-${index}`,
    })),
  } as ProfileStats;
  const element = document.createElement('div');
  const root = createRoot(element);
  await act(async () => root.render(<ModelCards stats={stats} />));

  expect(element.querySelectorAll('.stat-row-card')).toHaveLength(4);
  const toggle = element.querySelector<HTMLButtonElement>('.stat-models-toggle');
  expect(toggle?.textContent).toBe('Show all 50 models');
  await act(async () => toggle?.click());
  expect(element.querySelectorAll('.stat-row-card')).toHaveLength(50);
  expect(element.querySelector('.stat-grid')?.classList.contains('expanded')).toBe(true);

  await act(async () => root.unmount());
});

it('shows progress bars only for providers with available subscription windows', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  const root = createRoot(element);
  await act(async () => root.render(<UsageSummary stats={statsFor(30) as ProfileStats} />));

  expect(element.textContent).toContain('32%');
  expect(element.textContent).toContain('Weekly window');
  expect(element.textContent).not.toContain('5-hour window');
  expect(element.querySelectorAll('.subscription-meter .share-bar')).toHaveLength(1);
  expect(element.querySelector('.subscription-windows.single')).not.toBeNull();
  expect(element.querySelectorAll('.stat-subscriptions .stat-row-card')).toHaveLength(1);
  expect(element.textContent).not.toContain('Unavailable');
  expect(element.textContent).not.toContain('Tools used most');

  const sample = statsFor(30);
  const withClaude = {
    ...sample,
    subscriptions: [
      sample.subscriptions[0],
      {
        provider: 'claude',
        status: 'available',
        fiveHour: { usedPercent: 18, resetsAt: null },
        weekly: { usedPercent: 47, resetsAt: null },
      },
    ],
  } as ProfileStats;
  await act(async () => root.render(<UsageSummary stats={withClaude} />));
  const claude = element.querySelectorAll('.stat-subscriptions .stat-row-card')[1];
  expect(claude?.textContent).toContain('5-hour window');
  expect(claude?.textContent).toContain('Weekly window');
  expect(claude?.querySelectorAll('.subscription-meter .share-bar')).toHaveLength(2);

  const unavailable = {
    ...statsFor(30),
    subscriptions: [{ provider: 'codex', status: 'unavailable', fiveHour: null, weekly: null }],
  } as ProfileStats;
  await act(async () => root.render(<UsageSummary stats={unavailable} />));
  expect(element.querySelector('.stat-subscriptions')).toBeNull();

  await act(async () => root.unmount());
});
