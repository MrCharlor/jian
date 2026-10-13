'use client';

import { Suspense } from 'react';
import { Routines } from '../../../components/routines/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Routines {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
