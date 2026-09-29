'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';

/** Chats open at the end and follow new content until the reader scrolls up. */
export function useFollowBottom() {
  const scroller = useRef<HTMLElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const element = scroller.current;
    const content = element?.firstElementChild;
    if (!element || !content) return;
    const follow = () => {
      if (following.current) element.scrollTop = element.scrollHeight;
    };
    const observer = new ResizeObserver(follow);
    follow();
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const follow = useCallback(() => {
    following.current = true;
  }, []);
  const onScroll = useCallback((element: HTMLElement) => {
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, []);

  return {
    scroller,
    follow,
    onScroll,
  };
}
