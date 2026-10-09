import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  applicationFileQuerySchema,
  applicationPreviewQuerySchema,
  PROTOTYPE_PATH,
  prototypeVersionPath,
} from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import type { Prototypes } from '../prototypes/service.js';
import type { Applications } from './service.js';

type SlugParams = { slug: string };

/** How long a preview address works: long enough to look, short enough to be useless later. */
const PREVIEW_SECONDS = 600;

/**
 * What a Claude Design preview expects to find already loaded: React on `window`, then the
 * components bundle that puts the namespace on `window`, and its stylesheet. The design-system
 * viewer loads them around the preview; here they are linked in front of the preview's code.
 */
const RUNTIME = {
  styles: ['project/components/bundle.css'],
  scripts: ['project/components/lib/react.js', 'project/components/bundle.js'],
};

/**
 * A preview runs the component's own scripts, so it is served apart from the panel: an opaque
 * sandboxed origin with no cookie and no reach into the API, under a policy that lets only its
 * own inline code run.
 */
const PREVIEW_POLICY = [
  "default-src 'none'",
  // Its own inline code, and the runtime and components this gateway serves at signed addresses.
  "script-src 'unsafe-inline' 'self'",
  "style-src 'unsafe-inline' 'self'",
  'img-src data: blob:',
  'font-src data:',
  'sandbox allow-scripts',
  "frame-ancestors 'self'",
].join('; ');

export function registerApplicationRoutes(
  app: FastifyInstance,
  deps: { applications: Applications; prototypes?: Prototypes; token: string },
) {
  const sign = (slug: string, path: string, exp: number) =>
    createHmac('sha256', deps.token).update(`preview\n${slug}\n${path}\n${exp}`).digest('hex');
  const address = (slug: string, path: string, exp: number) =>
    `/v1/design/${slug}?${new URLSearchParams({ path, exp: String(exp), sig: sign(slug, path, exp) })}`;

  /** The preview with the runtime linked in front of it, for the files this design system has. */
  const withRuntime = async (slug: string, html: string, exp: number) => {
    const present = new Set((await deps.applications.files(slug)).map((file) => file.path));
    const tags = [
      ...RUNTIME.styles
        .filter((path) => present.has(path))
        .map((path) => `<link rel="stylesheet" href="${address(slug, path, exp)}">`),
      ...RUNTIME.scripts
        .filter((path) => present.has(path))
        .map((path) => `<script src="${address(slug, path, exp)}"></script>`),
    ].join('');

    if (!tags) return html;

    return /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (head) => `${head}${tags}`)
      : `${tags}${html}`;
  };

  app.post<{ Params: SlugParams }>('/v1/applications/:slug/preview', async (request) => {
    const { path } = applicationFileQuerySchema.parse(request.query);

    await deps.applications.readText(request.params.slug, { path });

    const exp = Math.floor(Date.now() / 1000) + PREVIEW_SECONDS;

    return { url: address(request.params.slug, path, exp) };
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

    // A prototype's screen is served like a component preview, with the same runtime.
    const drawn = PROTOTYPE_PATH.exec(path);
    const file = drawn
      ? {
          contentType: 'text/html',
          text: (await assertPrototypes(deps.prototypes).html(drawn[1] ?? '', Number(drawn[2])))
            .html,
        }
      : await deps.applications.readText(request.params.slug, { path });
    const html = file.contentType === 'text/html';
    const type = html
      ? 'text/html; charset=utf-8'
      : ['text/css', 'text/javascript'].includes(file.contentType)
        ? `${file.contentType}; charset=utf-8`
        : 'text/plain; charset=utf-8';

    return (
      reply
        .header('content-security-policy', PREVIEW_POLICY)
        .header('x-content-type-options', 'nosniff')
        // A sandboxed preview is an opaque origin; it may still load the runtime from here.
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('cache-control', 'private, max-age=300')
        .type(type)
        .send(html ? await withRuntime(request.params.slug, file.text, exp) : file.text)
    );
  });

  app.post<{ Params: { prototypeId: string; number: string } }>(
    '/v1/prototypes/:prototypeId/versions/:number/preview',
    async (request) => {
      const number = Number(request.params.number);
      const { slug } = await assertPrototypes(deps.prototypes).html(
        request.params.prototypeId,
        number,
      );
      const exp = Math.floor(Date.now() / 1000) + PREVIEW_SECONDS;

      return { url: address(slug, prototypeVersionPath(request.params.prototypeId, number), exp) };
    },
  );

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

function assertPrototypes(prototypes: Prototypes | undefined): Prototypes {
  if (!prototypes) throw new GatewayError(503, 'Prototypes are not available on this gateway');

  return prototypes;
}
