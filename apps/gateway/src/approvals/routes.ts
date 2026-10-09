import type { FastifyInstance } from 'fastify';
import type { ProfileParams } from '../http/params.js';
import type { Approvals } from './service.js';

type ApprovalParams = ProfileParams & { approvalId: string };

export function registerApprovalRoutes(app: FastifyInstance, deps: { approvals: Approvals }) {
  app.get<{ Params: ProfileParams }>('/v1/profiles/:profileId/approvals', async (request) =>
    deps.approvals.list(request.params.profileId),
  );

  app.post<{ Params: ApprovalParams }>(
    '/v1/profiles/:profileId/approvals/:approvalId/approve',
    async (request) =>
      deps.approvals.approve(
        request.params.profileId,
        request.params.approvalId,
        request.body,
        request.headers['x-jian-panel'] ? 'panel' : 'api',
      ),
  );

  app.post<{ Params: ApprovalParams }>(
    '/v1/profiles/:profileId/approvals/:approvalId/reject',
    async (request) =>
      deps.approvals.reject(
        request.params.profileId,
        request.params.approvalId,
        request.body,
        request.headers['x-jian-panel'] ? 'panel' : 'api',
      ),
  );
}
