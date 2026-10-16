import type { FastifyInstance } from 'fastify';
import type { Inbox } from './service.js';

type Params = { number: number };

const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

export function registerInboxRoutes(app: FastifyInstance, deps: { inbox: Inbox }) {
  app.get('/v1/inbox', async () => deps.inbox.list());

  app.post<{ Params: Params }>('/v1/inbox/:number/decide', async (request) =>
    deps.inbox.decideOne(Number(request.params.number), request.body ?? {}, via(request.headers)),
  );
}
