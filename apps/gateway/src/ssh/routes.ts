import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { SshKeys } from './service.js';

export function registerSshRoutes(app: FastifyInstance, deps: { sshKeys: SshKeys }): void {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/ssh-keys', async (request) =>
    deps.sshKeys.list(request.params.profileId),
  );

  app.post<{ Params: ProfileParams }>('/v1/profiles/:profileId/ssh-keys', async (request, reply) =>
    reply
      .code(201)
      .send(await deps.sshKeys.create(request.params.profileId, request.body as never)),
  );

  app.delete<{ Params: ProfileParams & { keyId: string } }>(
    '/v1/profiles/:profileId/ssh-keys/:keyId',
    async (request) => deps.sshKeys.remove(request.params.profileId, request.params.keyId),
  );
}
