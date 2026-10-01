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

  const root = document.documentElement;
  const box = root.getBoundingClientRect();
  const width = Math.max(1, box.width);
  const height = Math.max(1, box.height);
  const x = origin.x - box.left;
  const y = origin.y - box.top;
  const reference = Math.hypot(width, height) / Math.SQRT2;

  root.style.setProperty('--theme-reveal-x', `${(x / width) * 100}%`);
  root.style.setProperty('--theme-reveal-y', `${(y / height) * 100}%`);
  root.style.setProperty('--theme-reveal-r', `${(radius(x, y, width, height) / reference) * 100}%`);
  documentWithTransition.startViewTransition(apply);
}
