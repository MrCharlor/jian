import type { FastifyInstance } from 'fastify';
import type { Knowledge } from './service.js';

const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

export function registerKnowledgeRoutes(app: FastifyInstance, deps: { knowledge: Knowledge }) {
  app.get('/v1/knowledge', async (request) => deps.knowledge.list(request.query));

  app.post('/v1/knowledge/import', async (request) => deps.knowledge.import(request.body));

  app.get<{ Params: { ruleId: string } }>('/v1/knowledge/:ruleId', async (request) =>
    deps.knowledge.get(request.params.ruleId),
  );

  app.patch<{ Params: { ruleId: string } }>('/v1/knowledge/:ruleId', async (request) =>
    deps.knowledge.update(request.params.ruleId, request.body),
  );

  app.get('/v1/knowledge-proposals', async (request) => deps.knowledge.proposals(request.query));

  app.post<{ Params: { proposalId: string } }>(
    '/v1/knowledge-proposals/:proposalId/approve',
    async (request) =>
      deps.knowledge.approve({ id: request.params.proposalId }, via(request.headers)),
  );

  app.post<{ Params: { proposalId: string } }>(
    '/v1/knowledge-proposals/:proposalId/reject',
    async (request) =>
      deps.knowledge.reject({ id: request.params.proposalId }, request.body, via(request.headers)),
  );

  app.get('/v1/knowledge-settings', async () => deps.knowledge.settings());

  app.put('/v1/knowledge-settings', async (request) => deps.knowledge.updateSettings(request.body));
}
