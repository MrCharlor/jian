'use client';

import { Save, Server, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Field, hasLogo, ProviderLogo, ResourceRow, SectionHeading } from '../ui';
import { Select } from '../ui/select';
import { anthropicCredentials, providers } from './catalog';
import { DecisionsRow, PrototypePrintsRow, WebSearchRow } from './service-keys';

/** What the row says about the credential in place, in one line. */
function credentialLine(provider: {
  apiKeyEnv?: string;
  authMode?: string;
  credential?: string;
  createdAt: string;
}) {
  if (provider.apiKeyEnv) {
    return `From the environment · ${provider.apiKeyEnv}`;
  }

  if (provider.authMode === 'codex') {
    return 'ChatGPT login';
  }

  const kind = provider.credential === 'subscription' ? 'Subscription token' : 'Key';

  return `${kind} saved on ${date(provider.createdAt)}`;
}

export function Providers({ data, api, mutate, busy }: SectionProps) {
  const [editing, setEditing] = useState<string>();
  const [formError, setFormError] = useState('');
  const [credential, setCredential] = useState('key');
  const [codexLogin, setCodexLogin] = useState<Awaited<ReturnType<GatewayApi['codexLogin']>>>();

  useEffect(() => {
    let active = true;
    void api
      .codexLogin()
      .then((state) => {
        if (active) setCodexLogin(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [api]);

  useEffect(() => {
    if (codexLogin?.status !== 'pending') return;
    const timer = setInterval(() => {
      void api
        .codexLogin()
        .then((state) => {
          setCodexLogin(state);
          if (state.status === 'connected') void mutate(async () => {}, 'ChatGPT connected.');
        })
        .catch(() => setCodexLogin({ status: 'failed', error: 'The login could not be checked.' }));
    }, 5000);
    return () => clearInterval(timer);
  }, [api, codexLogin?.status, mutate]);

  const entry = providers.find((item) => item.kind === editing);
  const liveOf = (kind: string) => ({
    configured: data.providers.find(
      (provider) => provider.kind === kind && !provider.revokedAt && provider.authMode !== 'codex',
    ),
    codex: data.providers.find(
      (provider) => provider.kind === kind && provider.authMode === 'codex' && !provider.revokedAt,
    ),
  });
  const { configured, codex } = liveOf(editing ?? '');

  // The settings of the open row: its credential, and for OpenAI the ChatGPT sign-in beside it.
  const form = (entry: (typeof providers)[number]) => (
    <form
      className="connection-form"
      method="post"
      action="/ui/"
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError('');
        const element = event.currentTarget;
        const values = new FormData(element);
        const secret = String(values.get('secret') ?? '').trim();
        const baseURL = String(values.get('baseURL') ?? '').trim();
        const server = entry.kind === 'openai-compatible';
        if (!secret && !server) {
          setFormError(`Enter the ${entry.name} credential.`);
          return;
        }
        // Registering replaces the provider of this vendor, key included.
        const ok = await mutate(
          () =>
            api.createProvider({
              name: entry.name,
              kind: entry.kind,
              ...(secret ? { secret } : {}),
              ...(server ? { baseURL } : {}),
              ...(entry.kind === 'anthropic'
                ? { credential: credential as 'key' | 'subscription' }
                : {}),
            }),
          `${entry.name} configured.`,
        );
        if (ok) {
          element.reset();
          setEditing(undefined);
        }
      }}
    >
      {entry.kind === 'anthropic' && (
        <Field label="Credential type" hint="Anthropic refuses either one sent as the other.">
          <Select
            value={credential}
            onValueChange={setCredential}
            options={[...anthropicCredentials]}
            aria-label="Credential type"
          />
        </Field>
      )}
      {entry.kind === 'openai-compatible' && (
        <Field
          label="Address"
          hint="Where its API is, up to /v1 — for a Whisper container beside the gateway, http://whisper:8000/v1. A private address must be allowed in JIAN_ALLOW_PRIVATE_ORIGINS."
        >
          <input
            name="baseURL"
            type="url"
            required
            placeholder="http://whisper:8000/v1"
            defaultValue={configured?.baseURL ?? ''}
          />
        </Field>
      )}
      <Field
        label={
          entry.kind === 'openai-compatible'
            ? 'API key (optional)'
            : entry.kind === 'openai' || entry.kind === 'groq'
              ? 'API key'
              : `${entry.name} credential`
        }
        hint={
          configured?.apiKeyEnv
            ? `Currently ${configured.apiKeyEnv}. What you save here replaces it.`
            : entry.kind === 'openai-compatible'
              ? 'Only if your server asks for one. It is never shown again.'
              : 'What you save here is never shown again.'
        }
      >
        <input
          name="secret"
          type="password"
          autoComplete="off"
          required={entry.kind !== 'openai-compatible'}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" busy={busy}>
          <Save size={16} />
          {configured ? 'Replace it' : 'Save it'}
        </Button>
        {configured && !configured.apiKeyEnv && (
          <Button
            type="button"
            variant="quiet"
            disabled={busy}
            onClick={async () => {
              if (
                await mutate(() => api.revokeProvider(configured.id), `${entry.name} disconnected.`)
              )
                setEditing(undefined);
            }}
          >
            <Trash2 size={16} />
            Remove it
          </Button>
        )}
      </div>
      {entry.kind === 'openai' && (
        <div className="provider-alternative">
          <p>Or use your ChatGPT plan instead of an API key.</p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              disabled={busy || codexLogin?.status === 'pending'}
              onClick={() =>
                void api
                  .startCodexLogin()
                  .then(setCodexLogin)
                  .catch((error) =>
                    setFormError(
                      error instanceof Error ? error.message : 'The login is unavailable.',
                    ),
                  )
              }
            >
              Sign in with ChatGPT
            </Button>
            {codex && (
              <Button
                type="button"
                variant="quiet"
                disabled={busy}
                onClick={() =>
                  void mutate(() => api.revokeProvider(codex.id), 'ChatGPT disconnected.')
                }
              >
                Disconnect ChatGPT
              </Button>
            )}
          </div>
          {codexLogin?.status === 'pending' && (
            <p className="note">
              Open{' '}
              <a href={codexLogin.verificationUrl} target="_blank" rel="noreferrer">
                the OpenAI login
              </a>{' '}
              and enter the code <strong>{codexLogin.userCode}</strong>.
            </p>
          )}
          {codexLogin?.status === 'failed' && codexLogin.error && (
            <p className="form-error" role="alert">
              {codexLogin.error}
            </p>
          )}
        </div>
      )}
      {formError && (
        <p className="form-error" role="alert">
          {formError}
        </p>
      )}
    </form>
  );

  return (
    <>
      <SectionHeading
        title="Providers"
        description="Connect once, use from every agent. Each agent picks its own model under Model defaults."
      />
      <section className="row-group" aria-labelledby="provider-models">
        <h2 id="provider-models">Models</h2>
        <div className="resource-list">
          {providers.map((item) => {
            const live = liveOf(item.kind);
            const list = live.configured ? data.providerModels[live.configured.id] : undefined;
            const uncatalogued = list?.models.filter((model) => !model.known).length ?? 0;

            return (
              <ResourceRow
                key={item.kind}
                id={`provider-${item.kind}`}
                icon={
                  hasLogo(item.kind) ? (
                    <ProviderLogo kind={item.kind} size={24} />
                  ) : (
                    <Server size={22} strokeWidth={1.6} />
                  )
                }
                name={item.name}
                description={item.description}
                badges={
                  <>
                    {list?.stale ? (
                      <Badge tone="bad">Unreachable</Badge>
                    ) : live.configured ? (
                      <Badge tone="good">Connected</Badge>
                    ) : live.codex ? (
                      <Badge tone="good">ChatGPT connected</Badge>
                    ) : (
                      <Badge>Not connected</Badge>
                    )}
                    {list?.models.length ? (
                      <Badge dot={false}>
                        {list.models.length} {list.models.length === 1 ? 'model' : 'models'}
                      </Badge>
                    ) : null}
                  </>
                }
                facts={[
                  live.configured
                    ? live.configured.baseURL
                      ? `At ${live.configured.baseURL}`
                      : credentialLine(live.configured)
                    : item.variables
                      ? `Or ${item.variables}`
                      : 'Not set up',
                  ...(uncatalogued ? [`${uncatalogued} with unknown capabilities`] : []),
                  ...(list?.stale
                    ? [
                        `${list.models.length ? `List from ${date(list.fetchedAt)}. ` : ''}${list.reason ?? 'The model list could not be refreshed.'}`,
                      ]
                    : []),
                  ...(item.kind === 'openai' && live.codex && !live.configured
                    ? ['An API key alongside it adds image and voice generation.']
                    : []),
                ]}
                action={live.configured || live.codex ? 'Manage' : 'Connect'}
                busy={busy}
                open={editing === item.kind}
                onToggle={() => {
                  setEditing(editing === item.kind ? undefined : item.kind);
                  setCredential(live.configured?.credential ?? 'key');
                  setFormError('');
                }}
              >
                {entry && form(entry)}
              </ResourceRow>
            );
          })}
        </div>
      </section>
      <section className="row-group" aria-labelledby="provider-services">
        <h2 id="provider-services">Services</h2>
        <div className="resource-list">
          <WebSearchRow api={api} mutate={mutate} busy={busy} />
          <DecisionsRow api={api} mutate={mutate} busy={busy} />
          <PrototypePrintsRow api={api} mutate={mutate} busy={busy} />
        </div>
      </section>
    </>
  );
}
