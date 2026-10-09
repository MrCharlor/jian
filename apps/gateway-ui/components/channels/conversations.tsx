'use client';

import { Crown, ShieldOff, UserCheck, UserX } from 'lucide-react';
import type { Channel, Contact } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Face } from '../ui';
import { kinds } from './kinds';

const agents = (count: number) => (count === 1 ? '1 agent' : `${count} agents`);

/**
 * Who this channel reaches for the profile: its groups and its people. A request waiting on the
 * owner comes first, with what it said. Revoking stops the agent answering there and keeps the
 * conversation; approving again restores it.
 */
export function Conversations({
  channel,
  profile,
  data,
  api,
  mutate,
  busy,
}: SectionProps & { channel: Channel }) {
  // Waiting first, then approved, then revoked: what needs a decision is never below the fold.
  const order = { pending: 0, approved: 1, blocked: 2 } as const;
  const mine = data.contacts
    .filter((contact) => contact.channelId === channel.id)
    .sort((a, b) => order[a.status] - order[b.status]);
  const groups = mine.filter((contact) => contact.scope === 'group');
  const people = mine.filter((contact) => contact.scope !== 'group');

  const approve = (contact: Contact, name: string) =>
    mutate(
      () => api.approveContact(profile.id, contact.id),
      contact.status === 'pending'
        ? `${name} approved. What they wrote went to the agent.`
        : `${name} approved again.`,
    );
  const refuse = (contact: Contact, name: string) =>
    mutate(
      () => api.blockContact(profile.id, contact.id),
      contact.status === 'pending'
        ? `${name} declined.`
        : `${name} revoked. The agent no longer answers there.`,
    );

  // A request is a decision, not a row: it gets room for who wrote, what they said, and the
  // two answers, with the one that approves last and strongest.
  const request = (contact: Contact, detail: string) => {
    const name = contact.displayName ?? contact.actorId;
    const channelName = kinds.find((kind) => kind.type === contact.type)?.name;

    return (
      <article className="request-card" key={contact.id}>
        <header>
          <Face name={name} picture={contact.avatar} className="request-face" />
          <div className="grow">
            <h4>
              {name}
              <Badge tone="accent">Pending</Badge>
            </h4>
            <small>
              {channelName}
              {detail !== name && ` · ${detail}`}
            </small>
          </div>
          <time dateTime={contact.createdAt}>{date(contact.createdAt)}</time>
        </header>
        {contact.scope === 'group' ? (
          <p className="request-note">
            The agent was added to this group. Approving covers everyone in it.
          </p>
        ) : contact.message ? (
          <blockquote className="request-quote">{contact.message}</blockquote>
        ) : (
          <p className="request-note">They have not written anything yet.</p>
        )}
        <footer>
          <p>
            {contact.scope === 'group'
              ? 'Until you approve, the agent reads nothing there.'
              : 'Approving hands this message to the agent, and it answers.'}
          </p>
          <Button
            variant="quiet"
            disabled={busy}
            aria-label={`Decline ${name}`}
            onClick={() => void refuse(contact, name)}
          >
            <UserX size={16} />
            Decline
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => void approve(contact, name)}>
            <UserCheck size={16} />
            Approve
          </Button>
        </footer>
      </article>
    );
  };

  const row = (contact: Contact, detail: string) => {
    if (contact.status === 'pending') {
      return request(contact, detail);
    }

    const name = contact.displayName ?? contact.actorId;

    return (
      <div className="conversation-row" key={contact.id} data-status={contact.status}>
        <Face name={name} picture={contact.avatar} />
        <div className="grow">
          <strong>{name}</strong>
          {detail !== name && <small>{detail}</small>}
        </div>
        {contact.status === 'approved' ? (
          <>
            <Badge tone="good">Approved</Badge>
            {contact.scope === 'direct' && (
              <Button
                variant={contact.owner ? 'secondary' : 'quiet'}
                disabled={busy}
                aria-pressed={contact.owner}
                aria-label={
                  contact.owner ? `${name} no longer speaks for you` : `${name} speaks for you`
                }
                title="An owner's reply in this chat decides what the agent is waiting on."
                onClick={() =>
                  void mutate(
                    () => api.setContactOwner(profile.id, contact.id, !contact.owner),
                    contact.owner
                      ? `${name} no longer speaks for you.`
                      : `${name} speaks for you: their "ok" decides approvals.`,
                  )
                }
              >
                <Crown size={16} />
                {contact.owner ? 'Owner' : 'Make owner'}
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Revoke ${name}`}
              onClick={() => void refuse(contact, name)}
            >
              <ShieldOff size={16} />
              Revoke
            </Button>
          </>
        ) : (
          <>
            <Badge>Revoked</Badge>
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`Approve ${name} again`}
              onClick={() => void approve(contact, name)}
            >
              <UserCheck size={16} />
              Approve again
            </Button>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="channel-conversations">
      <section>
        <h3>Groups</h3>
        {groups.length ? (
          groups.map((contact) => {
            const room = data.groups.find(
              (group) => group.type === contact.type && group.chatId === contact.chatId,
            );
            const others = (room?.profiles ?? []).filter(
              (item) => item.status === 'approved' && item.profileId !== profile.id,
            );

            return row(
              contact,
              others.length
                ? `With ${others.map((item) => item.name).join(', ')} · ${agents(others.length + 1)}`
                : 'The only agent here',
            );
          })
        ) : (
          <p className="note">No groups yet. Add the agent to one and approve the request.</p>
        )}
      </section>
      <section>
        <h3>Contacts</h3>
        {people.length ? (
          people.map((contact) => row(contact, contact.actorId))
        ) : (
          <p className="note">Nobody yet. Someone's first message shows up here as a request.</p>
        )}
      </section>
      <p className="note">
        In a group the agent reads everything and answers only when someone mentions it or replies
        to it.
      </p>
    </div>
  );
}
