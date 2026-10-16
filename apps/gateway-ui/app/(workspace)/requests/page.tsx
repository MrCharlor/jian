'use client';

import { Suspense } from 'react';
import { Requests } from '../../../components/requests/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Requests {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
