'use client';

import { Suspense } from 'react';
import { Screens } from '../../../components/screens/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Screens {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
