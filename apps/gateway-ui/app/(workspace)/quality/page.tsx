'use client';

import { Quality } from '../../../components/quality/index';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <Quality {...useSection()} />;
}
