import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Modal } from './modal';

it('animates a dialog out before removing it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const close = () => root.render(null);

  await act(async () =>
    root.render(
      <Modal title="Details" close={close}>
        Content
      </Modal>,
    ),
  );
  await act(async () => element.querySelector<HTMLButtonElement>('[aria-label="Close"]')?.click());
  expect(element.querySelector('dialog')?.getAttribute('data-closing')).toBe('true');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 320)));
  expect(element.querySelector('dialog')).toBeNull();
  await act(async () => root.unmount());
  element.remove();
});
