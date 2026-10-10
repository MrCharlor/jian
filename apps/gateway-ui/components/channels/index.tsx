'use client';

import { ChevronDown, Unplug } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { Channel, ChannelType } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Confirm, Field, Secret, SectionHeading } from '../ui';
import { Conversations } from './conversations';
import { kinds } from './kinds';
import { Pairing } from './pairing';

export function Channels(props: SectionProps) {
  const { profile, data, api, mutate, busy } = props;
  // A channel with someone waiting opens on its own: the decision is why the owner came here.
  const [editing, setEditing] = useState<ChannelType | undefined>(
    () =>
      data.channels.find((channel) =>
        data.contacts.some(
          (contact) => contact.channelId === channel.id && contact.status === 'pending',
        ),
      )?.type,
  );
  const [pairing, setPairing] = useState<Channel>();
  const [secret, setSecret] = useState<string>();
  const [token, setToken] = useState('');
  const [disconnecting, setDisconnecting] = useState<Channel>();
  const [error, setError] = useState('');

  const connected = (type: ChannelType) =>
    data.channels.find((channel) => channel.type === type && !channel.revokedAt);

  const webhook = (channel: Channel) =>
    channel.type === 'telegram'
      ? `${window.location.origin}/v1/telegram/${channel.id}`
      : `${window.location.origin}/v1/ingress/${channel.id}`;

  const connect = async (type: ChannelType) => {
    setError('');

    return mutate(
      async () => {
        const channel = await api.createChannel(profile.id, {
          type,
          ...(type === 'telegram' ? { botToken: token.trim() } : {}),
        });

        setToken('');

        if (type === 'whatsapp') {
          // Connecting WhatsApp is reading the QR: the device starts pairing right away.
          await api.connect(profile.id, channel.id);
          setPairing(channel);
        } else if (type === 'telegram') {
          // Jian points the bot at itself; only a refusal is worth the owner's attention, and
          // what fixes it is the public address, not a secret to paste somewhere by hand.
          if (channel.webhookRegistered === false)
            toast.error(
              `${channel.webhookError ?? 'Telegram refused the webhook.'} Set JIAN_PUBLIC_URL to the gateway's public HTTPS address, then disconnect and connect again.`,
              { duration: 20_000 },
            );
        } else if (!channel.webhookRegistered) {
          setSecret(`Webhook: ${webhook(channel)}\nX-Jian-Channel-Token: ${channel.webhookToken}`);
        }
      },
      `${kinds.find((kind) => kind.type === type)?.name} connected.`,
    );
  };

  const waiting = (channel: Channel) =>
    data.contacts.filter(
      (contact) => contact.channelId === channel.id && contact.status === 'pending',
    ).length;

  const reach = (channel: Channel) => {
    const decided = data.contacts.filter(
      (contact) => contact.channelId === channel.id && contact.status === 'approved',
    );
    const groups = decided.filter((contact) => contact.scope === 'group').length;
    const people = decided.length - groups;

    return `${people === 1 ? '1 contact' : `${people} contacts`} · ${
      groups === 1 ? '1 group' : `${groups} groups`
    }`;
  };

  return (
    <>
      <SectionHeading
        title="Channels"
        description="Take the conversation to where you already are."
      />
      <div className="resource-list">
        {kinds.map((kind) => {
          const channel = connected(kind.type);
          const open = editing === kind.type;

          return (
            <article
              className="resource-row items-start provider-row"
              data-connected={!!channel}
              key={kind.type}
            >
              <div className="resource-icon provider-symbol" aria-hidden="true">
                <kind.icon size={20} strokeWidth={1.6} />
              </div>
              <div className="grow">
                <h3>
                  {kind.name}
                  <Badge tone={channel ? 'good' : 'neutral'}>
                    {channel ? 'Connected' : 'Not connected'}
                  </Badge>
                  {channel && waiting(channel) > 0 && (
                    <Badge tone="accent">{waiting(channel)} pending</Badge>
                  )}
                </h3>
                <p>{kind.description}</p>
                {channel && (
                  <div className="connection-meta">
                    <span>{reach(channel)}</span>
                    <span>Connected on {date(channel.createdAt)}</span>
                  </div>
                )}
              </div>
              <div className="row-actions">
                <Button
                  variant="quiet"
                  disabled={busy}
                  aria-expanded={open}
                  aria-controls={`channel-${kind.type}`}
                  onClick={() => {
                    setEditing(open ? undefined : kind.type);
                    setError('');
                  }}
                >
                  {open ? 'Close' : channel ? 'Manage' : 'Connect'}
                  <ChevronDown size={16} className={open ? 'rotate-180' : undefined} />
                </Button>
              </div>
              <div
                className="connection-disclosure basis-full"
                id={`channel-${kind.type}`}
                hidden={!open}
              >
                {channel ? (
                  <>
                    {kind.type !== 'whatsapp' && (
                      <p className="note">
                        Webhook: <code>{webhook(channel)}</code>
                      </p>
                    )}
                    {kind.type === 'telegram' && (
                      <p className="note">
                        Atena registers this URL with Telegram when it connects, at{' '}
                        <code>JIAN_PUBLIC_URL</code> when it is set. To change the bot token,
                        disconnect and connect again.
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() => setDisconnecting(channel)}
                      >
                        <Unplug size={16} />
                        Disconnect
                      </Button>
                    </div>
                    <Conversations {...props} channel={channel} />
                  </>
                ) : (
                  <form
                    method="post"
                    action="/ui/"
                    onSubmit={(event) => {
                      event.preventDefault();

                      if (kind.type === 'telegram' && !token.trim()) {
                        setError('Enter the Telegram bot token.');

                        return;
                      }

                      void connect(kind.type);
                    }}
                  >
                    {kind.type === 'telegram' && (
                      <Field
                        label="Bot token"
                        hint="The token is encrypted here and never shown again."
                      >
                        <input
                          name="botToken"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          value={token}
                          onChange={(event) => setToken(event.target.value)}
                          required
                        />
                      </Field>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <Button type="submit" busy={busy}>
                        <kind.icon size={16} />
                        Connect {kind.name}
                      </Button>
                      <span className="text-xs text-muted">
                        {kind.type === 'whatsapp'
                          ? 'Opens the QR code to scan on your phone.'
                          : kind.type === 'api'
                            ? 'Creates the webhook URL and token, shown once.'
                            : 'Use the token BotFather gave you.'}
                      </span>
                    </div>
                  </form>
                )}
                {error && open && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {pairing && (
        <Pairing
          profileId={profile.id}
          channel={pairing}
          api={api}
          close={() => setPairing(undefined)}
        />
      )}
      {secret && (
        <Secret title="Webhook configuration" value={secret} close={() => setSecret(undefined)} />
      )}
      {disconnecting && (
        <Confirm
          title="Disconnect this channel?"
          description="The channel stops receiving messages. Approved contacts and their conversations are kept."
          busy={busy}
          close={() => setDisconnecting(undefined)}
          confirm={async () => {
            if (
              await mutate(
                () => api.revokeChannel(profile.id, disconnecting.id),
                'Channel disconnected.',
              )
            ) {
              setDisconnecting(undefined);
            }
          }}
        />
      )}
    </>
  );
}
