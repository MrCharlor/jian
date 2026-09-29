import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Work } from './service.js';

type WorkParams = ProfileParams & { workId: string };

export function registerWorkRoutes(app: FastifyInstance, deps: { work: Work }) {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/work', async (request) =>
    deps.work.list(request.params.profileId),
  );

  app.get<{ Params: WorkParams }>('/v1/profiles/:profileId/work/:workId/history', async (request) =>
    deps.work.history(request.params.profileId, request.params.workId),
  );

  app.get<{ Params: WorkParams }>(
    '/v1/profiles/:profileId/work/:workId/executions',
    async (request) => deps.work.executions(request.params.profileId, request.params.workId),
  );
}
