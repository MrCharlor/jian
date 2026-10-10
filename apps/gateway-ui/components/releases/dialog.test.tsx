import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const seen = vi.fn(async () => ({ version: '2.2.0', notes: [], unseen: [] }));
const note = {
  version: '2.2.0',
  date: '2026-09-24',
  summary: 'Agents search the web.',
  body: '## Web\n\n- **Search** with `web_search`\n- Read [pages](https://example.com)\n\n<img src=x onerror=alert(1)>',
  prerelease: false,
};

const older = {
  version: '2.1.0',
  date: '2026-09-23',
  summary: 'Precise code edits.',
  body: '- **agent:** edit code precisely',
  prerelease: false,
};

vi.mock('../../lib/api', () => ({
  gatewayApi: () => ({
    releases: async () => ({ version: '2.2.0', notes: [note, older], unseen: [note] }),
    markReleasesSeen: seen,
  }),
}));

it('shows what changed once, as text, and marks it read on close', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // happy-dom has no modal dialogs; the component only needs the calls to exist.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };

  const { ReleaseNotes } = await import('./dialog');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () => {
      root.render(<ReleaseNotes />);
    });

    expect(element.querySelector('h2')?.textContent).toBe("What's new in Atena 2.2.0");
    expect(element.textContent).toContain('Agents search the web.');
    expect(element.querySelector('li strong')?.textContent).toBe('Search');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    // Markup in a note is shown as text, never run.
    expect(element.querySelector('img')).toBeNull();

    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === 'Got it',
    );

    await act(async () => {
      button?.click();
    });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(element.querySelector('dialog')).toBeNull();
  } finally {
    act(() => root.unmount());
    element.remove();
  }
});

it('opens every release on request, newest first, and marks nothing read', async () => {
  const { ReleaseNotes, useReleaseNotes } = await import('./dialog');
  function Open() {
    const open = useReleaseNotes();

    return (
      <button type="button" onClick={open}>
        Release notes
      </button>
    );
  }
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const button = (text: string) =>
    [...element.querySelectorAll('button')].find((item) => item.textContent === text);

  seen.mockClear();

  try {
    await act(async () => {
      root.render(
        <ReleaseNotes>
          <Open />
        </ReleaseNotes>,
      );
    });
    // The update dialog comes first; reading it is what the history is opened after.
    await act(async () => button('Got it')?.click());
    seen.mockClear();

    await act(async () => button('Release notes')?.click());

    expect(element.querySelector('h2')?.textContent).toBe('Release notes');
    expect(
      [...element.querySelectorAll('.release-notes h2')].map((item) => item.textContent),
    ).toEqual([expect.stringContaining('2.2.0'), expect.stringContaining('2.1.0')]);

    await act(async () => button('Close')?.click());

    expect(seen).not.toHaveBeenCalled();
    expect(element.querySelector('dialog')).toBeNull();
  } finally {
    act(() => root.unmount());
    element.remove();
  }
});
