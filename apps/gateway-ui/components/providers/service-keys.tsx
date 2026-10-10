'use client';

import { Github, Save, Scale, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, ProviderLogo, ResourceRow } from '../ui';
import { DecisionsControls } from './decisions-controls';

type Status = { configured: boolean; updatedAt?: string };
type RowProps = Pick<SectionProps, 'api' | 'mutate' | 'busy'>;

/**
 * A service the whole installation shares through one key. These sit beside the model
 * providers because each is a credential of the installation, but none of them chooses a model.
 */
function ServiceKeyRow<S extends Status>({
  id,
  icon,
  title,
  vendor,
  children,
  source,
  load,
  save,
  remove,
  more,
  mutate,
  busy,
}: {
  id: string;
  icon: ReactNode;
  title: string;
  vendor: string;
  children: string;
  source: string;
  load: () => Promise<S>;
  save: (key: string) => Promise<S>;
  remove: () => Promise<S>;
  /** What the service offers besides its key, shown once the row is open and the state known. */
  more?: (
    status: S,
    change: (action: () => Promise<S>, done: string) => Promise<boolean>,
  ) => ReactNode;
} & Pick<SectionProps, 'mutate' | 'busy'>) {
  const [status, setStatus] = useState<S>();
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

  const change = async (action: () => Promise<S>, done: string) => {
    let next: S | undefined;
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
      {status && more?.(status, change)}
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
      Lets agents with web search switched on search the internet and read pages. The free plan
      covers 1,000 searches a month.
    </ServiceKeyRow>
  );
}

export function PrototypePrintsRow({ api, mutate, busy }: RowProps) {
  return (
    <ServiceKeyRow
      id="provider-prototype-prints"
      icon={<Github size={20} strokeWidth={1.6} />}
      title="Prototype prints"
      vendor="GitHub"
      source="a fine-grained token with Contents read and write on the prints repository only"
      load={api.prototypePrints}
      save={api.setPrototypePrints}
      remove={api.removePrototypePrints}
      more={(status) =>
        status.repository ? (
          <p className="text-sm text-muted">Repository: {status.repository}</p>
        ) : (
          <p className="text-sm text-muted">
            No repository: set JIAN_PRINTS_REPO on the server first.
          </p>
        )
      }
      mutate={mutate}
      busy={busy}
    >
      Lets a prototype drawn in Claude Design see the prints attached to its request. The prints go
      to a private GitHub repository that the cloud drawing session opens, because it cannot reach
      this server.
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
      more={(status, change) => (
        <DecisionsControls
          status={status}
          busy={busy}
          save={(patch, done) => change(() => api.updateDecisions(patch), done)}
        />
      )}
      mutate={mutate}
      busy={busy}
    >
      Quick second opinions for every agent: holds back actions that destroy, cannot be undone or
      expose private data beyond what was asked, marks outside content that tries to steer an agent,
      picks the memories and skill that fit each turn, thinks less on plainly light ones, and tells
      whether a group message is speaking to an agent. Each check sends the message, action or short
      list it judges to TypeSafe. A repeated question is answered from a cache, and each use can be
      switched off. Without a key, the fixed rules decide.
    </ServiceKeyRow>
  );
}
