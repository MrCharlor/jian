'use client';

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Long text shown short: a few lines, then "ver mais" opens the rest in place. The button only
 * appears when the text really runs past those lines, measured, so short text reads as is.
 */
export function MoreText({
  children,
  lines = 4,
  className,
}: {
  children: ReactNode;
  lines?: number;
  className?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);

  useEffect(() => {
    const element = body.current;

    if (!element) return;

    const measure = () => {
      if (!open) setLong(element.scrollHeight > element.clientHeight + 1);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);

    observer.observe(element);

    return () => observer.disconnect();
  }, [open]);

  return (
    <div
      className={`more-text ${className ?? ''}`}
      data-open={open}
      data-long={long}
      style={{ '--more-lines': lines } as CSSProperties}
    >
      <div ref={body} className="more-text-body">
        {children}
      </div>
      {(long || open) && (
        <button
          type="button"
          className="text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'ver menos' : 'ver mais'}
        </button>
      )}
    </div>
  );
}
