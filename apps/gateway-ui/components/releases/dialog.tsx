'use client';

import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { type GatewayApi, gatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import { Button } from '../ui';
import { Markdown } from '../ui/markdown';
import { Modal } from '../ui/modal';

type Releases = Awaited<ReturnType<GatewayApi['releases']>>;

/**
 * How the sidebar opens the notes on purpose. A context, because the dialog belongs to the
 * shell — it opens over any page — and the link that asks for it is in the sidebar.
 */
const ReleaseNotesContext = createContext<() => void>(() => {});
const ReleaseUpdateContext = createContext({ behind: 0 });

export const useReleaseNotes = () => useContext(ReleaseNotesContext);
export const useReleaseUpdate = () => useContext(ReleaseUpdateContext);

/**
 * Opens once after an update with what changed, and again whenever the owner asks. Closing the
 * first is the owner saying they read it, and the gateway keeps that mark, so the same notes do
 * not open again on another browser. Opened on purpose it is the history, every release this
 * installation ran up to now — the gateway leaves out candidates on a stable version — and
 * reading it again marks nothing.
 */
export function ReleaseNotes({ children }: { children?: ReactNode }) {
  const [releases, setReleases] = useState<Releases>();
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let active = true;

    // A panel that cannot say what changed still works; the dialog is the only thing lost.
    void gatewayApi()
      .releases()
      .then((state) => {
        if (active) setReleases(state);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  const show = useCallback(() => setAsked(true), []);

  const close = () => {
    if (asked) {
      setAsked(false);
      return;
    }

    setReleases((state) => (state ? { ...state, unseen: [] } : state));
    void gatewayApi()
      .markReleasesSeen()
      .catch(() => {});
  };

  const behind = releases?.behind ?? 0;
  const shown = asked
    ? behind > 0
      ? (releases?.updates ?? [])
      : (releases?.notes ?? [])
    : (releases?.unseen ?? []);
  const open = asked || shown.length > 0;
  const many = asked || shown.length > 1;
  const [latest] = shown;

  return (
    <ReleaseUpdateContext.Provider value={{ behind }}>
      <ReleaseNotesContext.Provider value={show}>
        {children}
        {open && (
          <Modal
            title={
              asked
                ? behind > 0
                  ? `What's new since Atena ${releases?.version ?? ''}`
                  : 'Release notes'
                : `What's new in Atena ${releases?.version ?? latest?.version ?? ''}`
            }
            {...(asked
              ? {
                  description:
                    behind > 0
                      ? `${behind} newer ${behind === 1 ? 'release is' : 'releases are'} available. Update Atena through your deployment method after reviewing these notes.`
                      : releases?.version
                        ? `Every release up to ${releases.version}, newest first.`
                        : 'This build has no version, so it has no notes to show.',
                }
              : latest?.summary
                ? { description: latest.summary }
                : {})}
            close={close}
            footer={
              <Button type="button" onClick={close}>
                {asked ? 'Close' : 'Got it'}
              </Button>
            }
          >
            <div className="release-notes">
              {shown.map((note) => (
                <section key={note.version}>
                  {many && (
                    <h2>
                      {note.version} <small>{date(note.date)}</small>
                    </h2>
                  )}
                  {many && note.summary && <p>{note.summary}</p>}
                  <Markdown text={note.body} />
                </section>
              ))}
            </div>
          </Modal>
        )}
      </ReleaseNotesContext.Provider>
    </ReleaseUpdateContext.Provider>
  );
}
