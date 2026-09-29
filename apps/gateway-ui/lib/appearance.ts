'use client';

import { useSyncExternalStore } from 'react';

function read() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function subscribe(change: () => void) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', change);

  return () => {
    query.removeEventListener('change', change);
  };
}

export function useAppearance() {
  const still = useSyncExternalStore(subscribe, read, () => false);
  return { dark: true, still };
}
