'use client';

import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { AutonomyLevel, GatewayApi, Profile } from '../../lib/api';
import { useAutosave } from '../../lib/autosave';
import { useWorkspace } from '../../lib/workspace';
import { Button, Confirm, Field, Modal, SectionHeading } from '../ui';
import { AvatarField } from './avatar-field';

/** What each level lets the agent do, as the owner reads it beside the choice. */
const LEVELS: Array<{ value: AutonomyLevel; label: string }> = [
  { value: 1, label: '1 · Proposes; you do it' },
  { value: 2, label: '2 · Asks you first' },
  { value: 3, label: '3 · Does it and reports' },
];

const asLevel = (value: FormDataEntryValue | string | null): AutonomyLevel => {
  const level = Number(value);

  return level === 1 || level === 3 ? level : 2;
};

const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

export function NewProfileDialog({
  api,
  done,
  close,
}: {
  api: GatewayApi;
  done: (profile: Profile) => void;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal
      title="New agent"
      description="One identity for every conversation."
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="new-profile-form" busy={busy}>
            <Plus size={16} />
            Create agent
          </Button>
        </>
      }
    >
      <form
        id="new-profile-form"
        method="post"
        action="/ui/"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');

          const form = new FormData(event.currentTarget);

          try {
            done(
              await api.createProfile({
                name: String(form.get('name')),
                instructions: String(form.get('instructions')),
                avatar: String(form.get('avatar')) || null,
              }),
            );
          } catch (error) {
            setError(error instanceof Error ? error.message : 'The agent could not be created.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <AvatarField name="avatar" />
        <Field label="Name">
          <input name="name" required maxLength={100} placeholder="e.g. Personal assistant" />
        </Field>
        <Field
          label="Instructions"
          hint="Say what it is for, how it should sound and what it aims at."
        >
          <textarea
            name="instructions"
            rows={5}
            required
            maxLength={8000}
            placeholder="Help me organise my tasks and keep track of decisions."
          />
        </Field>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export function ProfileEditor({
  profile,
  api,
  busy,
}: {
  profile: Profile;
  api: GatewayApi;
  busy: boolean;
}) {
  const { deleteProfile, refresh } = useWorkspace();
  const [deleting, setDeleting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [working, setWorking] = useState(false);

  const reset = async () => {
    setWorking(true);

    try {
      const { sessions, memories } = await api.resetProfile(profile.id);

      toast.success(
        `${profile.name} forgot ${sessions === 1 ? '1 conversation' : `${sessions} conversations`} and ${
          memories === 1 ? '1 memory' : `${memories} memories`
        }.`,
      );
      setResetting(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not be reset.');
    } finally {
      setWorking(false);
    }
  };
  const form = useRef<HTMLFormElement>(null);
  // Exact actions the owner singled out from the level of their kind; rows are edited in place.
  const [overrides, setOverrides] = useState<Array<{ key: string; level: AutonomyLevel }>>(() =>
    Object.entries(profile.actionPolicy.tools).map(([key, level]) => ({ key, level })),
  );
  // Each save sends the version it read; the server's answer is the one the next save must send.
  const version = useRef(profile.version);
  const saved = useRef('');

  // The versions this form saved; any other arrived from elsewhere.
  const ours = useRef(new Set<number>());

  // Someone else saved meanwhile — the agent itself, with self-management — so the next save
  // starts from their version rather than failing on a stale one, and the fields show what
  // they wrote. The field being typed in is left alone: the owner's words win there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The version says when the rest changed.
  useEffect(() => {
    if (profile.version > version.current) version.current = profile.version;
    if (ours.current.has(profile.version)) return;

    const element = form.current;

    if (!element) return;

    const values: Record<string, string | boolean> = {
      name: profile.name,
      instructions: [
        profile.instructions,
        profile.identity.role && `Role: ${profile.identity.role}`,
        profile.identity.tone && `Tone: ${profile.identity.tone}`,
        ...profile.identity.goals.map((goal) => `Goal: ${goal}`),
      ]
        .filter(Boolean)
        .join('\n\n'),
      summary: profile.summary ?? '',
      boundaries: profile.identity.boundaries.join('\n'),
      selfManagement: profile.allowSelfManagement,
      shell: profile.allowShell,
      webSearch: profile.allowWebSearch,
      learn: profile.learnFromWork,
      agents: profile.reachableByAgents,
      autonomyMachine: String(profile.actionPolicy.machine),
      autonomyService: String(profile.actionPolicy.service),
      autonomyMessage: String(profile.actionPolicy.message),
    };

    for (const [name, value] of Object.entries(values)) {
      const field = element.elements.namedItem(name);

      if (
        !(
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement ||
          field instanceof HTMLSelectElement
        )
      )
        continue;
      if (field === document.activeElement) continue;
      if (typeof value === 'boolean' && field instanceof HTMLInputElement) field.checked = value;
      else if (typeof value === 'string') field.value = value;
    }

    setOverrides(
      Object.entries(profile.actionPolicy.tools).map(([key, level]) => ({ key, level })),
    );
  }, [profile.version]);

  const { schedule, flush } = useAutosave(async () => {
    const element = form.current;

    // An empty name or instructions is a field being rewritten, not a profile to save.
    if (!element?.checkValidity()) {
      return;
    }

    const data = new FormData(element);
    const patch = {
      name: String(data.get('name')),
      instructions: String(data.get('instructions')),
      summary: String(data.get('summary')),
      avatar: String(data.get('avatar')) || null,
      identity: {
        role: '',
        tone: '',
        goals: [] as string[],
        boundaries: lines(String(data.get('boundaries'))),
      },
      allowSelfManagement: data.get('selfManagement') === 'on',
      allowShell: data.get('shell') === 'on',
      allowWebSearch: data.get('webSearch') === 'on',
      learnFromWork: data.get('learn') === 'on',
      reachableByAgents: data.get('agents') === 'on',
      actionPolicy: {
        machine: asLevel(data.get('autonomyMachine')),
        service: asLevel(data.get('autonomyService')),
        message: asLevel(data.get('autonomyMessage')),
        tools: Object.fromEntries(
          data
            .getAll('overrideKey')
            .map((key, index) => [
              String(key).trim(),
              asLevel(data.getAll('overrideLevel')[index] ?? null),
            ])
            .filter(([key]) => /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,239}$/.test(String(key))),
        ),
      },
    };
    const snapshot = JSON.stringify(patch);

    if (snapshot === saved.current) {
      return;
    }

    try {
      const updated = await api.updateProfile(profile.id, {
        ...patch,
        expectedVersion: version.current,
      });

      version.current = updated.version;
      ours.current.add(updated.version);
      saved.current = snapshot;
      toast.success('Agent saved.', { id: 'profile-autosave' });
      void refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The agent could not be saved.', {
        id: 'profile-autosave',
      });
    }
  });

  const legacyIdentity = [
    profile.identity.role && `Role: ${profile.identity.role}`,
    profile.identity.tone && `Tone: ${profile.identity.tone}`,
    ...profile.identity.goals.map((goal) => `Goal: ${goal}`),
  ].filter(Boolean);
  const instructions = [profile.instructions, ...legacyIdentity].join('\n\n');

  return (
    <>
      <SectionHeading
        title="Identity"
        description="Instructions shared by every session of this agent."
      />
      <form
        ref={form}
        className="profile-form"
        method="post"
        action="/ui/"
        onSubmit={(event) => {
          event.preventDefault();
          void flush();
        }}
        onChange={(event) => {
          // A switch is a decision made; text is still being typed.
          const { type } = event.target as { type?: string };

          schedule(type === 'checkbox' ? 0 : undefined);
        }}
      >
        <div className="identity-form">
          <div className="settings-fields">
            <AvatarField
              name="avatar"
              profileName={profile.name}
              current={profile.avatar}
              onChange={() => schedule(0)}
            />
            <Field label="Name">
              <input name="name" defaultValue={profile.name} required maxLength={100} />
            </Field>
            <Field label="Instructions">
              <textarea
                name="instructions"
                defaultValue={instructions}
                rows={8}
                required
                maxLength={8000}
              />
            </Field>
            <Field
              label="Summary for the team"
              hint="One line on what this agent does. It is all the other agents ever see of it."
            >
              <input
                name="summary"
                defaultValue={profile.summary}
                maxLength={280}
                placeholder="e.g. Looks after deliveries and knows where each one stands."
              />
            </Field>
            <Field label="Boundaries" hint="Rules this agent must respect, one per line.">
              <textarea
                name="boundaries"
                defaultValue={profile.identity.boundaries.join('\n')}
                rows={3}
              />
            </Field>
            <label className="check-row">
              <input name="agents" type="checkbox" defaultChecked={profile.reachableByAgents} />
              <span>
                <strong>Talk with other agents</strong>
                <small>
                  Other agents can find this one and ask it things, and it can ask them. Off, it
                  leaves their list and loses contact with all of them.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input
                name="selfManagement"
                type="checkbox"
                defaultChecked={profile.allowSelfManagement}
              />
              <span>
                <strong>Allow self-management</strong>
                <small>
                  The agent may rewrite its own identity and skills. Providers and permissions stay
                  yours.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input name="shell" type="checkbox" defaultChecked={profile.allowShell} />
              <span>
                <strong>Allow the terminal and files</strong>
                <small>
                  The agent may read files, write files and run commands on this machine, with the
                  privileges of whoever started the gateway. This holds over WhatsApp and Telegram
                  too: any approved contact gains that path.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input name="webSearch" type="checkbox" defaultChecked={profile.allowWebSearch} />
              <span>
                <strong>Allow web search</strong>
                <small>
                  The agent may search the internet and read public pages, through the search key
                  under Providers. Pages are written by strangers and can try to steer it.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input name="learn" type="checkbox" defaultChecked={profile.learnFromWork} />
              <span>
                <strong>Learn from its work</strong>
                <small>
                  After a long turn, an error it recovered from, or every fifteen turns, the agent
                  looks back and keeps what helps as a skill or a memory. What it kept, and why, is
                  under Chats › Learning.
                </small>
              </span>
            </label>
          </div>
          <div className="settings-fields autonomy-fields">
            <h3>Autonomy</h3>
            <p className="note">
              How far the agent goes on its own, by where an action lands. Level 2 stops under
              Approvals; lower a level until the agent has earned it.
            </p>
            <Field label="On this machine" hint="Commands, and files it writes or edits.">
              <select name="autonomyMachine" defaultValue={String(profile.actionPolicy.machine)}>
                {LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="In connected services"
              hint="Any MCP tool its server does not declare read-only."
            >
              <select name="autonomyService" defaultValue={String(profile.actionPolicy.service)}>
                {LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="To other people and agents"
              hint="Messages, files it sends, questions to contacts."
            >
              <select name="autonomyMessage" defaultValue={String(profile.actionPolicy.message)}>
                {LEVELS.map((level) => (
                  <option key={level.value} value={level.value}>
                    {level.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Exact actions"
              hint="The tool's own name, or server.tool for a connected server, with its own level."
            >
              <div className="override-rows">
                {overrides.map((row, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until a key is typed.
                  <div className="override-row" key={index}>
                    <input
                      name="overrideKey"
                      aria-label={`Action ${index + 1}`}
                      placeholder="vx_work.vx_comment"
                      value={row.key}
                      maxLength={240}
                      onChange={(event) =>
                        setOverrides((current) =>
                          current.map((item, at) =>
                            at === index ? { ...item, key: event.target.value } : item,
                          ),
                        )
                      }
                    />
                    <select
                      name="overrideLevel"
                      aria-label={`Level of action ${index + 1}`}
                      value={row.level}
                      onChange={(event) =>
                        setOverrides((current) =>
                          current.map((item, at) =>
                            at === index ? { ...item, level: asLevel(event.target.value) } : item,
                          ),
                        )
                      }
                    >
                      {LEVELS.map((level) => (
                        <option key={level.value} value={level.value}>
                          {level.label}
                        </option>
                      ))}
                    </select>
                    <Button
                      variant="quiet"
                      aria-label={`Remove action ${index + 1}`}
                      onClick={() => {
                        setOverrides((current) => current.filter((_, at) => at !== index));
                        schedule(0);
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="quiet"
                  onClick={() => setOverrides((current) => [...current, { key: '', level: 2 }])}
                >
                  <Plus size={16} />
                  Add an action
                </Button>
              </div>
            </Field>
          </div>
        </div>
      </form>

      <section className="danger-zone reset" aria-labelledby="reset-zone">
        <div className="grow">
          <h2 id="reset-zone">Reset this agent</h2>
          <p>
            It forgets every conversation, memory and past activity. Its instructions, skills, MCP
            servers, model defaults, channels and contacts stay.
          </p>
        </div>
        <Button variant="secondary" disabled={busy || working} onClick={() => setResetting(true)}>
          <RotateCcw size={16} />
          Reset agent
        </Button>
      </section>
      <section className="danger-zone" aria-labelledby="danger-zone">
        <div className="grow">
          <h2 id="danger-zone">Delete this agent</h2>
          <p>
            Every session, memory, message, channel, contact and run it has held goes with it. There
            is no undo.
          </p>
        </div>
        <Button variant="danger" disabled={busy} onClick={() => setDeleting(true)}>
          <Trash2 size={16} />
          Delete agent
        </Button>
      </section>

      {resetting && (
        <Confirm
          title={`Reset ${profile.name}?`}
          description="Every conversation, memory and past activity of this agent is erased. Its configuration, channels and contacts are kept. This cannot be undone."
          busy={working}
          phrase={profile.name}
          close={() => setResetting(false)}
          confirm={() => void reset()}
        />
      )}
      {deleting && (
        <Confirm
          title={`Delete ${profile.name}?`}
          description="Every memory, chat history, message, channel connection, contact and run tied to this agent is deleted along with it. This cannot be undone."
          busy={busy}
          phrase={profile.name}
          close={() => setDeleting(false)}
          confirm={async () => {
            if (await deleteProfile(profile.id)) {
              setDeleting(false);
            }
          }}
        />
      )}
    </>
  );
}
