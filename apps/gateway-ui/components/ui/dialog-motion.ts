'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const duration = 300;

/** Keep a native dialog mounted until its exit motion finishes. */
export function useDialogMotion(close: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    element?.showModal();
    return () => {
      clearTimeout(timer.current);
      element?.close();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (timer.current) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      close();
      return;
    }
    setClosing(true);
    timer.current = setTimeout(close, duration);
  }, [close]);

  return { ref, closing, requestClose };
}
