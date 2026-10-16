import type { FastifyInstance } from 'fastify';
import type { PipelineChain } from './service.js';

type Params = { id: string };

export function registerPipelineRoutes(app: FastifyInstance, deps: { pipeline: PipelineChain }) {
  app.get('/v1/pipelines', async () => deps.pipeline.list());

  app.post<{ Params: Params }>('/v1/pipelines/:id/enter', async (request) =>
    deps.pipeline.enter(request.params.id),
  );

  app.post<{ Params: Params }>('/v1/pipelines/:id/stop', async (request) =>
    deps.pipeline.stop(request.params.id),
  );

  app.get('/v1/pipeline-settings', async () => deps.pipeline.settings());

  app.put('/v1/pipeline-settings', async (request) => deps.pipeline.updateSettings(request.body));
}
