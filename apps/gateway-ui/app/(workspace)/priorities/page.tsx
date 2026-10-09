'use client';

import { Suspense } from 'react';
import { Priorities } from '../../../components/priorities/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Priorities {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
