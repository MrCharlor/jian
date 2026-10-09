'use client';

import { Suspense } from 'react';
import { Pautas } from '../../../components/pautas/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Pautas {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
