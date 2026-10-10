'use client';

import { ArrowRight, CircleHelp, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { gatewayApi } from '../lib/api';
import { Button, Field, Mark } from './ui';

export function SignIn({ connected }: { connected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  // The static login must not submit a secret before React has attached its handler.
  useEffect(() => setReady(true), []);

  return (
    <main className="login-layout">
      <section className="login-story">
        <a className="brand" href="/ui/">
          <Mark />
          <span>Atena</span>
        </a>
        <div className="login-copy">
          <div className="login-emblem" aria-hidden="true">
            <Mark />
          </div>
          <h1>
            Your space.
            <br />
            Your agents.
          </h1>
          <p>Conversations, memory and tools, under your control.</p>
        </div>
        <small>Open by nature. Yours entirely.</small>
      </section>
      <section className="login-form-wrap">
        <form
          method="post"
          action="/ui/"
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');

            const token = String(new FormData(event.currentTarget).get('token')).trim();
            const api = gatewayApi();

            try {
              await api.signIn(token);
              await api.profiles();
              connected();
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Could not reach the gateway.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="login-lock">
            <LockKeyhole size={24} />
          </div>
          <h2>Connect to Atena.</h2>
          <p>Sign in with this installation's host token.</p>
          <Field label="Host token">
            <input
              name="token"
              type="password"
              placeholder="Paste your access token"
              autoComplete="off"
              required
              minLength={32}
              spellCheck={false}
            />
          </Field>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" busy={busy} disabled={!ready}>
            Enter the gateway
            <ArrowRight size={17} />
          </Button>
          <p className="secure-note">
            <ShieldCheck size={16} />
            Your token is not stored in the browser. The session expires in 30 days.
          </p>
          <details className="login-help">
            <summary>
              <CircleHelp size={15} />
              Where do I find my token?
            </summary>
            <p>
              Use the value of <code>JIAN_API_TOKEN</code> from the server configuration. It is the
              only token the gateway accepts.
            </p>
          </details>
        </form>
      </section>
    </main>
  );
}
