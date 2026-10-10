import type { FastifyInstance } from 'fastify';
import type { Validations } from './service.js';

type Params = { validationId: string };
type ReturnParams = Params & { index: string };

export function registerValidationRoutes(app: FastifyInstance, deps: { validations: Validations }) {
  const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

  app.get('/v1/validations', async () => deps.validations.list());

  app.post('/v1/validations/scan', async () => deps.validations.scan());

  app.post<{ Params: Params }>('/v1/validations/:validationId/answer', async (request) =>
    deps.validations.answer(
      { id: request.params.validationId },
      request.body,
      via(request.headers),
    ),
  );

  app.patch<{ Params: ReturnParams }>(
    '/v1/validations/:validationId/returns/:index',
    async (request) =>
      deps.validations.updateReturn(
        request.params.validationId,
        Number(request.params.index),
        request.body,
      ),
  );

  app.post<{ Params: ReturnParams }>(
    '/v1/validations/:validationId/returns/:index/create',
    async (request) =>
      deps.validations.createReturn(request.params.validationId, Number(request.params.index)),
  );
}
