import { scheduleInputSchema, schedulePatchSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { ApiChannel } from '../src/channels/api.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { listDeliveries } from '../src/channels/repository.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import { testServices } from './helpers/services.js';

const zone = 'America/Sao_Paulo';

it('treats blank cron as absent before validating the timing choice', () => {
  const base = {
    name: 'Reminder',
    instruction: 'Check the deployment.',
    sessionId: '00000000-0000-4000-8000-000000000001',
    timeZone: zone,
  };
  const at = '2026-10-01T08:00:00Z';

  for (const cron of ['', '   ']) {
    expect(scheduleInputSchema.parse({ ...base, at, cron }).cron).toBeUndefined();
    expect(schedulePatchSchema.parse({ at, cron }).cron).toBeUndefined();
    expect(scheduleInputSchema.safeParse({ ...base, cron }).success).toBe(false);
  }

  expect(scheduleInputSchema.safeParse({ ...base, at, cron: '0 8 * * *' }).success).toBe(false);
  expect(scheduleInputSchema.safeParse({ ...base, cron: 'invalid' }).success).toBe(false);
  expect(scheduleInputSchema.parse({ ...base, cron: ' 0 8 * * * ' }).cron).toBe('0 8 * * *');
});

/** A clock the test moves by hand, starting at 07:00 in São Paulo on 2026-09-24. */
async function setup() {
  let now = Date.parse('2026-09-24T07:00:00-03:00');
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({
    name: 'Owner',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const other = await services.profiles.createProfile({
    name: 'Other',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  await services.settings.update({ timeZone: zone });
  const channels = new Channels(
    services,
    async (url) =>
      String(url).endsWith('/getMe')
        ? Response.json({ ok: true, result: { id: 700, username: 'Bot' } })
        : Response.json({ ok: true, result: { total_count: 0, photos: [] } }),
    new ChannelRegistry([new ApiChannel(), new TelegramChannel()]),
  );
  const channel = await channels.connect(profile.id, {
    type: 'telegram',
    botToken: '123:synthetic-test-token',
  });

  await channels.receive(channel.id, {
    type: 'telegram',
    headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
    payload: { update_id: 1, message: { from: { id: 42 }, chat: { id: 42 }, text: 'Oi' } },
  });
  const [contact] = await channels.contacts(profile.id);

  if (!contact) throw new Error('Contact missing');
  const approved = await channels.approveContact(profile.id, contact.id);
  const chat = approved.sessionId ?? '';

  services.schedules.useDeliveries(channels);

  // The contact's first message is still being answered; a message into a busy chat joins
  // that turn instead of opening another, so the chat is left idle before any schedule runs.
  for (const run of await services.runs.activities(profile.id)) {
    await services.lifecycle.claim(run.id, profile.id, 'worker');
    await services.lifecycle.finish(profile.id, run.id, 'worker', 'completed', 'Oi.');
  }

  const api = await services.sessions.createSession(profile.id, { channel: 'api' });

  return {
    services,
    profile,
    other,
    chat,
    api: api.id,
    at: (iso: string) => {
      now = Date.parse(iso);
    },
    scheduledRuns: async () =>
      (await services.runs.activities(profile.id)).filter((run) =>
        run.input.startsWith('[Scheduled:'),
      ),
  };
}

describe('schedules', () => {
  it('runs a daily schedule at its time in the chat, delivers it, and waits for the next day', async () => {
    const f = await setup();
    const schedule = await f.services.schedules.create(
      f.profile.id,
      {
        name: 'Morning summary',
        instruction: 'Send me a summary of yesterday.',
        sessionId: f.chat,
        cron: '0 8 * * *',
        timeZone: zone,
      },
      'owner',
    );

    expect(schedule.nextRunAt).toBe('2026-09-24T11:00:00.000Z');

    f.at('2026-09-24T07:59:00-03:00');
    await f.services.schedules.fireDue();
    expect(await f.scheduledRuns()).toHaveLength(0);

    f.at('2026-09-24T08:00:10-03:00');
    await f.services.schedules.fireDue();
    await f.services.schedules.fireDue();

    const [run] = await f.scheduledRuns();

    expect(await f.scheduledRuns()).toHaveLength(1);
    expect(run?.sessionId).toBe(f.chat);
    expect(run?.input).toBe('[Scheduled: Morning summary] Send me a summary of yesterday.');
    // In a chat, the answer goes out on the channel.
    expect(
      (await listDeliveries(f.services.store.db, f.profile.id)).some(
        (delivery) => delivery.runId === run?.id,
      ),
    ).toBe(true);

    const [after] = await f.services.schedules.list(f.profile.id);

    expect(after).toMatchObject({ nextRunAt: '2026-09-25T11:00:00.000Z', lastRunId: run?.id });
  });

  it('runs a single time once and switches off, and catches up once after being down', async () => {
    const f = await setup();

    await f.services.schedules.create(
      f.profile.id,
      {
        name: 'Dentist',
        instruction: 'Remind me to call the dentist.',
        sessionId: f.chat,
        at: '2026-09-24T15:00:00-03:00',
        timeZone: zone,
      },
      'agent',
    );
    await f.services.schedules.create(
      f.profile.id,
      {
        name: 'Daily',
        instruction: 'Daily check.',
        sessionId: f.api,
        cron: '0 9 * * *',
        timeZone: zone,
      },
      'owner',
    );

    // Down for three days: each schedule runs once, then looks ahead from now.
    f.at('2026-09-27T12:00:00-03:00');
    await f.services.schedules.fireDue();

    expect(await f.scheduledRuns()).toHaveLength(2);

    const list = await f.services.schedules.list(f.profile.id);
    const once = list.find((item) => item.name === 'Dentist');
    const daily = list.find((item) => item.name === 'Daily');

    expect(once).toMatchObject({ enabled: false, createdBy: 'agent' });
    expect(once?.nextRunAt).toBeUndefined();
    expect(daily?.nextRunAt).toBe('2026-09-28T12:00:00.000Z');
  });

  it('refuses a past time, too frequent a repetition, and another profile’s conversation', async () => {
    const f = await setup();
    const base = { name: 'x', instruction: 'x', sessionId: f.chat, timeZone: zone };

    await expect(
      f.services.schedules.create(
        f.profile.id,
        { ...base, at: '2026-09-24T06:00:00-03:00' },
        'owner',
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.services.schedules.create(f.profile.id, { ...base, cron: '* * * * *' }, 'owner'),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.services.schedules.create(f.other.id, { ...base, cron: '0 8 * * *' }, 'owner'),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      f.services.schedules.create(
        f.profile.id,
        { ...base, cron: '0 8 * * *', at: '2026-10-01T08:00:00Z' },
        'owner',
      ),
    ).rejects.toThrow();
  });

  it('keeps thirty days of history, and forgets a single time a week after it ran', async () => {
    const f = await setup();
    const daily = await f.services.schedules.create(
      f.profile.id,
      { name: 'Daily', instruction: 'Check.', sessionId: f.api, cron: '0 9 * * *', timeZone: zone },
      'owner',
    );
    const once = await f.services.schedules.create(
      f.profile.id,
      {
        name: 'Once',
        instruction: 'Remind.',
        sessionId: f.chat,
        at: '2026-09-24T10:00:00-03:00',
        timeZone: zone,
      },
      'owner',
    );

    f.at('2026-09-24T10:00:30-03:00');
    await f.services.schedules.fireDue();
    await f.services.schedules.runNow(f.profile.id, daily.id);

    const history = await f.services.schedules.history(f.profile.id, daily.id);

    expect(history.map((entry) => entry.manual)).toEqual([true, false]);
    expect(history[0]?.status).toBe('queued');

    // Six days on, the single time is still listed as done; eight days on, it is gone.
    f.at('2026-09-30T10:00:00-03:00');
    await f.services.schedules.fireDue();
    expect(
      (await f.services.schedules.list(f.profile.id)).some((item) => item.id === once.id),
    ).toBe(true);
    f.at('2026-10-02T11:00:00-03:00');
    await f.services.schedules.fireDue();
    expect(
      (await f.services.schedules.list(f.profile.id)).some((item) => item.id === once.id),
    ).toBe(false);

    // Thirty-one days on, the first day's entry has aged out.
    f.at('2026-10-25T09:30:00-03:00');
    await f.services.schedules.fireDue();
    const later = await f.services.schedules.history(f.profile.id, daily.id);

    expect(later.some((entry) => entry.dueAt === '2026-09-24T12:00:00.000Z')).toBe(false);
  });

  it('tells the agent the time in the gateway’s zone', async () => {
    const f = await setup();
    const run = await f.services.runs.submit(f.profile.id, f.chat, {
      text: 'Oi de novo',
      requestKey: 't',
    });
    const system = (await f.services.contexts.context(run)).system;

    expect(system).toContain('Thursday, 24 September 2026 at 07:00 in America/Sao_Paulo');
  });
});
