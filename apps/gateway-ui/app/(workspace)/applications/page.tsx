'use client';

import { Suspense } from 'react';
import { Applications } from '../../../components/applications/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Applications {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
