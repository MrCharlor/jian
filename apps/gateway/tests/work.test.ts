import { expect, it } from 'vitest';
import { profileTools, restrictTaskWorkerTools } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { findMedia } from '../src/media/repository.js';
import { listUnreportedTaskWorkers } from '../src/runs/repository.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-test-token-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };

it('keeps durable work scoped to one profile, editable across runs, and versioned', async () => {
  const services = await testServices();
  const first = await services.profiles.createProfile({
    name: 'Agent A',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const second = await services.profiles.createProfile({ name: 'Agent B', instructions: 'Help.' });
  const chat = await services.sessions.createSession(first.id, { channel: 'api' });
  const otherChat = await services.sessions.createSession(second.id, { channel: 'api' });
  await expect(
    services.work.create(
      first.id,
      { title: 'Wrong chat', description: 'Should not cross profiles.' },
      otherChat.id,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  const run = await services.runs.submit(first.id, chat.id, {
    text: 'Track the work.',
    requestKey: 'work-test',
  });
  const tools = profileTools(services, run);
  const call = { toolCallId: 'work', messages: [], context: {} };
  const created = (await tools.create_task?.execute?.(
    { title: 'Prepare release', description: 'Verify the build and report the result.' },
    call,
  )) as { id: string; version: number; sourceSessionId: string; status: string };

  expect(created).toMatchObject({ sourceSessionId: chat.id, status: 'todo', version: 1 });
  expect(await services.work.list(first.id)).toHaveLength(1);
  expect(await services.work.list(second.id)).toEqual([]);
  await expect(
    services.work.update(second.id, created.id, { status: 'done', expectedVersion: 1 }),
  ).rejects.toMatchObject({ statusCode: 404 });

  const app = createApp({ ...services, token, logger: false });
  try {
    const listed = await app.inject({ url: `/v1/profiles/${first.id}/work`, headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toHaveLength(1);

    const manual = await app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${first.id}/work/${created.id}`,
      headers,
      payload: { status: 'review', note: 'Ready for owner review.', expectedVersion: 1 },
    });
    expect(manual.statusCode).toBe(404);

    const agentUpdate = await tools.update_task?.execute?.(
      { id: created.id, status: 'in_progress', note: 'Checks started.', expectedVersion: 1 },
      call,
    );
    expect(agentUpdate).toMatchObject({ status: 'in_progress', version: 2, updatedBy: 'agent' });
    await expect(
      services.work.update(first.id, created.id, { status: 'done', expectedVersion: 1 }),
    ).rejects.toMatchObject({ statusCode: 409 });
    const history = await app.inject({
      url: `/v1/profiles/${first.id}/work/${created.id}/history`,
      headers,
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject([
      { type: 'work.created', status: 'todo', note: '' },
      { type: 'work.updated', status: 'in_progress', note: 'Checks started.' },
    ]);
    const otherHistory = await app.inject({
      url: `/v1/profiles/${second.id}/work/${created.id}/history`,
      headers,
    });
    expect(otherHistory.statusCode).toBe(404);
    const otherList = await app.inject({ url: `/v1/profiles/${second.id}/work`, headers });
    expect(otherList.json()).toEqual([]);
  } finally {
    await app.close();
  }
});

it('spawns an isolated, idempotent task worker and enforces executor handoff', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Coordinator',
    instructions: 'Keep work safe.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const chat = await services.sessions.createSession(profile.id, { channel: 'api' });
  const principal = await services.runs.submit(profile.id, chat.id, {
    text: 'Coordinate the release.',
    requestKey: 'principal',
  });
  const image = await services.media.upload(profile.id, chat.id, {
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=',
  });
  const outsider = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const outsiderChat = await services.sessions.createSession(outsider.id, { channel: 'api' });
  const outsiderImage = await services.media.upload(outsider.id, outsiderChat.id, {
    mimeType: 'image/png',
    data: 'AA==',
  });
  await expect(
    services.work.create(
      profile.id,
      {
        title: 'Wrong image',
        description: 'Must stay isolated.',
        mediaIds: [outsiderImage.id],
      },
      chat.id,
    ),
  ).rejects.toMatchObject({ statusCode: 404 });
  const task = await services.work.create(
    profile.id,
    {
      title: 'Test release',
      description: 'Run checks and report.',
      mediaIds: [image.id],
    },
    chat.id,
  );
  expect(task.mediaIds).toHaveLength(1);
  expect(task.mediaIds[0]).not.toBe(image.id);
  const input = {
    taskId: task.id,
    role: 'execute' as const,
    name: 'Verifier',
    identity: 'You verify the release.',
    brief: 'Run the unit tests.',
  };
  const first = await services.work.spawn(principal, input, 'tool-call-1');
  const repeat = await services.work.spawn(principal, input, 'tool-call-1');
  expect(repeat.runId).toBe(first.runId);
  await expect(
    services.work.spawn(principal, { ...input, brief: 'Different work.' }, 'tool-call-1'),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect(await services.work.executions(profile.id, task.id)).toHaveLength(1);
  expect(
    (await services.sessions.overview(profile.id)).some((entry) => entry.id === first.sessionId),
  ).toBe(false);
  const worker = await services.runs.run(profile.id, first.runId);
  const workerTools = profileTools(services, worker);
  restrictTaskWorkerTools(workerTools);
  expect(Object.keys(workerTools)).toContain('update_task');
  for (const name of [
    'spawn_subagent',
    'create_task',
    'ask_agent',
    'list_sessions',
    'remember',
    'message_contact',
  ]) {
    expect(workerTools).not.toHaveProperty(name);
  }
  const copied = worker.input.match(/\[Attached media: ([0-9a-f-]{36})\]/)?.[1];
  expect(copied).toBeTruthy();
  expect((await findMedia(services.store.db, profile.id, copied ?? '')).sessionId).toBe(
    first.sessionId,
  );
  const context = await services.contexts.context(worker);
  expect(context.system).toContain('Verifier');
  expect(context.system).toContain('You verify the release.');
  expect(context.system).not.toContain('Coordinate the release.');
  await expect(
    services.runs.submit(profile.id, first.sessionId, { text: 'Intrude', requestKey: 'direct' }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    services.media.upload(profile.id, first.sessionId, {
      mimeType: 'image/png',
      data: 'AA==',
    }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(
    services.work.update(profile.id, task.id, { status: 'done', expectedVersion: 1 }, worker),
  ).rejects.toMatchObject({ statusCode: 403 });
  const handoff = await services.work.update(
    profile.id,
    task.id,
    {
      status: 'review',
      note: 'Tests passed.',
      expectedVersion: 1,
    },
    worker,
  );
  expect(handoff.status).toBe('review');
  const owner = 'test-worker-lease';
  await services.lifecycle.claim(first.runId, profile.id, owner);
  await services.lifecycle.finish(profile.id, first.runId, owner, 'completed', 'Tests passed.');
  expect(await listUnreportedTaskWorkers(services.store.db, 10)).toContainEqual({
    id: first.runId,
    profileId: profile.id,
  });
  await services.work.reportWorker(profile.id, first.runId);
  await services.work.reportWorker(profile.id, first.runId);
  expect(await listUnreportedTaskWorkers(services.store.db, 10)).toEqual([]);
  expect(
    (await services.sessions.messages(profile.id, chat.id)).filter((message) =>
      message.content.includes(`Task worker "Verifier"`),
    ),
  ).toHaveLength(1);
  await expect(services.work.spawn(worker, input, 'nested')).rejects.toMatchObject({
    statusCode: 403,
  });
  const reviewer = await services.work.spawn(
    principal,
    {
      ...input,
      role: 'review',
      name: 'Reviewer',
      brief: 'Verify and deliver.',
    },
    'tool-call-2',
  );
  expect(reviewer.role).toBe('review');
  expect(await services.work.executions(profile.id, task.id)).toHaveLength(2);
  await services.lifecycle.claim(reviewer.runId, profile.id, 'review-lease');
  await services.lifecycle.finish(
    profile.id,
    reviewer.runId,
    'review-lease',
    'failed',
    'Review failed.',
  );
  await services.work.reportWorker(profile.id, reviewer.runId);
  expect(
    (await services.sessions.messages(profile.id, chat.id)).some((message) =>
      message.content.includes('Review failed.'),
    ),
  ).toBe(true);
  const app = createApp({ ...services, token, logger: false });
  try {
    const response = await app.inject({
      url: `/v1/profiles/${profile.id}/work/${task.id}/executions`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
  } finally {
    await app.close();
  }
});
