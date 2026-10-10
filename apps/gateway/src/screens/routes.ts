import type { FastifyInstance } from 'fastify';
import type { Screens } from './service.js';

type Params = { screenId: string };

/** Prints travel inline as base64, like a prototype's, so attaching them takes a larger body. */
const PRINTS_BODY_LIMIT = 50 * 1024 * 1024;

export function registerScreenRoutes(app: FastifyInstance, deps: { screens: Screens }) {
  app.get('/v1/screens', async (request) => deps.screens.list(request.query));

  app.post('/v1/screens/inventory', async (request) => deps.screens.saveInventory(request.body));

  app.get<{ Params: Params }>('/v1/screens/:screenId', async (request) =>
    deps.screens.get(request.params.screenId),
  );

  app.put<{ Params: Params }>('/v1/screens/:screenId/sheet', async (request) =>
    deps.screens.writeSheet(request.params.screenId, request.body),
  );

  app.post<{ Params: Params }>(
    '/v1/screens/:screenId/prints',
    { bodyLimit: PRINTS_BODY_LIMIT },
    async (request) => deps.screens.attachPrints(request.params.screenId, request.body),
  );

  app.get<{ Params: Params & { name: string } }>(
    '/v1/screens/:screenId/prints/:name',
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return deps.screens.print(request.params.screenId, request.params.name);
    },
  );

  app.post<{ Params: Params }>('/v1/screens/:screenId/review', async (request) =>
    deps.screens.review(request.params.screenId),
  );
}
