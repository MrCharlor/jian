import type { FastifyInstance } from 'fastify';
import type { PrintsRepository } from './prints-repo.js';
import type { Prototypes } from './service.js';

type PrototypeParams = { prototypeId: string };

/** Prints travel inline with the request, so creating one takes a larger body than the rest. */
const PRINTS_BODY_LIMIT = 50 * 1024 * 1024;

export function registerPrototypeRoutes(
  app: FastifyInstance,
  deps: { prototypes?: Prototypes; prints?: PrintsRepository },
) {
  const prototypes = () => {
    if (!deps.prototypes) throw new Error('Prototypes are not available on this gateway');

    return deps.prototypes;
  };
  const prints = () => {
    if (!deps.prints) throw new Error('Prototype prints are not available on this gateway');

    return deps.prints;
  };

  // The token goes in and never comes back out: the answer says only whether one is set.
  app.get('/v1/prototype-prints', async () => prints().status());

  app.put('/v1/prototype-prints', async (request) => prints().configure(request.body));

  app.delete('/v1/prototype-prints', async () => prints().remove());

  app.get<{ Querystring: { application?: string } }>('/v1/prototypes', async (request) =>
    prototypes().list(request.query.application),
  );

  app.post<{ Querystring: { profileId?: string } }>(
    '/v1/prototypes',
    { bodyLimit: PRINTS_BODY_LIMIT },
    async (request, reply) =>
      reply.code(201).send(
        await prototypes().create(request.body, {
          kind: 'owner',
          ...(request.query.profileId ? { profileId: request.query.profileId } : {}),
        }),
      ),
  );

  app.get<{ Params: PrototypeParams }>('/v1/prototypes/:prototypeId', async (request) =>
    prototypes().get(request.params.prototypeId),
  );

  app.post<{ Params: PrototypeParams }>('/v1/prototypes/:prototypeId/redo', async (request) =>
    prototypes().redo(
      request.params.prototypeId,
      request.body,
      request.headers['x-jian-panel'] ? 'panel' : 'api',
    ),
  );

  app.post<{ Params: PrototypeParams & { number: string } }>(
    '/v1/prototypes/:prototypeId/versions/:number/approve',
    async (request) =>
      prototypes().approve(request.params.prototypeId, Number(request.params.number)),
  );
}
