'use client';

import { Suspense } from 'react';
import { Validations } from '../../../components/validations/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Validations {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
