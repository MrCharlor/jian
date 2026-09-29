/** A single ascending wing and a small forward head, kept legible at favicon size. */
export function Mark({ small = false, className = '' }: { small?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="currentColor"
      className={`brand-mark ${small ? 'small' : ''} ${className}`}
      aria-hidden="true"
    >
      <path d="M8 68C28 64 45 51 60 27c2 14-2 27-11 37 13-5 26-16 37-33-2 25-15 42-38 50-16 5-30 1-40-13Z" />
      <path d="M54 71c11-2 21-8 29-17l10-1-9 7c-7 14-21 24-41 25-8 0-16-2-22-5 13 1 24-2 33-9Z" />
    </svg>
  );
}
