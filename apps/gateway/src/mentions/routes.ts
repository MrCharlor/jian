import type { FastifyInstance } from 'fastify';
import type { Mentions } from './service.js';

type Params = { number: number };

const via = (headers: Record<string, unknown>) => (headers['x-jian-panel'] ? 'panel' : 'api');

export function registerMentionRoutes(app: FastifyInstance, deps: { mentions: Mentions }) {
  app.get('/v1/mentions', async (request) => deps.mentions.list(request.query));

  app.get<{ Params: Params }>('/v1/mentions/:number', async (request) =>
    deps.mentions.get({ number: Number(request.params.number) }),
  );

  app.post<{ Params: Params }>('/v1/mentions/:number/answer', async (request) =>
    deps.mentions.answer(
      { number: Number(request.params.number) },
      request.body ?? {},
      via(request.headers),
    ),
  );

  app.post<{ Params: Params }>('/v1/mentions/:number/ignore', async (request) =>
    deps.mentions.ignore({ number: Number(request.params.number) }, via(request.headers)),
  );

  app.get('/v1/mention-settings', async () => deps.mentions.settings());

  app.put('/v1/mention-settings', async (request) => deps.mentions.updateSettings(request.body));
}
