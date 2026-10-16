'use client';

import { Suspense } from 'react';
import { Inbox } from '../../../components/inbox/index';
import { useSection } from '../../../lib/workspace';

function Screen() {
  return <Inbox {...useSection()} />;
}

export default function Page() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
