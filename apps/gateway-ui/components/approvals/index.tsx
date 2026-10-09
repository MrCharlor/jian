'use client';

import { Check, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Approval } from '../../lib/api';
import { date } from '../../lib/format';
import { useWorkspace } from '../../lib/workspace';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, SectionHeading } from '../ui';

const tones: Record<Approval['status'], 'accent' | 'good' | 'bad' | 'neutral'> = {
  pending: 'accent',
  approved: 'good',
  used: 'good',
  rejected: 'bad',
  expired: 'neutral',
};

const labels: Record<Approval['status'], string> = {
  pending: 'Waiting for you',
  approved: 'Approved, not yet run',
  used: 'Approved and run',
  rejected: 'Rejected',
  expired: 'Expired',
};

/** The call as the agent would make it, for the owner to read what exactly would happen. */
function detail(approval: Approval): string {
  try {
    return JSON.stringify(approval.input, null, 2) ?? '';
  } catch {
    return String(approval.input);
  }
}

/**
 * What the agent prepared and waits on. A request is a decision: it shows the exact call, and
 * the two answers. What was decided stays below, so the owner can see what ran and what did
 * not, and why.
 */
export function Approvals({ profile, api, mutate, busy }: SectionProps) {
  const { subscribe } = useWorkspace();
  const [list, setList] = useState<Approval[]>();
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<Record<string, string>>({});

  const load = useCallback(
    () =>
      api
        .approvals(profile.id)
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'The requests could not load.'),
        ),
    [api, profile.id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The agent asks while the owner is looking, and a reply in a chat decides without this page.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type.startsWith('approval.')) void load();
      }),
    [subscribe, load],
  );

  const decide = async (approval: Approval, approve: boolean) => {
    const reason = reasons[approval.id]?.trim() || undefined;
    const ok = await mutate(
      () =>
        approve
          ? api.approve(profile.id, approval.id, reason)
          : api.reject(profile.id, approval.id, reason),
      approve
        ? `#${approval.number} approved. Tell the agent to go on, or wait for its next turn.`
        : `#${approval.number} rejected.`,
    );

    if (ok) await load();
  };

  const pending = (list ?? []).filter((item) => item.status === 'pending');
  const decided = (list ?? []).filter((item) => item.status !== 'pending');

  const card = (approval: Approval) => (
    <article className="request-card" key={approval.id}>
      <header>
        <div className="grow">
          <h4>
            #{approval.number} · {approval.action}
            <Badge tone={tones[approval.status]}>{labels[approval.status]}</Badge>
          </h4>
          <small>
            {approval.decidedVia ? `Decided from the ${approval.decidedVia}` : 'Asked'}
            {approval.reason && ` · ${approval.reason}`}
          </small>
        </div>
        <time dateTime={approval.createdAt}>{date(approval.createdAt)}</time>
      </header>
      <pre className="request-quote">{detail(approval)}</pre>
      {approval.status === 'pending' && (
        <footer>
          <input
            aria-label={`Reason for #${approval.number}`}
            placeholder="Reason, optional. The agent reads it."
            value={reasons[approval.id] ?? ''}
            maxLength={2000}
            onChange={(event) =>
              setReasons((current) => ({ ...current, [approval.id]: event.target.value }))
            }
          />
          <Button
            variant="quiet"
            disabled={busy}
            aria-label={`Reject #${approval.number}`}
            onClick={() => void decide(approval, false)}
          >
            <X size={16} />
            Reject
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            aria-label={`Approve #${approval.number}`}
            onClick={() => void decide(approval, true)}
          >
            <Check size={16} />
            Approve
          </Button>
        </footer>
      )}
    </article>
  );

  return (
    <>
      <SectionHeading
        title="Approvals"
        description="Actions the agent prepared and waits on. In a chat, answer “ok 3” or “não 3: motivo”."
      />
      {error && <p className="error">{error}</p>}
      {list && !list.length ? (
        <Empty title="Nothing waiting">
          Actions at level 2 under Identity stop here before they run. The agent has not asked for
          any yet.
        </Empty>
      ) : (
        <>
          {pending.length > 0 && <div className="request-list">{pending.map(card)}</div>}
          {decided.length > 0 && (
            <section>
              <h3>
                <ShieldCheck size={16} /> Decided
              </h3>
              <div className="request-list">{decided.slice(0, 50).map(card)}</div>
            </section>
          )}
        </>
      )}
    </>
  );
}
