import type { FastifyInstance } from 'fastify';
import type { Decisions } from './service.js';

export function registerDecisionRoutes(
  app: FastifyInstance,
  deps: { decisions: Pick<Decisions, 'status' | 'configure' | 'updateSettings' | 'remove'> },
): void {
  // The key goes in and never comes back out: the answer says only whether one is set.
  app.get('/v1/decisions', async () => deps.decisions.status());

  app.put('/v1/decisions', async (request) => deps.decisions.configure(request.body));

  app.patch('/v1/decisions', async (request) => deps.decisions.updateSettings(request.body));

  app.delete('/v1/decisions', async () => deps.decisions.remove());
}
