'use client';

import { Suspense } from 'react';
import { Mentions } from '../../../components/mentions/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Mentions {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
