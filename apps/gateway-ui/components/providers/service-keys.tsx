'use client';

import { Save, Scale, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, ProviderLogo, ResourceRow } from '../ui';

type Status = { configured: boolean; updatedAt?: string };
type RowProps = Pick<SectionProps, 'api' | 'mutate' | 'busy'>;

/**
 * A service the whole installation shares through one key. These sit beside the model
 * providers because each is a credential of the installation, but none of them chooses a model.
 */
function ServiceKeyRow({
  id,
  icon,
  title,
  vendor,
  children,
  source,
  load,
  save,
  remove,
  mutate,
  busy,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  vendor: string;
  children: string;
  source: string;
  load: () => Promise<Status>;
  save: (key: string) => Promise<Status>;
  remove: () => Promise<Status>;
} & Pick<SectionProps, 'mutate' | 'busy'>) {
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    let active = true;
    void load()
      .then((state) => {
        if (active) setStatus(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [load]);

  const change = async (action: () => Promise<Status>, done: string) => {
    let next: Status | undefined;
    const ok = await mutate(async () => {
      next = await action();
    }, done);
    if (ok && next) setStatus(next);
    return ok;
  };

  return (
    <ResourceRow
      id={id}
      icon={icon}
      name={`${title} · ${vendor}`}
      description={children}
      badges={
        status?.configured ? <Badge tone="good">Connected</Badge> : <Badge>Not connected</Badge>
      }
      facts={[
        status?.configured && status.updatedAt
          ? `Key saved on ${date(status.updatedAt)}`
          : `A key from ${source}`,
      ]}
      action={status?.configured ? 'Manage' : 'Connect'}
      busy={busy}
      open={open}
      onToggle={() => {
        setOpen(!open);
        setFormError('');
      }}
    >
      <form
        className="connection-form"
        method="post"
        action="/ui/"
        onSubmit={async (event) => {
          event.preventDefault();
          setFormError('');
          const element = event.currentTarget;
          const key = String(new FormData(element).get('secret') ?? '').trim();
          if (!key) {
            setFormError(`Enter the ${vendor} key.`);
            return;
          }
          if (await change(() => save(key), `${title} configured.`)) {
            element.reset();
            setOpen(false);
          }
        }}
      >
        <Field label={`${vendor} key`} hint="What you save here is never shown again.">
          <input name="secret" type="password" autoComplete="off" required />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" busy={busy}>
            <Save size={16} />
            {status?.configured ? 'Replace it' : 'Save it'}
          </Button>
          {status?.configured && (
            <Button
              type="button"
              variant="quiet"
              disabled={busy}
              onClick={async () => {
                if (await change(remove, `${title} removed.`)) setOpen(false);
              }}
            >
              <Trash2 size={16} />
              Remove it
            </Button>
          )}
        </div>
        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}
      </form>
    </ResourceRow>
  );
}

export function WebSearchRow({ api, mutate, busy }: RowProps) {
  return (
    <ServiceKeyRow
      id="provider-web-search"
      icon={<ProviderLogo kind="tavily" size={24} />}
      title="Web search"
      vendor="Tavily"
      source="tavily.com"
      load={api.webSearch}
      save={api.setWebSearch}
      remove={api.removeWebSearch}
      mutate={mutate}
      busy={busy}
    >
      Lets the profiles with web search switched on search the internet and read pages. The free
      plan covers 1,000 searches a month.
    </ServiceKeyRow>
  );
}

export function DecisionsRow({ api, mutate, busy }: RowProps) {
  return (
    <ServiceKeyRow
      id="provider-decisions"
      icon={<Scale size={20} strokeWidth={1.6} />}
      title="Decisions"
      vendor="Jev"
      source="typesafe.ai"
      load={api.decisions}
      save={api.setDecisions}
      remove={api.removeDecisions}
      mutate={mutate}
      busy={busy}
    >
      Quick second opinions for every profile: holds back actions that destroy, cannot be undone or
      expose private data beyond what was asked, marks outside content that tries to steer an agent,
      picks the memories and skill that fit each turn, thinks less on plainly light ones, and tells
      whether a group message is speaking to an agent. Each check sends the message, action or short
      list it judges to TypeSafe. Without a key, the fixed rules decide.
    </ServiceKeyRow>
  );
}
