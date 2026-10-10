import type { FastifyInstance } from 'fastify';
import type { Drawings } from './service.js';

export function registerDrawingRoutes(app: FastifyInstance, deps: { drawings: Drawings }) {
  app.get('/v1/drawings', async () => deps.drawings.list());

  app.post('/v1/drawings', async (request, reply) =>
    reply.code(201).send(await deps.drawings.add(request.body)),
  );

  app.delete<{ Params: { drawingId: string } }>('/v1/drawings/:drawingId', async (request) =>
    deps.drawings.remove(request.params.drawingId),
  );
}
