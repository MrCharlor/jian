'use client';

import { Suspense } from 'react';
import { Knowledge } from '../../../components/knowledge/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Knowledge {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
