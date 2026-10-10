'use client';

import { Suspense } from 'react';
import { Draw } from '../../../components/draw/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Draw {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
