'use client';

import { useEffect, useState } from 'react';
import type { SectionProps } from '../props';
import { Switch } from '../ui';

type Destination = 'panel' | 'panel_and_channel';

/**
 * Where the gateway's own word to the owner goes: a plan or a validation waiting. The panel
 * always gets it; this decides whether the contacts marked as the owner get it too.
 */
export function OwnerNotices({ api, mutate, busy }: SectionProps) {
  const [destination, setDestination] = useState<Destination>();

  useEffect(() => {
    void api
      .settings()
      .then((settings) => setDestination(settings.ownerNotices))
      .catch(() => {});
  }, [api]);

  if (!destination) return null;

  return (
    <article className="resource-row items-start">
      <div className="grow">
        <h3>Notices to the owner in chats</h3>
        <p>
          A plan or a validation waiting for you also reaches the contacts you made owner, who
          answer it there with the same words as in the panel, such as “ok plano 3”.
        </p>
      </div>
      <div className="row-actions">
        <Switch
          checked={destination === 'panel_and_channel'}
          label={`Notices to the owner in chats ${destination === 'panel_and_channel' ? 'on' : 'off'}`}
          disabled={busy}
          onChange={(on) => {
            const next: Destination = on ? 'panel_and_channel' : 'panel';

            void mutate(
              async () => {
                const saved = await api.updateSettings({ ownerNotices: next });

                setDestination(saved.ownerNotices);
              },
              on ? 'Notices also go to your owner contacts.' : 'Notices stay in the panel.',
            );
          }}
        />
      </div>
    </article>
  );
}
