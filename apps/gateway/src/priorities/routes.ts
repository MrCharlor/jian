import type { FastifyInstance } from 'fastify';
import type { Priorities } from './service.js';

type ProposalParams = { proposalId: string };

export function registerPriorityRoutes(app: FastifyInstance, deps: { priorities: Priorities }) {
  const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

  app.get('/v1/priorities/criteria', async () => deps.priorities.criteria());

  app.put('/v1/priorities/criteria', async (request) => deps.priorities.setCriteria(request.body));

  app.get('/v1/priorities', async () => deps.priorities.list());

  app.post<{ Params: ProposalParams }>('/v1/priorities/:proposalId/apply', async (request) =>
    deps.priorities.apply({ id: request.params.proposalId }, request.body, via(request.headers)),
  );

  app.post<{ Params: ProposalParams }>('/v1/priorities/:proposalId/discard', async (request) =>
    deps.priorities.discard(request.params.proposalId, request.body, via(request.headers)),
  );
}
