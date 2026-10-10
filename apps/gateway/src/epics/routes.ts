import type { FastifyInstance } from 'fastify';
import type { Epics } from './service.js';

type DraftParams = { draftId: string };

export function registerEpicRoutes(app: FastifyInstance, deps: { epics: Epics }) {
  app.get<{ Params: { pautaId: string } }>('/v1/pautas/:pautaId/epics', async (request) =>
    deps.epics.list(request.params.pautaId),
  );

  app.patch<{ Params: DraftParams }>('/v1/epics/:draftId', async (request) =>
    deps.epics.update(request.params.draftId, request.body),
  );

  app.post<{ Params: DraftParams }>('/v1/epics/:draftId/create', async (request) =>
    deps.epics.create(request.params.draftId),
  );

  app.post<{ Params: DraftParams }>('/v1/epics/:draftId/discard', async (request) =>
    deps.epics.discard(request.params.draftId),
  );
}
