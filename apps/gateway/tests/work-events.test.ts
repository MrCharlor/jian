import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { listSessionMessages } from '../src/sessions/repository.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';

const input = {
  name: 'Otto',
  instructions: 'Operate the board.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A profile with an API channel, served over HTTP, and its owner's panel conversation. */
async function setup() {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const gateway = await services.sessions.gatewaySession(profile.id);
  const channels = new Channels(services, fetch);
  const app = createApp({ ...services, channels, token, logger: false });
  const channel = await channels.connect(profile.id, { type: 'api' });

  apps.push(app);

  const post = (text: string, source = 'vx-work') =>
    app.inject({
      method: 'POST',
      url: `/v1/ingress/${channel.id}/text?source=${source}`,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-jian-channel-token': channel.webhookToken ?? '',
      },
      payload: text,
    });

  /** The agent's turn ends the way the runtime would leave it. */
  const finish = async (runId: string, output: string) => {
    await services.store.db.execute(
      sql`update runs set status = 'completed', output = ${output} where id = ${runId}`,
    );
  };

  return { app, services, profile, gateway, channels, channel, post, finish };
}

describe('events posted as plain text', () => {
  it('reaches the agent as one contact, approved once, and a repeat is one turn', async () => {
    const { services, profile, channels, post, finish } = await setup();

    const first = await post('[VX Work] Pedido novo na Entrada da Sigma.\nCard: Teste');
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ accepted: false, contact: 'pending' });

    const [contact] = await channels.contacts(profile.id);
    expect(contact).toMatchObject({ actorId: 'vx-work', status: 'pending' });
    await channels.approveContact(profile.id, contact?.id ?? '');
    // The first event's turn ends before the next arrives; otherwise it would join that turn.
    const [opened] = await services.runs.recent(profile.id);
    await finish(opened?.id ?? '', '[silêncio]');

    const second = await post('[VX Work] Card mudou de coluna.');
    expect(second.json()).toMatchObject({ accepted: true, contact: 'approved' });
    const again = await post('[VX Work] Card mudou de coluna.');
    expect(again.json().runId).toBe(second.json().runId);

    const runs = await services.runs.recent(profile.id);
    expect(runs.map((run) => run.input)).toEqual(
      expect.arrayContaining([
        '[VX Work] Pedido novo na Entrada da Sigma.\nCard: Teste',
        '[VX Work] Card mudou de coluna.',
      ]),
    );
  });

  it('refuses a post without the channel token', async () => {
    const { app, channel } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/ingress/${channel.id}/text`,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('the answer to an event', () => {
  async function answered(output: string) {
    const f = await setup();

    await f.post('[VX Work] Pedido novo na Entrada da Sigma.\nCard: Teste');
    const [contact] = await f.channels.contacts(f.profile.id);
    await f.channels.approveContact(f.profile.id, contact?.id ?? '');
    const [run] = await f.services.runs.recent(f.profile.id);

    // Waiting for the run: nothing is forwarded yet.
    await f.channels.dispatch();
    expect(await listSessionMessages(f.services.store.db, f.gateway.id, 50)).toEqual([]);

    await f.finish(run?.id ?? '', output);
    await f.channels.dispatch();
    await f.channels.dispatch();

    return listSessionMessages(f.services.store.db, f.gateway.id, 50);
  }

  it('is forwarded once to the owner’s conversation, under the event’s first line', async () => {
    const messages = await answered('Proponho mover o card para Aprovado. #1 aguardando.');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content:
        '[VX Work] Pedido novo na Entrada da Sigma.\n\nProponho mover o card para Aprovado. #1 aguardando.',
    });
  });

  it('is not forwarded when the agent has nothing to say', async () => {
    expect(await answered('[silêncio]')).toEqual([]);
  });
});
