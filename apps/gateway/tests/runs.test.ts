import { afterEach, expect, it, vi } from 'vitest';
import { testServices } from './helpers/services.js';

const profileInput = {
  name: 'Atlas',
  instructions: 'Help with engineering.',
  model: { provider: 'openai' as const, modelId: 'test-model', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

afterEach(() => vi.unstubAllEnvs());

async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(profileInput);
  const session = await services.sessions.createSession(profile.id, {
    title: 'Mac',
    channel: 'macos',
  });

  return { services, profile, session };
}

it('runs on a host provider credential without registering a provider by hand', async () => {
  vi.stubEnv('ANTHROPIC_API_TOKEN', 'synthetic-anthropic-token');
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Host', instructions: 'Help.' });
  const providers = await services.providers.providers();
  const anthropic = providers.find((provider) => provider.kind === 'anthropic');

  expect(anthropic?.apiKeyEnv).toBe('ANTHROPIC_API_TOKEN');
  expect(JSON.stringify(providers)).not.toContain('synthetic-anthropic-token');

  const session = await services.sessions.createSession(profile.id, { title: 'Test' });

  // Which models that key can call is the provider's answer, so a run needs a chosen one.
  await expect(
    services.runs.submit(profile.id, session.id, { text: 'Hello', requestKey: 'unchosen' }),
  ).rejects.toMatchObject({ statusCode: 409 });

  await services.providers.setModelDefaults(profile.id, {
    conversation: {
      providerId: anthropic?.id ?? '',
      modelId: 'claude-sonnet-4-5',
      reasoningEffort: 'low',
    },
  });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'host-provider',
  });

  expect(run.model).toMatchObject({
    provider: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_TOKEN',
    reasoningEffort: 'low',
  });
});

it('replaces one provider key and refuses the model default left behind', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Replace', instructions: 'Help.' });
  const add = (name: string) =>
    services.providers.createProvider({
      name,
      kind: 'openai',
      secret: `synthetic-${name}`,
    });
  const old = await add('old');
  await services.providers.setModelDefaults(profile.id, {
    conversation: { providerId: old.id, modelId: 'gpt-4.1' },
  });
  const current = await add('current');
  const session = await services.sessions.createSession(profile.id, { title: 'Test' });

  // The replaced provider is revoked, so the default pointing at it must not start a run
  // against a key the owner already took away.
  await expect(
    services.runs.submit(profile.id, session.id, { text: 'Hello', requestKey: 'stale' }),
  ).rejects.toMatchObject({ statusCode: 409 });

  await services.providers.setModelDefaults(profile.id, {
    conversation: { providerId: current.id, modelId: 'gpt-4.1' },
  });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'new',
  });

  expect(run.model?.providerId).toBe(current.id);
  expect(
    (await services.providers.providers()).find((item) => item.id === old.id)?.revokedAt,
  ).toBeDefined();
  expect(
    (await services.providers.providers()).find((item) => item.id === current.id)?.revokedAt,
  ).toBeUndefined();
});

