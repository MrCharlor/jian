'use client';

import type { DecisionsSettingsPatch, DecisionsStatus } from '../../lib/api/types';
import { Switch } from '../ui';

type Use = keyof DecisionsStatus['uses'];

const USES: Array<{ use: Use; title: string; what: string }> = [
  {
    use: 'actions',
    title: 'Actions',
    what: 'Commands, file changes, changes in connected services and messages sent to others.',
  },
  {
    use: 'outside',
    title: 'Outside content',
    what: 'Pages, searches and service results that try to give the agent orders.',
  },
  {
    use: 'turn',
    title: 'Each turn',
    what: 'The memories and skill that fit it, and less thinking on plainly light ones.',
  },
  {
    use: 'memories',
    title: 'Repeated memories',
    what: 'A new memory about a subject already kept.',
  },
  {
    use: 'learning',
    title: 'Learning',
    what: 'Skips the look-back when work holds nothing to keep.',
  },
  { use: 'groups', title: 'Groups', what: 'Whether a group message is speaking to an agent.' },
];

export function DecisionsControls({
  status,
  save,
  busy,
}: {
  status: DecisionsStatus;
  save: (patch: DecisionsSettingsPatch, done: string) => Promise<boolean>;
  busy?: boolean;
}) {
  return (
    <div className="mt-6 border-t border-line pt-6">
      <ul className="divide-y divide-line">
        {USES.map(({ use, title, what }) => (
          <li
            key={use}
            className="flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <strong className="block text-sm">{title}</strong>
              <p className="mt-1 text-sm text-muted">{what}</p>
            </div>
            <Switch
              checked={status.uses[use]}
              label={`${title} ${status.uses[use] ? 'on' : 'off'}`}
              disabled={busy}
              onChange={(on) =>
                void save(
                  { uses: { [use]: on } },
                  `${title} ${on ? 'asks Jev' : 'uses the fixed rule'}.`,
                )
              }
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
