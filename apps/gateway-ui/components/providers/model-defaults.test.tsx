import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SectionProps } from '../props';
import { ModelDefaults } from './model-defaults';

// A saved choice reloads the workspace; here there is none to reload.
vi.mock('../../lib/workspace', () => ({ useWorkspace: () => ({ refresh: async () => {} }) }));

const model = (id: string, output: string[] = ['text']) => ({
  id,
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  reasoningEfforts: [],
  inputModalities: ['text'],
  outputModalities: output,
  known: true,
});

/** Opens one activity's model menu, with every provider below connected. */
async function modelMenu(
  activity: string,
  apiKey: boolean,
  modelDefaults: Record<string, unknown> = {},
  setModelDefaults = vi.fn(),
) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const props = {
    profile: { id: 'profile' },
    data: {
      providers: [
        { id: 'google', name: 'Gemini', kind: 'google' },
        { id: 'anthropic', name: 'Anthropic', kind: 'anthropic' },
        { id: 'codex', name: 'OpenAI', kind: 'openai', authMode: 'codex' },
        ...(apiKey ? [{ id: 'openai', name: 'OpenAI', kind: 'openai', authMode: 'api' }] : []),
      ],
      providerModels: {
        google: { models: [model('gemini-3-pro'), model('gemini-3-pro-image', ['image'])] },
        anthropic: { models: [model('claude-sonnet-5')] },
      },
      modelDefaults,
    },
    api: { setModelDefaults },
    mutate: async () => {},
    busy: false,
  } as unknown as SectionProps;
  await act(async () => root.render(<ModelDefaults {...props} />));
  const card = Array.from(element.querySelectorAll('.model-card')).find(
    (item) => item.querySelector('h2')?.textContent === activity,
  );
  if (!card) throw new Error(`${activity} card missing`);
  expect(
    Array.from(card.querySelectorAll('button')).map((button) => button.textContent?.trim()),
  ).not.toContain('Configure');
  const labels = Array.from(card.querySelectorAll('label'));
  expect(labels.map((item) => item.textContent)).not.toContain('Provider');
  const label = labels.find((item) => item.textContent === 'Model');
  const trigger = document.getElementById(label?.htmlFor ?? '') as HTMLButtonElement | null;
  if (!trigger) throw new Error('Model selector missing');
  await act(async () => trigger.click());
  return {
    element,
    card,
    options: () =>
      Array.from(document.querySelectorAll('[role="option"]')).map((item) => item.textContent),
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

it('lists the models of every connected provider in one menu, each naming its provider', async () => {
  const view = await modelMenu('Conversations & channels', false);
  try {
    expect(view.options()).toEqual(
      expect.arrayContaining(['Automatic', 'gemini-3-proGemini', 'claude-sonnet-5Anthropic']),
    );
    expect(view.options()).not.toContain('gemini-3-pro-imageGemini');
  } finally {
    await view.close();
  }
});

it('keeps a saved channel override visible until changing the shared default updates both', async () => {
  const setModelDefaults = vi.fn().mockResolvedValue({});
  const view = await modelMenu(
    'Conversations & channels',
    false,
    {
      conversation: { providerId: 'google', modelId: 'gemini-3-pro' },
      channel: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
    },
    setModelDefaults,
  );
  try {
    expect(view.element.querySelectorAll('.model-card')).toHaveLength(7);
    expect(view.card.textContent).toContain('A separate channel default is saved');
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((item) =>
      item.textContent?.includes('claude-sonnet-5'),
    ) as HTMLElement;
    await act(async () => option.click());
    await act(async () => {
      view.element
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(setModelDefaults).toHaveBeenCalledWith(
      'profile',
      expect.objectContaining({
        conversation: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
        channel: { providerId: 'anthropic', modelId: 'claude-sonnet-5' },
      }),
    );
    expect(view.card.textContent).not.toContain('A separate channel default is saved');
  } finally {
    await view.close();
  }
});

it('offers image generation only where it works, and explains the missing OpenAI API key', async () => {
  const view = await modelMenu('Image generation', false);
  try {
    expect(view.options()).toEqual([
      'Disabled',
      'Automatic',
      'gemini-3-pro-imageGemini',
      'Type an id…Gemini',
    ]);
    expect(view.element.textContent).toContain('ChatGPT login does not authorize image generation');
  } finally {
    await view.close();
  }
});

it.each([
  ['Sticker analysis', 'sticker'],
  ['Incoming audio', 'audio'],
  ['Text to speech', 'speech'],
  ['Image generation', 'image'],
  ['Image analysis', 'vision'],
])('offers Disabled before Automatic for %s', async (activity, key) => {
  const view = await modelMenu(activity, false, { [key]: 'disabled' });
  try {
    expect(view.options().slice(0, 2)).toEqual(['Disabled', 'Automatic']);
    expect(view.card.textContent).not.toContain('Effort');
  } finally {
    await view.close();
  }
});

it('saves Disabled as a distinct state from Automatic', async () => {
  const setModelDefaults = vi.fn().mockResolvedValue({});
  const view = await modelMenu('Image generation', false, { image: null }, setModelDefaults);
  try {
    const disabled = Array.from(document.querySelectorAll('[role="option"]')).find(
      (item) => item.textContent === 'Disabled',
    ) as HTMLElement;
    await act(async () => disabled.click());
    await act(async () => {
      view.element
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(setModelDefaults).toHaveBeenCalledWith(
      'profile',
      expect.objectContaining({ image: 'disabled' }),
    );
  } finally {
    await view.close();
  }
});

it('offers the configured OpenAI API key for image generation', async () => {
  const view = await modelMenu('Image generation', true);
  try {
    expect(view.options()).toContain('Type an id…OpenAI · API key');
  } finally {
    await view.close();
  }
});

it('shows one incoming audio setting for voice notes and audio files', async () => {
  const view = await modelMenu('Image generation', false);
  try {
    const headings = Array.from(view.element.querySelectorAll('h2')).map(
      (item) => item.textContent,
    );
    expect(headings).toContain('Incoming audio');
    expect(headings).not.toContain('Speech to text');
    expect(headings).not.toContain('Audio analysis');
    expect(headings).toContain('Text to speech');
  } finally {
    await view.close();
  }
});
