'use client';

import { Applications } from '../../../components/applications/index';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <Applications {...useSection()} />;
}
