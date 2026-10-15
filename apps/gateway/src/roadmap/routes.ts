import type { FastifyInstance } from 'fastify';
import type { Roadmap } from './service.js';

const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

export function registerRoadmapRoutes(app: FastifyInstance, deps: { roadmap: Roadmap }) {
  app.get('/v1/roadmap', async (request) => deps.roadmap.list(request.query));

  app.post('/v1/roadmap/items', async (request, reply) =>
    reply.code(201).send(await deps.roadmap.create(request.body)),
  );

  app.patch<{ Params: { itemId: string } }>('/v1/roadmap/items/:itemId', async (request) =>
    deps.roadmap.update(request.params.itemId, request.body),
  );

  app.post('/v1/roadmap/sync', async (request, reply) =>
    reply.code(202).send(await deps.roadmap.run(request.body ?? {})),
  );

  app.get('/v1/roadmap-proposals', async (request) => deps.roadmap.proposals(request.query));

  app.post<{ Params: { number: number } }>(
    '/v1/roadmap-proposals/:number/decide',
    async (request) =>
      deps.roadmap.decide(
        { number: Number(request.params.number) },
        request.body,
        via(request.headers),
      ),
  );

  app.get('/v1/roadmap-settings', async () => deps.roadmap.settings());

  app.put('/v1/roadmap-settings', async (request) => deps.roadmap.updateSettings(request.body));
}
