import type { FastifyInstance } from 'fastify';
import type { Pautas } from './service.js';

type PautaParams = { pautaId: string };
type DecisionParams = { decisionId: string };

export function registerPautaRoutes(app: FastifyInstance, deps: { pautas: Pautas }) {
  app.get('/v1/pautas', async () => deps.pautas.list());

  app.post('/v1/pautas', async (request, reply) =>
    reply.code(201).send(await deps.pautas.create(request.body)),
  );

  app.get<{ Params: PautaParams }>('/v1/pautas/:pautaId', async (request) =>
    deps.pautas.get(request.params.pautaId),
  );

  app.patch<{ Params: PautaParams }>('/v1/pautas/:pautaId', async (request) =>
    deps.pautas.update(request.params.pautaId, request.body),
  );

  app.post<{ Params: PautaParams }>('/v1/pautas/:pautaId/decisions', async (request, reply) =>
    reply.code(201).send(await deps.pautas.propose(request.params.pautaId, request.body)),
  );

  app.post<{ Params: DecisionParams }>('/v1/decisions/:decisionId/decide', async (request) =>
    deps.pautas.decide(
      { id: request.params.decisionId },
      request.body,
      request.headers['x-jian-panel'] ? 'panel' : 'api',
    ),
  );

  app.post<{ Params: DecisionParams }>('/v1/decisions/:decisionId/discard', async (request) =>
    deps.pautas.discard(request.params.decisionId),
  );

  app.get('/v1/board', async () => deps.pautas.board());
}
