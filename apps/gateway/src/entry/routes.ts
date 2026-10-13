import type { FastifyInstance } from 'fastify';
import type { EntrySync } from './service.js';

export function registerEntrySyncRoutes(app: FastifyInstance, deps: { entrySync: EntrySync }) {
  // The author is the one set for the action, or Otto: the request carries no agent.
  app.post('/v1/entry-sync/run', async (request) => deps.entrySync.run(request.body));
}
