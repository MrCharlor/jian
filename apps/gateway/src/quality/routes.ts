import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Quality } from './service.js';

export function registerQualityRoutes(app: FastifyInstance, deps: { quality: Quality }) {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/corrections', async (request) =>
    deps.quality.corrections(request.params.profileId),
  );

  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/quality', async (request) =>
    deps.quality.report(request.params.profileId),
  );
}
