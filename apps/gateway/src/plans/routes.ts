import type { FastifyInstance } from 'fastify';
import type { Plans } from './service.js';

type Params = { planId: string };

const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

export function registerPlanRoutes(app: FastifyInstance, deps: { plans: Plans }) {
  app.get('/v1/plans', async (request) => deps.plans.list(request.query));

  app.get<{ Params: Params }>('/v1/plans/:planId', async (request) =>
    deps.plans.get(request.params.planId),
  );

  app.post<{ Params: Params }>('/v1/plans/:planId/approve', async (request) =>
    deps.plans.approve({ id: request.params.planId }, via(request.headers)),
  );

  app.post<{ Params: Params }>('/v1/plans/:planId/return', async (request) =>
    deps.plans.giveBack({ id: request.params.planId }, request.body, via(request.headers)),
  );

  app.post<{ Params: Params }>('/v1/plans/:planId/reject', async (request) =>
    deps.plans.reject({ id: request.params.planId }, request.body, via(request.headers)),
  );

  app.get<{ Params: { action: string } }>('/v1/plan-settings/:action', async (request) =>
    deps.plans.settings(request.params.action),
  );

  app.put<{ Params: { action: string } }>('/v1/plan-settings/:action', async (request) =>
    deps.plans.updateSettings(request.params.action, request.body),
  );

  app.get('/v1/routines', async () => deps.plans.routines());
}
