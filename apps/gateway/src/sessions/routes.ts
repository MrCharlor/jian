import type { FastifyInstance } from 'fastify';
import type { Coordination } from '../coordination/service.js';
import type { ProfileParams, SessionParams } from '../http/params.js';
import type { RunWriter } from '../runs/port.js';
import type { SessionWriter } from './port.js';
import type { Sessions } from './service.js';

type SessionRouteServices = {
  sessions: SessionWriter & Pick<Sessions, 'renameSession' | 'setModel' | 'overview' | 'timeline'>;
  runs: RunWriter;
  // History spans every message of a profile or a session, so it comes from coordination.
  coordination: Pick<Coordination, 'history'>;
};

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteServices): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/sessions', async (request) =>
    deps.sessions.overview(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/sessions', async (request, reply) =>
    reply.code(201).send(await deps.sessions.createSession(request.params.profileId, request.body)),
  );

  app.patch<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId',
    async (request) =>
      deps.sessions.renameSession(request.params.profileId, request.params.sessionId, request.body),
  );

  app.put<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/model',
    async (request) =>
      deps.sessions.setModel(request.params.profileId, request.params.sessionId, request.body),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/messages',
    async (request) => deps.sessions.messages(request.params.profileId, request.params.sessionId),
  );

  app.post<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/messages',
    async (request, reply) =>
      reply.code(202).send(
        await deps.runs.submit(request.params.profileId, request.params.sessionId, request.body, {
          ownerMessage: true,
        }),
      ),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/history',
    async (request) =>
      deps.coordination.history(request.params.profileId, request.params.sessionId, request.query),
  );

  app.get<{ Params: SessionParams }>(
    '/v1/profiles/:profileId/sessions/:sessionId/timeline',
    async (request) => deps.sessions.timeline(request.params.profileId, request.params.sessionId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/history', async (request) =>
    deps.coordination.history(request.params.profileId, undefined, request.query),
  );
}
