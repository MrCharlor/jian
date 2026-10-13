'use client';

import { Suspense } from 'react';
import { Plans } from '../../../components/plans/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Plans {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
