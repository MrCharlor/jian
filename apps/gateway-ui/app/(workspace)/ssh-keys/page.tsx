'use client';

import { SshKeys } from '../../../components/ssh-keys';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <SshKeys {...useSection()} />;
}
