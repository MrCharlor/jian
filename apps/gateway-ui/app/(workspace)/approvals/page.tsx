'use client';

import { Approvals } from '../../../components/approvals/index';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <Approvals {...useSection()} />;
}
