'use client';

import { Suspense } from 'react';
import { Board } from '../../../components/board/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Board {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
