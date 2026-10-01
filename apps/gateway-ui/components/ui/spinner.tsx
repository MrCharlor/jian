import { LoaderCircle } from 'lucide-react';

export function Spinner({ size = 24 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin text-muted" aria-hidden="true" />;
}
