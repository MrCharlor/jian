import SwaggerParser from '@apidevtools/swagger-parser';
import { createOpenAPI, operations } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const admin = { authorization: `Bearer ${token}` };

async function setup() {
  const services = await testServices();

  const channels = new Channels(services, async () => {
    throw new Error('Network forbidden in test');
  });

  const app = createApp({ ...services, channels, token, logger: false });

  await app.ready();

  const profile = await services.profiles.createProfile({
    name: 'P',
    instructions: 'Help',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  return { app, services, profile };
}

/** A path every parameter of which is filled in, so only authentication decides the answer. */
function address(path: string, profileId: string) {
  return path
    .replace(':profileId', profileId)
    .replace(':memoryKey', 'sample')
    .replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000002');
}

describe('public API contracts', () => {
  it('exports valid OpenAPI and unique operation IDs', async () => {
    const schema = createOpenAPI();

    await SwaggerParser.validate(JSON.parse(JSON.stringify(schema)));

    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(
      operations.length,
    );
  });

  it('answers every administrative route only to the host token', async () => {
    const { app, profile } = await setup();
    const administrative = operations.filter((operation) => operation.access === 'admin');

    try {
      expect(administrative.length).toBeGreaterThan(20);

      for (const operation of administrative) {
        const request = {
          method: operation.method,
          url: address(operation.path, profile.id),
          ...(operation.body ? { payload: {} } : {}),
        };

        const anonymous = await app.inject(request);
        const wrong = await app.inject({
          ...request,
          headers: { authorization: `Bearer ${token}-wrong` },
        });
        expect([operation.operationId, anonymous.statusCode]).toEqual([operation.operationId, 401]);
        expect([operation.operationId, wrong.statusCode]).toEqual([operation.operationId, 401]);

        // An event stream answers by staying open, so only its refusals are injectable.
        if (operation.stream) {
          continue;
        }

        const authorized = await app.inject({ ...request, headers: admin });

        expect([operation.operationId, authorized.statusCode]).not.toEqual([
          operation.operationId,
          401,
        ]);
      }

      // Liveness, the sign-in that verifies the token itself, and the OAuth redirect — which
      // a browser cannot give a header and which proves itself with a state this gateway wrote.
      expect(
        operations
          .filter((operation) => operation.access === 'public')
          .map((operation) => operation.operationId),
      ).toEqual(['health', 'startPanelSession', 'completeMcpLogin']);
    } finally {
      await app.close();
    }
  });

  it('does not expose provider secrets or worker snapshots in public responses', async () => {
    const { app, profile } = await setup();

    try {
      const prefix = `/v1/profiles/${profile.id}`;

      const provider = await app.inject({
        method: 'POST',
        url: '/v1/providers',
        headers: admin,
        payload: {
          name: 'OpenAI',
          kind: 'openai',
          secret: 'synthetic-secret',
        },
      });

      expect(provider.statusCode).toBe(201);
      expect(provider.body).not.toContain('synthetic-secret');
      expect(provider.body).not.toContain('ciphertext');

      const session = await app.inject({
        method: 'POST',
        url: `${prefix}/sessions`,
        headers: admin,
        payload: { title: 'Test' },
      });

      const run = await app.inject({
        method: 'POST',
        url: `${prefix}/sessions/${session.json().id}/messages`,
        headers: admin,
        payload: { text: 'hi', requestKey: 'one' },
      });

      expect(run.statusCode).toBe(202);
      expect(run.json()).not.toHaveProperty('profile');
      expect(run.json()).not.toHaveProperty('leaseOwner');

      expect(
        (await app.inject({ url: `${prefix}/history?limit=5000`, headers: admin })).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('validates ingress with its binding token and holds an unknown sender for approval', async () => {
    const { app, services, profile } = await setup();

    try {
      const created = await app.inject({
        method: 'POST',
        url: `/v1/profiles/${profile.id}/channels`,
        headers: admin,
        payload: { type: 'api' },
      });

      expect(created.statusCode).toBe(201);

      const binding = created.json();
      const url = `/v1/ingress/${binding.id}`;
      const payload = { actorId: 'owner', chatId: 'chat', text: 'hi', requestKey: 'one' };

      expect((await app.inject({ method: 'POST', url, headers: admin, payload })).statusCode).toBe(
        401,
      );

      const headers = { 'x-jian-channel-token': binding.webhookToken };
      const held = await app.inject({ method: 'POST', url, headers, payload });

      expect(held.statusCode).toBe(202);
      expect(held.json()).toEqual({ accepted: false, contact: 'pending' });
      expect(await services.sessions.sessions(profile.id)).toEqual([]);

      const contacts = await app.inject({
        url: `/v1/profiles/${profile.id}/contacts`,
        headers: admin,
      });

      expect(contacts.statusCode).toBe(200);
      expect(contacts.json()).toHaveLength(1);

      const approved = await app.inject({
        method: 'POST',
        url: `/v1/profiles/${profile.id}/contacts/${contacts.json()[0].id}/approve`,
        headers: admin,
      });

      expect(approved.statusCode).toBe(200);
      expect(approved.json().status).toBe('approved');

      const runs = await services.runs.activities(profile.id);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.input).toBe('hi');

      // The caller may redeliver what the owner already approved; it reaches the same run.
      const again = await app.inject({ method: 'POST', url, headers, payload });

      expect(again.statusCode).toBe(202);
      expect(again.json()).toEqual({ accepted: true, runId: runs[0]?.id, contact: 'approved' });
      expect(await services.runs.activities(profile.id)).toHaveLength(1);

      const deliveries = await app.inject({
        method: 'GET',
        url: `/v1/profiles/${profile.id}/deliveries`,
        headers: admin,
      });

      // An API caller is not answered; the one delivery is how the answer reaches the owner.
      expect(deliveries.statusCode).toBe(200);
      expect(deliveries.json()).toMatchObject([{ runId: runs[0]?.id, status: 'pending' }]);

      const wrongProtocol = await app.inject({
        method: 'POST',
        url: `/v1/telegram/${binding.id}`,
        headers: { 'x-telegram-bot-api-secret-token': binding.webhookToken },
        payload: { update_id: 1 },
      });

      expect(wrongProtocol.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

it('rejects embedded URL credentials before they can be stored in profile configuration', async () => {
  const { app, profile } = await setup();

  try {
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/profiles/${profile.id}`,
      headers: admin,
      payload: {
        expectedVersion: 1,
        model: { ...profile.model, baseURL: 'https://owner:synthetic-password@example.com/v1' },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('synthetic-password');
  } finally {
    await app.close();
  }
});
