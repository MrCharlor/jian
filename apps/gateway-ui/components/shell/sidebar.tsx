'use client';

import { LogOut, ScrollText, Star, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { gatewayApi } from '../../lib/api';
import { currentSection, groupLabels, navigation } from '../../lib/navigation';
import { useWorkspace } from '../../lib/workspace';
import { useReleaseNotes, useReleaseUpdate } from '../releases/dialog';
import { GitHubLogo, Mark } from '../ui';
import { ProfileSwitcher } from './profile-switcher';
import { ThemeSwitcher } from './theme';

export function Sidebar({
  open,
  onNavigate,
  onCreateProfile,
}: {
  open: boolean;
  onNavigate: () => void;
  onCreateProfile: () => void;
}) {
  const pathname = usePathname();
  const active = currentSection(pathname);
  const { data, loading, signOut } = useWorkspace();
  const releaseNotes = useReleaseNotes();
  const releaseUpdate = useReleaseUpdate();
  // Requests waiting on the owner, shown wherever they are in the panel.
  const pending = data?.contacts.filter((contact) => contact.status === 'pending').length ?? 0;

  return (
    <aside
      id="main-navigation"
      className={`sidebar ${open ? 'open' : ''}`}
      role={open ? 'dialog' : undefined}
      aria-label={open ? 'Navigation' : undefined}
    >
      <button
        type="button"
        className="icon-button mobile-menu absolute right-3 top-3"
        aria-label="Close navigation"
        onClick={onNavigate}
      >
        <X size={18} />
      </button>
      <Link className="brand" href="/" onClick={onNavigate}>
        <Mark className={loading ? 'connecting' : data ? 'connected' : ''} />
        <span>Atena</span>
      </Link>
      <ProfileSwitcher onCreate={onCreateProfile} />
      <nav className="sidebar-nav" aria-label="Main navigation">
        {(['global', 'agent'] as const).map((group) => (
          <div className="nav-group" key={group}>
            <span className="nav-label">{groupLabels[group]}</span>
            {navigation
              .filter((item) => item.group === group)
              .map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active?.href === item.href ? 'active' : ''}
                  aria-current={active?.href === item.href ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  <item.icon size={18} strokeWidth={1.7} />
                  <span>{item.label}</span>
                  {item.href === '/channels' && pending > 0 && (
                    <span className="nav-count">
                      {pending}
                      <span className="sr-only"> waiting for approval</span>
                    </span>
                  )}
                </Link>
              ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <ThemeSwitcher />
        <GitHubLink />
        <button
          type="button"
          className={releaseUpdate.behind > 0 ? 'release-update' : undefined}
          onClick={() => {
            onNavigate();
            releaseNotes();
          }}
        >
          <ScrollText size={16} />
          Release notes
          {releaseUpdate.behind > 0 && (
            <span className="release-update-count">
              {releaseUpdate.behind}
              <span className="sr-only"> releases behind</span>
            </span>
          )}
        </button>
        <button type="button" onClick={() => void signOut()}>
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

const REPOSITORY = 'https://github.com/MrCharlor/jian';

/** Stars in the way GitHub shows them: 1.2k past a thousand. */
const starCount = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Where Jian lives. The count comes through the gateway; the link works without it. */
function GitHubLink() {
  const [stars, setStars] = useState<number>();

  useEffect(() => {
    let active = true;

    void gatewayApi()
      .repository()
      .then((repository) => {
        if (active) setStars(repository.stars);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  return (
    <a className="sidebar-github" href={REPOSITORY} target="_blank" rel="noreferrer">
      <GitHubLogo size={16} />
      GitHub
      {stars !== undefined && (
        <span className="sidebar-stars">
          <Star size={12} aria-hidden="true" />
          {starCount.format(stars)}
          <span className="sr-only"> stars</span>
        </span>
      )}
    </a>
  );
}
