'use client';

import { Suspense } from 'react';
import { Roadmap } from '../../../components/roadmap/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Roadmap {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
