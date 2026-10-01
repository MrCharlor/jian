'use client';

import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import type { SshKey } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Confirm, Empty, Field, Modal, ResourceRow, SectionHeading } from '../ui';

export function SshKeys({ profile, api, mutate, busy }: SectionProps) {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState<SshKey>();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<SshKey>();
  const [copied, setCopied] = useState<string>();
  const [error, setError] = useState('');

  useEffect(() => {
    void api
      .sshKeys(profile.id)
      .then(setKeys)
      .catch(() => setError('Could not load SSH keys.'));
  }, [api, profile.id]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim();
    if (!label) return;
    setError('');
    let result: SshKey | undefined;
    if (
      await mutate(async () => {
        result = await api.createSshKey(profile.id, { name: label });
        setKeys((current) => [...current, result as SshKey]);
      }, 'SSH key created.')
    ) {
      setName('');
      setCreating(false);
      setCreated(result);
    }
  };

  const copy = async (key: SshKey) => {
    await navigator.clipboard.writeText(key.publicKey);
    setCopied(key.id);
    window.setTimeout(
      () => setCopied((current) => (current === key.id ? undefined : current)),
      1500,
    );
  };

  return (
    <>
      <SectionHeading
        title="SSH keys"
        description="Keys stored privately in this profile’s workspace for Git and SSH access."
        action={
          <Button type="button" onClick={() => setCreating(true)}>
            <Plus size={16} /> Create SSH key
          </Button>
        }
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {keys.length ? (
        <div className="resource-list">
          {keys.map((key) => (
            <ResourceRow
              key={key.id}
              id={`ssh-key-${key.id}`}
              icon={<KeyRound size={20} strokeWidth={1.6} />}
              name={key.name}
              description={key.publicKey}
              badges={<Badge dot={false}>Ed25519</Badge>}
              facts={[key.fingerprint, `Created ${date(key.createdAt)}`]}
              actions={
                <>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Copy ${key.name}`}
                    onClick={() => void copy(key)}
                  >
                    {copied === key.id ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Delete ${key.name}`}
                    onClick={() => setRemoving(key)}
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              }
            />
          ))}
        </div>
      ) : (
        <Empty title="No SSH keys">Create one when this profile needs Git or SSH access.</Empty>
      )}
      {creating && (
        <Modal
          title="Create SSH key"
          description="The gateway creates an Ed25519 key and stores the private part in this profile’s workspace."
          close={() => setCreating(false)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button type="submit" form="create-ssh-key" busy={busy}>
                Create key
              </Button>
            </>
          }
        >
          <form id="create-ssh-key" onSubmit={create}>
            <Field label="Key name" hint="Use a label that tells you where this key is used.">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="GitHub"
                required
              />
            </Field>
          </form>
        </Modal>
      )}
      {created && (
        <Modal
          title={`${created.name} created`}
          description="Add this public key to the Git or SSH service that should trust this profile."
          close={() => setCreated(undefined)}
          footer={
            <Button
              type="button"
              onClick={async () => {
                await copy(created);
                setCreated(undefined);
              }}
            >
              <Copy size={16} /> Copy public key
            </Button>
          }
        >
          <textarea
            className="secret-textarea"
            value={created.publicKey}
            readOnly
            rows={4}
            aria-label="Public SSH key"
          />
        </Modal>
      )}
      {removing && (
        <Confirm
          title={`Delete ${removing.name}?`}
          description="This permanently removes the private key from the profile workspace."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (await mutate(() => api.deleteSshKey(profile.id, removing.id), 'SSH key deleted.')) {
              setKeys((current) => current.filter((key) => key.id !== removing.id));
              setRemoving(undefined);
            }
          }}
        />
      )}
    </>
  );
}
