'use client';

import { Save } from 'lucide-react';
import { useState } from 'react';
import type { DecisionsSettingsPatch, DecisionsStatus } from '../../lib/api/types';
import { LOCALE } from '../../lib/format';
import { Button, Field, Switch } from '../ui';

type Use = keyof DecisionsStatus['uses'];

/** Each use in the owner's words: what it looks at, not how. */
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

const count = (value: number) => new Intl.NumberFormat(LOCALE).format(value);

/**
 * What the decisions service costs and how the owner keeps it down: each use switched on or
 * off, and a daily ceiling past which the fixed rules decide. Tokens are what TypeSafe bills.
 */
export function DecisionsSpending({
  status,
  save,
  busy,
}: {
  status: DecisionsStatus;
  save: (patch: DecisionsSettingsPatch, done: string) => Promise<boolean>;
  busy?: boolean;
}) {
  const [ceiling, setCeiling] = useState(status.dailyTokenLimit?.toString() ?? '');
  const [error, setError] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const sum = (items: DecisionsStatus['usage']) =>
    items.reduce(
      (total, item) => ({
        tokens: total.tokens + item.inputTokens + item.outputTokens,
        requests: total.requests + item.requests,
        cached: total.cached + item.cached,
      }),
      { tokens: 0, requests: 0, cached: 0 },
    );
  const day = sum(status.usage.filter((item) => item.day === today));
  const week = sum(status.usage);
  const tokensOf = (use: Use) =>
    status.usage
      .filter((item) => item.day === today && item.use === use)
      .reduce((total, item) => total + item.inputTokens + item.outputTokens, 0);

  return (
    <div className="connection-form">
      <p>
        Today (UTC): {count(day.tokens)} tokens in {count(day.requests)} requests
        {day.cached > 0 ? `, ${count(day.cached)} answered from the cache at no cost` : ''}
        {status.dailyTokenLimit ? ` of a ceiling of ${count(status.dailyTokenLimit)}` : ''}. Last 7
        days: {count(week.tokens)} tokens.
      </p>
      <ul className="grid gap-3">
        {USES.map(({ use, title, what }) => (
          <li key={use} className="flex items-center justify-between gap-3">
            <span>
              <strong>{title}</strong> — {what}
              {tokensOf(use) > 0 ? ` Today: ${count(tokensOf(use))} tokens.` : ''}
            </span>
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
      <form
        className="flex flex-wrap items-end gap-3"
        method="post"
        action="/ui/"
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          const typed = ceiling.trim();
          const limit = typed ? Number(typed) : null;
          if (limit !== null && (!Number.isInteger(limit) || limit < 1000)) {
            setError('Enter a whole number of at least 1,000 tokens, or leave it empty.');
            return;
          }
          await save(
            { dailyTokenLimit: limit },
            limit ? 'Daily ceiling saved.' : 'Daily ceiling removed.',
          );
        }}
      >
        <Field
          label="Daily ceiling in tokens"
          hint="Past it, the fixed rules decide until 00:00 UTC. Empty means no ceiling."
        >
          <input
            name="ceiling"
            type="number"
            min={1000}
            step={1000}
            inputMode="numeric"
            value={ceiling}
            onChange={(event) => setCeiling(event.target.value)}
          />
        </Field>
        <Button type="submit" busy={busy}>
          <Save size={16} />
          Save ceiling
        </Button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
