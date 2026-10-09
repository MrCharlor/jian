import { createHmac, timingSafeEqual } from 'node:crypto';
import { applicationFileQuerySchema, applicationPreviewQuerySchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { Applications } from './service.js';

type SlugParams = { slug: string };

/** How long a preview address works: long enough to look, short enough to be useless later. */
const PREVIEW_SECONDS = 600;

/**
 * A preview runs the component's own scripts, so it is served apart from the panel: an opaque
 * sandboxed origin with no cookie and no reach into the API, under a policy that lets only its
 * own inline code run.
 */
const PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'sandbox allow-scripts',
  "frame-ancestors 'self'",
].join('; ');

export function registerApplicationRoutes(
  app: FastifyInstance,
  deps: { applications: Applications; token: string },
) {
  const sign = (slug: string, path: string, exp: number) =>
    createHmac('sha256', deps.token).update(`preview\n${slug}\n${path}\n${exp}`).digest('hex');

  app.post<{ Params: SlugParams }>('/v1/applications/:slug/preview', async (request) => {
    const { path } = applicationFileQuerySchema.parse(request.query);

    await deps.applications.readText(request.params.slug, { path });

    const exp = Math.floor(Date.now() / 1000) + PREVIEW_SECONDS;
    const query = new URLSearchParams({
      path,
      exp: String(exp),
      sig: sign(request.params.slug, path, exp),
    });

    return { url: `/v1/design/${request.params.slug}?${query}` };
  });

  app.get<{ Params: SlugParams }>('/v1/design/:slug', async (request, reply) => {
    const { path, exp, sig } = applicationPreviewQuerySchema.parse(request.query);
    const expected = Buffer.from(sign(request.params.slug, path, exp));

    if (
      exp < Date.now() / 1000 ||
      expected.length !== sig.length ||
      !timingSafeEqual(expected, Buffer.from(sig))
    ) {
      throw new GatewayError(403, 'This preview address expired or is not valid');
    }

    const file = await deps.applications.readText(request.params.slug, { path });

    return reply
      .header('content-security-policy', PREVIEW_POLICY)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300')
      .type(
        file.contentType === 'text/html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
      )
      .send(file.text);
  });

  app.get('/v1/applications', async () => deps.applications.list());

  app.post('/v1/applications', async (request, reply) =>
    reply.code(201).send(await deps.applications.create(request.body)),
  );

  app.get<{ Params: SlugParams }>('/v1/applications/:slug', async (request) =>
    deps.applications.get(request.params.slug),
  );

  app.patch<{ Params: SlugParams }>('/v1/applications/:slug', async (request) =>
    deps.applications.update(request.params.slug, request.body),
  );

  app.delete<{ Params: SlugParams }>('/v1/applications/:slug', async (request) =>
    deps.applications.remove(request.params.slug),
  );

  app.get<{ Params: SlugParams }>('/v1/applications/:slug/files', async (request) =>
    deps.applications.files(request.params.slug),
  );

  app.get<{ Params: SlugParams }>('/v1/applications/:slug/file', async (request) =>
    deps.applications.readText(request.params.slug, request.query),
  );

  app.put<{ Params: SlugParams }>('/v1/applications/:slug/file', async (request) =>
    deps.applications.writeText(request.params.slug, request.query, request.body),
  );
}
