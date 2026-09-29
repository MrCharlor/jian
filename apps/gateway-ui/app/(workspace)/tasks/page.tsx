'use client';

import { WorkBoard } from '../../../components/tasks/board';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <WorkBoard {...useSection()} />;
}
