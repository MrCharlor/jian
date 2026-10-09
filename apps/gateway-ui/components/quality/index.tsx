'use client';

import { ArrowUpCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { QualityRow } from '../../lib/api';
import { date } from '../../lib/format';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, SectionHeading } from '../ui';

/** A schedule's automation reads as its name; an action reads as itself. */
const label = (row: QualityRow) =>
  row.automation.startsWith('schedule:')
    ? row.automation.slice('schedule:'.length)
    : row.automation;

/**
 * How each automation is doing, as the owner corrected it: rounds and corrections, the last
 * thing they changed, and whether enough clean rounds passed to let the action run on its own.
 */
export function Quality({ profile, api, mutate, busy }: SectionProps) {
  const { subscribe, refresh } = useWorkspace();
  const [rows, setRows] = useState<QualityRow[]>();
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api
        .quality(profile.id)
        .then((items) => {
          setRows(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'Quality could not load.'),
        ),
    [api, profile.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.type.startsWith('approval.') || event.type.startsWith('correction.')) void load();
      }),
    [subscribe, load],
  );

  const raise = async (action: string) => {
    const ok = await mutate(
      () =>
        api.updateProfile(profile.id, {
          expectedVersion: profile.version,
          actionPolicy: {
            ...profile.actionPolicy,
            tools: { ...profile.actionPolicy.tools, [action]: 3 },
          },
        }),
      `${action} now runs on its own and reports.`,
    );

    if (ok) {
      await refresh();
      await load();
    }
  };

  return (
    <>
      <SectionHeading
        title="Quality"
        description="Rounds and corrections per automation. Ten clean rounds in a row and an action is ready to run on its own."
      />
      {error && <p className="error">{error}</p>}
      {rows && !rows.length ? (
        <Empty title="Nothing measured yet">
          An automation shows here once it ran: a schedule, or an action decided under Approvals.
          Refusing, editing a request or writing “corrige: …” in a chat counts as a correction.
        </Empty>
      ) : (
        <table className="quality-table">
          <thead>
            <tr>
              <th>Automation</th>
              <th>Rounds (30 days)</th>
              <th>Corrections (30 days)</th>
              <th>Clean in a row</th>
              <th>Last correction</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((row) => {
              const level = row.action
                ? (profile.actionPolicy.tools[row.action] ?? undefined)
                : undefined;

              return (
                <tr key={row.automation}>
                  <td>
                    <strong>{label(row)}</strong>
                    <small>{row.action ? 'Action' : 'Schedule'}</small>
                  </td>
                  <td className="number">{row.rounds30}</td>
                  <td className="number">{row.corrections30}</td>
                  <td className="number">
                    {row.clean} {row.ready ? <Badge tone="good">Ready</Badge> : null}
                  </td>
                  <td>
                    {row.lastCorrection ? (
                      <>
                        {row.lastCorrection.kind}
                        {row.lastCorrection.note && `: ${row.lastCorrection.note}`}
                        <small>{date(row.lastCorrection.createdAt)}</small>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {row.action && row.ready && level !== 3 && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => void raise(row.action ?? '')}
                      >
                        <ArrowUpCircle size={16} />
                        Raise to level 3
                      </Button>
                    )}
                    {row.action && level === 3 && <Badge tone="good">Level 3</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
