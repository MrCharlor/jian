import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { ChannelParams, ContactParams, ProfileParams, SessionParams } from '../http/params.js';
import type { Channels } from './service.js';
import type { WhatsAppConnections } from './whatsapp/connections.js';

type ChannelRouteServices = {
  channels?: Channels;
  whatsapp?: WhatsAppConnections;
};

export function registerChannelRoutes(app: FastifyInstance, deps: ChannelRouteServices): void {
  function channels() {
    if (!deps.channels) {
      throw new GatewayError(503, 'Channels are not configured');
    }

    return deps.channels;
  }

  function linkedDevices() {
    if (!deps.whatsapp) {
      throw new GatewayError(503, 'WhatsApp connections are not configured');
    }

    return deps.whatsapp;
  }

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/channels', async (request, reply) =>
    reply.code(201).send(
      // HTTPS regardless of how the request arrived: Telegram accepts no other webhook, and
      // a TLS-terminating proxy keeps the host while dropping the scheme.
      await channels().connect(request.params.profileId, request.body, `https://${request.host}`),
    ),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/channels', async (request) =>
    channels().list(request.params.profileId),
  );

  app.delete<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId',
    async (request) => channels().revoke(request.params.profileId, request.params.channelId),
  );

  app.get('/v1/groups', async () => channels().groups());

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/deliveries', async (request) =>
    channels().deliveries(request.params.profileId),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/people',
    async (request) => channels().sessionPeople(request.params.profileId, request.params.sessionId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/contacts', async (request) =>
    channels().contacts(request.params.profileId),
  );

  app.post<{ Params: ContactParams }>(
    '/v1/profiles/:profileId/contacts/:contactId/approve',
    async (request) =>
      channels().approveContact(request.params.profileId, request.params.contactId),
  );

  app.put<{ Params: ContactParams }>(
    '/v1/profiles/:profileId/contacts/:contactId/owner',
    async (request) =>
      channels().setContactOwner(request.params.profileId, request.params.contactId, request.body),
  );

  app.post<{ Params: ContactParams }>(
    '/v1/profiles/:profileId/contacts/:contactId/block',
    async (request) => channels().blockContact(request.params.profileId, request.params.contactId),
  );

  app.post<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/connect',
    async (request, reply) =>
      reply
        .code(202)
        .send(await linkedDevices().connect(request.params.profileId, request.params.channelId)),
  );

  app.get<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/connection',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return linkedDevices().status(request.params.profileId, request.params.channelId);
    },
  );

  app.get<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/qr',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return linkedDevices().qr(request.params.profileId, request.params.channelId);
    },
  );

  app.post<{ Params: ChannelParams }>(
    '/v1/profiles/:profileId/channels/:channelId/disconnect',
    async (request, reply) =>
      reply
        .code(202)
        .send(await linkedDevices().disconnect(request.params.profileId, request.params.channelId)),
  );

  // A sender that can only post a line of text: the same intake as JSON, with the source as
  // the contact and the text and the minute as the request key, so a retried event is one turn.
  app.post<{ Params: { channelId: string }; Querystring: { source?: string } }>(
    '/v1/ingress/:channelId/text',
    async (request, reply) => {
      const text = String(request.body).trim();
      const source = request.query.source ?? 'webhook';
      const minute = Math.floor(Date.now() / 60_000);

      return reply.code(202).send(
        await channels().receive(request.params.channelId, {
          type: 'api',
          headers: request.headers,
          payload: {
            actorId: source,
            chatId: source,
            displayName: source,
            text,
            requestKey: createHash('sha256').update(`${minute}:${text}`).digest('hex').slice(0, 64),
          },
        }),
      );
    },
  );

  app.post<{ Params: { channelId: string } }>('/v1/ingress/:channelId', async (request, reply) =>
    reply.code(202).send(
      await channels().receive(request.params.channelId, {
        type: 'api',
        headers: request.headers,
        payload: request.body,
      }),
    ),
  );

  app.post<{ Params: { channelId: string } }>('/v1/telegram/:channelId', async (request) =>
    channels().receive(request.params.channelId, {
      type: 'telegram',
      headers: request.headers,
      payload: request.body,
    }),
  );
}