it('freezes the chosen model and its context budget per run', async () => {
  const { services, profile, session } = await setup();
  const provider = await services.providers.createProvider({
    name: 'Personal',
    kind: 'openai',
    secret: 'synthetic-api-key',
  });
  // Catalogued on the left, absent from the capability table on the right: the uncatalogued
  // model stays selectable and is simply held to the conservative floor.
  const large = { providerId: provider.id, modelId: 'gpt-4.1-mini' };
  const small = { providerId: provider.id, modelId: 'internal-preview' };

  await services.providers.setModelDefaults(profile.id, { conversation: small, channel: large });

  const chosen = await services.runs.submit(profile.id, session.id, {
    text: 'First',
    requestKey: 'one',
    model: large,
  });
  const otherSession = await services.sessions.createSession(profile.id, { title: 'Second' });
  const standard = await services.runs.submit(profile.id, otherSession.id, {
    text: 'Second',
    requestKey: 'two',
  });

  expect(chosen.model?.modelId).toBe('gpt-4.1-mini');
  expect(chosen.contextPolicy?.inputTokens).toBe(128_000);
  expect(chosen.contextPolicy?.maxSteps).toBe(500);
  expect(standard.model?.modelId).toBe('internal-preview');
  // Uncatalogued, so it runs on the floor rather than on a ceiling nobody stated — never
  // above what a model whose window is known would get.
  expect(standard.contextPolicy?.inputTokens).toBeLessThanOrEqual(128_000);
  expect(standard.contextPolicy?.maxSteps).toBe(500);
  expect(JSON.stringify(chosen)).not.toContain('synthetic-api-key');

  await expect(
    services.runs.submit(profile.id, session.id, {
      text: 'First',
      requestKey: 'one',
      model: small,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });

  // A credential belongs to the installation, so a second profile chooses the same one.
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });

  await expect(
    services.providers.setModelDefaults(other.id, { conversation: large }),
  ).resolves.toMatchObject({ profileId: other.id });

  await services.providers.revokeProvider(provider.id);

  // A session with nothing in flight: one that is busy takes the message as a correction.
  const third = await services.sessions.createSession(profile.id, { title: 'Third' });

  await expect(
    services.runs.submit(profile.id, third.id, {
      text: 'Third',
      requestKey: 'three',
      model: large,
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('runs one conversation on its own model and leaves the others on the defaults', async () => {
  const { services, profile, session } = await setup();
  const provider = await services.providers.createProvider({
    name: 'Personal',
    kind: 'openai',
    secret: 'synthetic-api-key',
  });
  const own = { providerId: provider.id, modelId: 'gpt-4.1-mini', reasoningEffort: 'low' as const };

  await services.providers.setModelDefaults(profile.id, {
    conversation: { providerId: provider.id, modelId: 'gpt-4.1' },
  });
  await services.sessions.setModel(profile.id, session.id, { model: own });
  const other = await services.sessions.createSession(profile.id, { title: 'Other' });

  const mine = await services.runs.submit(profile.id, session.id, { text: 'A', requestKey: 'a' });
  const theirs = await services.runs.submit(profile.id, other.id, { text: 'B', requestKey: 'b' });

  expect(mine.modelSelection).toEqual(own);
  expect(theirs.model?.modelId).toBe('gpt-4.1');

  const after = await services.sessions.createSession(profile.id, { title: 'Reset' });

  await services.sessions.setModel(profile.id, after.id, { model: own });
  await services.sessions.setModel(profile.id, after.id, { model: null });

  const reset = await services.runs.submit(profile.id, after.id, { text: 'C', requestKey: 'c' });

  expect(reset.model?.modelId).toBe('gpt-4.1');
  expect((await services.sessions.session(profile.id, after.id)).model).toBeUndefined();
});

it('commits one run and message for concurrent duplicate submissions', async () => {
  const { services, profile, session } = await setup();

  const [a, b] = await Promise.all([
    services.runs.submit(profile.id, session.id, { text: 'Deploy', requestKey: 'same' }),
    services.runs.submit(profile.id, session.id, { text: 'Deploy', requestKey: 'same' }),
  ]);

  expect(a.id).toBe(b.id);
  expect(await services.sessions.messages(profile.id, session.id)).toHaveLength(1);

  await expect(
    services.runs.submit(profile.id, session.id, { text: 'Different', requestKey: 'same' }),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('takes a message sent mid-run as a correction to that run', async () => {
  const { services, profile, session } = await setup();

  const first = await services.runs.submit(profile.id, session.id, {
    text: 'Pergunta ao Moabe se o deploy pode sair',
    requestKey: 'one',
  });

  await services.lifecycle.claim(first.id, profile.id, 'worker');

  const again = await services.runs.submit(profile.id, session.id, {
    text: 'Na verdade, esquece o Moabe',
    requestKey: 'two',
  });

  // The same run, not a second one waiting behind it.
  expect(again.id).toBe(first.id);
  expect(await services.runs.activities(profile.id)).toHaveLength(1);

  // It is in the history as the person's own turn, and reaches the run exactly once.
  const history = await services.sessions.messages(profile.id, session.id);

  expect(history.map((message) => message.content)).toContain('Na verdade, esquece o Moabe');
  expect(await services.lifecycle.steer(first.id, 'worker')).toBe('Na verdade, esquece o Moabe');
  expect(await services.lifecycle.steer(first.id, 'worker')).toBeNull();
});

it('keeps every correction when two arrive before the run reads them', async () => {
  const { services, profile, session } = await setup();

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Começa',
    requestKey: 'one',
  });

  await services.lifecycle.claim(run.id, profile.id, 'worker');
  await services.runs.submit(profile.id, session.id, { text: 'Primeira', requestKey: 'a' });
  await services.runs.submit(profile.id, session.id, { text: 'Segunda', requestKey: 'b' });

  expect(await services.lifecycle.steer(run.id, 'worker')).toBe('Primeira\n\nSegunda');
});

it('pins model configuration for queued runs', async () => {
  const { services, profile, session } = await setup();
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'a',
  });

  await services.profiles.updateProfile(profile.id, {
    expectedVersion: 1,
    model: { ...profileInput.model, modelId: 'changed-model' },
  });

  expect((await services.runs.run(profile.id, run.id)).profile.model.modelId).toBe('test-model');
});

it('lets only one worker claim a run and rejects stale completion', async () => {
  const { services, profile, session } = await setup();
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'a',
  });

  const claims = await Promise.all([
    services.lifecycle.claim(run.id, profile.id, 'one'),
    services.lifecycle.claim(run.id, profile.id, 'two'),
  ]);

  expect(claims.filter(Boolean)).toHaveLength(1);

  await expect(
    services.lifecycle.finish(profile.id, run.id, 'wrong', 'completed', 'Hello'),
  ).rejects.toMatchObject({ statusCode: 409 });

  expect((await services.runs.run(profile.id, run.id)).status).toBe('running');
});

it('marks expired leases interrupted without replaying uncertain work', async () => {
  let now = Date.now();
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile(profileInput);
  const session = await services.sessions.createSession(profile.id, {
    title: 'Test',
    channel: 'api',
  });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'a',
  });

  await services.lifecycle.claim(run.id, profile.id, 'one');
  now += 120_000;
  await services.lifecycle.recover();
  expect((await services.runs.run(profile.id, run.id)).status).toBe('interrupted');
  expect(await services.lifecycle.claim(run.id, profile.id, 'two')).toBeNull();
  expect(await services.sessions.messages(profile.id, session.id)).toHaveLength(1);

  await expect(
    services.lifecycle.finish(profile.id, run.id, 'one', 'completed', 'Late'),
  ).rejects.toMatchObject({ statusCode: 409 });
});

