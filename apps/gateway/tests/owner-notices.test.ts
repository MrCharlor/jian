import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApiChannel } from '../src/channels/api.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { TelegramChannel } from '../src/channels/telegram.js';
import type { Generator } from '../src/prototypes/generator.js';
import { Prototypes } from '../src/prototypes/service.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
const text = (value: string) => Buffer.from(value, 'utf8');

/**
 * The profile with the Work, its Telegram bot, an owner contact (Ada, chat 99) and an approved
 * contact who is not the owner (Bob, chat 98), and a plan service with a Reviewer set.
 */
async function fixture(destination?: 'panel' | 'panel_and_channel') {
  const services = await testServices();
  const otto = await services.profiles.createProfile({
    name: 'Otto',
    instructions: 'Help.',
    model,
    mcpServers: [
      {
        name: 'work',
        transport: 'http',
        url: 'https://work.example/v1/mcp',
        auth: 'headers',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-key' }],
      },
    ],
  });
  const reviewer = await services.profiles.createProfile({
    name: 'Revisor',
    instructions: 'Review.',
    model,
  });
  const panel = await services.sessions.gatewaySession(otto.id);

  await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });
  await services.applications.put('erp', [{ path: 'project/README.md', data: text('# ERP') }]);
  const generator: Generator = async (folder) => {
    await writeFile(join(folder, 'prototipo.html'), '<!doctype html><p>tela</p>');
    return { ok: true };
  };
  const prototypes = new Prototypes(
    services.store,
    services.applications,
    services.quality,
    generator,
    await mkdtemp(join(tmpdir(), 'jian-owner-notices-')),
  );
  services.plans.useAgents(async () => {});
  services.plans.usePrototypes(prototypes);
  prototypes.usePlanner(services.plans);
  await services.plans.updateSettings('prototype', {
    reviewerProfileId: reviewer.id,
    automatic: false,
  });

  const sent: Array<{ chatId: string; text: string }> = [];
  const telegram: typeof fetch = async (url, options) => {
    if (String(url).endsWith('/getMe'))
      return Response.json({ ok: true, result: { id: 700, username: 'OttoBot' } });
    if (/\/(getUserProfilePhotos|getChat|getFile)$/.test(String(url)))
      return Response.json({ ok: true, result: { total_count: 0, photos: [] } });
    if (String(url).endsWith('/sendMessage')) {
      const body = JSON.parse(String(options?.body));
      sent.push({ chatId: String(body.chat_id), text: body.text });
    }
    return Response.json({ ok: true, result: { message_id: sent.length + 1 } });
  };
  const channels = new Channels(
    services,
    telegram,
    new ChannelRegistry([new ApiChannel(), new TelegramChannel()]),
  );
  services.ownerNotices.useChannels(channels);
  const channel = await channels.connect(otto.id, { type: 'telegram', botToken: '123:synthetic' });

  let update = 1;
  const say = (actor: number, words: string) =>
    channels.receive(channel.id, {
      type: 'telegram',
      headers: { 'x-telegram-bot-api-secret-token': channel.webhookToken },
      payload: {
        update_id: update++,
        message: {
          from: { id: actor, first_name: actor === 42 ? 'Ada' : 'Bob' },
          chat: { id: actor === 42 ? 99 : 98 },
          text: words,
        },
      },
    });

  // Both are let in; only Ada speaks for the owner. Their greetings are not what is tested.
  for (const actor of [42, 43]) await say(actor, 'Hello');
  for (const contact of await channels.contacts(otto.id)) {
    await channels.approveContact(otto.id, contact.id);
    if (contact.actorId === '42')
      await channels.setContactOwner(otto.id, contact.id, { owner: true });
  }
  for (const run of await services.runs.activities(otto.id))
    await services.runs.cancel(otto.id, run.id);
  await channels.dispatch();
  sent.length = 0;

  if (destination) await services.settings.update({ ownerNotices: destination });

  return { services, otto, reviewer, panel, prototypes, channels, sent, say };
}

/** A plan the Reviewer approved, waiting for the owner because the action is not automatic. */
async function waiting(context: Awaited<ReturnType<typeof fixture>>) {
  const { services, otto, reviewer, prototypes } = context;

  await prototypes.create(
    { application: 'erp', title: 'Cores', brief: 'Listagem das cores.' },
    { kind: 'owner', profileId: otto.id },
  );
  const [plan] = await services.plans.list();
  if (!plan) throw new Error('no plan was opened');

  await services.plans.write(plan.id, { text: 'Plano.' }, { profileId: otto.id });
  await services.plans.review(
    plan.id,
    { revised: 'Plano revisado.', findings: [], approved: true },
    { profileId: reviewer.id },
  );
  expect(await services.plans.get(plan.id)).toMatchObject({ state: 'aguardando_po' });

  return plan;
}

describe('notices to the owner', () => {
  it('reach the panel and the owner contact on Telegram, and nobody else', async () => {
    const context = await fixture();
    const plan = await waiting(context);

    const panelRuns = (await context.services.runs.activities(context.otto.id)).filter(
      (run) => run.sessionId === context.panel.id,
    );
    expect(panelRuns.map((run) => run.input)).toEqual([
      expect.stringContaining(`Plano #${plan.number} esperando você`),
    ]);

    await context.channels.dispatch();
    expect(context.sent).toEqual([
      {
        chatId: '99',
        text: expect.stringContaining(`Responda "ok plano ${plan.number}"`),
      },
    ]);
  });

  it('stay in the panel when the destination is the panel only', async () => {
    const context = await fixture('panel');
    const plan = await waiting(context);

    expect(
      (await context.services.runs.activities(context.otto.id)).some(
        (run) =>
          run.sessionId === context.panel.id &&
          run.input.includes(`Plano #${plan.number} esperando você`),
      ),
    ).toBe(true);

    await context.channels.dispatch();
    expect(context.sent).toEqual([]);
    expect(await context.services.settings.read()).toMatchObject({ ownerNotices: 'panel' });
  });

  it('are answered by the owner contact from the chat, and by no other contact', async () => {
    const context = await fixture();
    const plan = await waiting(context);

    const stranger = await context.say(43, `ok plano ${plan.number}`);
    expect(stranger).toMatchObject({ accepted: true });
    expect(await context.services.plans.get(plan.id)).toMatchObject({ state: 'aguardando_po' });
    const runs = await context.services.runs.activities(context.otto.id);
    const words = runs.find((run) => run.input === `ok plano ${plan.number}`);
    expect(words).toBeDefined();

    const owner = await context.say(42, `ok plano ${plan.number}`);
    expect(owner).toMatchObject({ accepted: true });
    expect(await context.services.plans.get(plan.id)).toMatchObject({
      state: 'executado',
      approvedBy: 'owner',
      decidedVia: 'channel',
    });
  });
});
