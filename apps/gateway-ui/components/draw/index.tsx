'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { SectionProps } from '../props';
import { Button, SectionHeading } from '../ui';

/** The drawing board beside the gateway: it opens only through a link the panel hands out. */
export function Draw({ api }: SectionProps) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const open = async () => {
    setBusy(true);
    // Opened before the request so a phone does not treat the new tab as a pop-up.
    const tab = window.open('', '_blank');

    try {
      const { url } = await api.drawLink();
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setError('');
    } catch (failure) {
      tab?.close();
      setError(failure instanceof Error ? failure.message : 'O Excalidraw não abriu.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SectionHeading
        title="Desenhos"
        description="O Excalidraw da VPS, fechado para quem não entrou pelo Jian. Este navegador fica liberado por 30 dias."
        action={
          <Button busy={busy} onClick={() => void open()}>
            <ExternalLink size={16} />
            Abrir o Excalidraw
          </Button>
        }
      />
      {error && <p className="error">{error}</p>}
    </>
  );
}