it('continues only reconciled stopped runs and preserves checkpoints without replaying tools', async () => {
  const { services, profile, session } = await setup();

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Deploy',
    requestKey: 'initial',
  });

  await services.lifecycle.claim(run.id, profile.id, 'worker');

  await services.lifecycle.checkpoint(profile.id, run.id, 'worker', {
    phase: 'tool-started',
    toolCallId: 'one',
    toolName: 'deploy',
  });

  await expect(
    services.runs.continueRun(profile.id, run.id, {
      text: 'Continue',
      requestKey: 'next',
      reconciliation: 'Checked effects',
    }),
  ).rejects.toThrow();

  await services.lifecycle.finish(profile.id, run.id, 'worker', 'interrupted', 'Connection ended');

  await expect(
    services.runs.continueRun(profile.id, run.id, { text: 'Continue', requestKey: 'next' }),
  ).rejects.toThrow();

  const next = await services.runs.continueRun(profile.id, run.id, {
    text: 'Continue',
    requestKey: 'next',
    reconciliation: 'Deployment completed; only verify status.',
  });

  expect(next.continuationOf).toBe(run.id);
  expect(next.status).toBe('queued');
  expect(await services.lifecycle.checkpoints(profile.id, run.id)).toHaveLength(1);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('interrupted');
});
