type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => unknown;
};

function radius(x: number, y: number, width: number, height: number): number {
  return Math.max(1, Math.hypot(Math.max(x, width - x), Math.max(y, height - y)));
}

export function revealTheme(origin: { x: number; y: number }, apply: () => void): void {
  const documentWithTransition = document as ViewTransitionDocument;
  if (
    !documentWithTransition.startViewTransition ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    apply();
    return;
  }

  // View-transition snapshots are viewport-sized, even when the document
  // itself is taller because the current page scrolls.
  const root = document.documentElement;
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  const x = origin.x;
  const y = origin.y;
  const reference = Math.hypot(width, height) / Math.SQRT2;

  root.style.setProperty('--theme-reveal-x', `${(x / width) * 100}%`);
  root.style.setProperty('--theme-reveal-y', `${(y / height) * 100}%`);
  root.style.setProperty('--theme-reveal-r', `${(radius(x, y, width, height) / reference) * 100}%`);
  documentWithTransition.startViewTransition(apply);
}
