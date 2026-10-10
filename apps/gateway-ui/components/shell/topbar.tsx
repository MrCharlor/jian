'use client';
import { Menu } from 'lucide-react';
import { Mark } from '../ui';
export function Topbar({
  onOpenNavigation,
  navigationOpen,
}: {
  onOpenNavigation: () => void;
  navigationOpen: boolean;
}) {
  return (
    <header className="topbar">
      <span className="flex items-center gap-2 font-display text-lg font-semibold tracking-tight">
        <Mark small /> Atena
      </span>
      <button
        type="button"
        className="icon-button"
        aria-label="Open navigation"
        aria-expanded={navigationOpen}
        aria-controls="main-navigation"
        onClick={onOpenNavigation}
      >
        <Menu size={20} />
      </button>
    </header>
  );
}
