import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Stickers } from './service.js';

type StickerParams = ProfileParams & { stickerId: string };

export function registerStickerRoutes(app: FastifyInstance, deps: { stickers: Stickers }): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/stickers', async (request) =>
    deps.stickers.list(request.params.profileId),
  );

  app.delete<{ Params: ProfileParams }>('/v1/profiles/:profileId/stickers', async (request) =>
    deps.stickers.forgetAll(request.params.profileId),
  );

  app.get<{ Params: StickerParams }>(
    '/v1/profiles/:profileId/stickers/:stickerId',
    async (request) => deps.stickers.image(request.params.profileId, request.params.stickerId),
  );

  app.put<{ Params: StickerParams }>(
    '/v1/profiles/:profileId/stickers/:stickerId/tags',
    async (request) =>
      deps.stickers.tag(request.params.profileId, request.params.stickerId, request.body),
  );

  app.delete<{ Params: StickerParams }>(
    '/v1/profiles/:profileId/stickers/:stickerId',
    async (request) => deps.stickers.forget(request.params.profileId, request.params.stickerId),
  );
}
