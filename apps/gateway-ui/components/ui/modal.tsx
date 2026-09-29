'use client';

import { X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from './button';
import { useDialogMotion } from './dialog-motion';
import { Field } from './field';

/**
 * A native dialog: Escape and the backdrop are the browser's, so close() is the only exit.
 * Only the content scrolls: the header above it and the `footer` below it stay put, so the
 * actions are always in reach. A form's submit button in the footer names the form with `form`,
 * since the footer sits outside it.
 */
export function Modal({
  title,
  description,
  children,
  close,
  footer,
  wide = false,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  close: () => void;
  /** The dialog's actions, kept below the scrolling content. */
  footer?: ReactNode;
  /** Room for reading, as a document shown whole needs. */
  wide?: boolean;
}) {
  const { ref, closing, requestClose } = useDialogMotion(close);
  const heading = useId();

  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      data-closing={closing}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
    >
      <header>
        <div>
          <h2 id={heading}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" type="button" aria-label="Close" onClick={requestClose}>
          <X size={20} />
        </button>
      </header>
      {children && <div className="modal-body">{children}</div>}
      {footer && <footer className="modal-footer">{footer}</footer>}
    </dialog>
  );
}

export function Confirm({
  title,
  description,
  confirm,
  close,
  busy,
  phrase,
}: {
  title: string;
  description: string;
  confirm: () => void;
  close: () => void;
  busy?: boolean;
  /** For what cannot be undone: confirming waits until this is typed exactly. */
  phrase?: string;
}) {
  const [typed, setTyped] = useState('');
  const matches = !phrase || typed.trim() === phrase;

  return (
    <Modal
      title={title}
      description={description}
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} disabled={!matches} onClick={confirm}>
            Confirm
          </Button>
        </>
      }
    >
      {phrase && (
        <Field label={`Type ${phrase} to confirm`}>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one answer.
            autoFocus
          />
        </Field>
      )}
    </Modal>
  );
}
