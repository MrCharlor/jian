'use client';

import { useEffect } from 'react';

export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      void navigator.serviceWorker.register('/ui/sw.js', { scope: '/ui/' }).catch(() => {});
    }
  }, []);

  return null;
}
