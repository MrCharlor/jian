'use client';

import { Plus } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { NewProfileDialog } from '../../components/profile/editor';
import { ReleaseNotes } from '../../components/releases/dialog';
import { NoticeBar } from '../../components/shell/notice';
import { Sidebar } from '../../components/shell/sidebar';
import { Topbar } from '../../components/shell/topbar';
import { Button, Empty, Spinner } from '../../components/ui';
import { gatewayApi, type Profile } from '../../lib/api';
import { useWorkspace, WorkspaceProvider } from '../../lib/workspace';

/** The chrome every section shares, and the one place the session is checked. */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [profiles, setProfiles] = useState<Profile[]>();
  const [checking, setChecking] = useState(true);

  // A signed cookie from an earlier visit is enough to walk straight back in.
  useEffect(() => {
    gatewayApi()
      .profiles()
      .then(setProfiles)
      .catch(() => undefined)
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    if (!checking && !profiles) {
      router.replace('/sign-in');
    }
  }, [checking, profiles, router]);

  if (!profiles) {
    return (
      <main className="boot" aria-busy="true" aria-label="Checking the session">
        <Spinner size={32} />
      </main>
    );
  }

  return (
    <WorkspaceProvider initialProfiles={profiles} onSignOut={() => router.replace('/sign-in')}>
      <Shell>{children}</Shell>
    </WorkspaceProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // The one screen that is an app of its own: it takes the whole area and scrolls inside.
  const fill = pathname.startsWith('/sessions') || pathname.startsWith('/tasks');
  const { profiles, profile, data, loading, refresh, adopt } = useWorkspace();
  const [mobile, setMobile] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!mobile) {
      return;
    }

    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const sidebar = document.getElementById('main-navigation');
    const focusable = () =>
      Array.from(
        sidebar?.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.getClientRects().length > 0);
    const frame = requestAnimationFrame(() => focusable()[0]?.focus({ preventScroll: true }));
    const desktop = window.matchMedia('(min-width: 761px)');
    const resize = () => {
      if (desktop.matches) setMobile(false);
    };
    const close = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') setMobile(false);
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !sidebar?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', close);
    desktop.addEventListener('change', resize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', close);
      desktop.removeEventListener('change', resize);
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [mobile]);

  return (
    <ReleaseNotes>
      <div className="app-shell">
        <a href="#main-content" className="skip-link">
          Skip to content
        </a>
        <Sidebar
          open={mobile}
          onNavigate={() => setMobile(false)}
          onCreateProfile={() => {
            setMobile(false);
            setCreating(true);
          }}
        />
        <div className="workspace" inert={mobile}>
          <Topbar navigationOpen={mobile} onOpenNavigation={() => setMobile(true)} />
          <main id="main-content" tabIndex={-1} className={`main-content ${fill ? 'fill' : ''}`}>
            <NoticeBar />
            {!profiles.length ? (
              <Empty
                title="Bring your first agent to life"
                action={
                  <Button onClick={() => setCreating(true)}>
                    <Plus size={16} />
                    Create an agent
                  </Button>
                }
              >
                Start with a name and instructions. Connect your providers next.
              </Empty>
            ) : profile && data ? (
              <div key={profile.id} className="page-enter">
                {children}
              </div>
            ) : (
              <div className="loading-state" role="status">
                {loading ? (
                  <>
                    <Spinner size={32} />
                    <span>Loading your workspace…</span>
                  </>
                ) : (
                  <Button variant="secondary" onClick={() => void refresh()}>
                    Try loading again
                  </Button>
                )}
              </div>
            )}
          </main>
        </div>
        {creating && (
          <NewProfileDialog
            api={gatewayApi()}
            close={() => setCreating(false)}
            done={(created) => {
              adopt(created);
              setCreating(false);
            }}
          />
        )}
      </div>
    </ReleaseNotes>
  );
}
