import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    publicUiAsset?: boolean;
  }
}

const embeddedRoot = fileURLToPath(new URL('../../dist/ui/', import.meta.url));

const DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // The viewer opens a PDF from a blob address the panel itself creates, in a frame. That
  // document inherits this policy, and the browser's reader draws it as an embedded object,
  // so both the frame and the object have to accept the panel's own blobs or the page stays
  // blank. Nothing from another origin is allowed by either.
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
];

/**
 * A static Next export carries inline hydration scripts, so the policy names their hashes
 * rather than allowing any inline script at all.
 *
 * The hashes have to come from the bytes this request is serving, not from the ones present
 * when the process started: rebuilding the panel under a running gateway changes the page,
 * and a policy computed once would then block the page it is attached to. The stamp is what
 * makes that cheap — the file is re-read only when it has actually changed.
 */
function policyFor(path: string, cache: Map<string, { stamp: string; policy: string }>): string {
  const file = statSync(path);
  const stamp = `${file.mtimeMs}:${file.size}`;
  const cached = cache.get(path);

  if (cached?.stamp === stamp) {
    return cached.policy;
  }

  const html = readFileSync(path, 'utf8');

  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((match) => match[1])
    .map(
      (match) =>
        `'sha256-${createHash('sha256')
          .update(match[1] as string)
          .digest('base64')}'`,
    );

  const policy = [`script-src 'self' ${hashes.join(' ')}`, ...DIRECTIVES].join('; ');

  cache.set(path, { stamp, policy });

  return policy;
}

export function registerGatewayUi(app: FastifyInstance, root = embeddedRoot) {
  // Tests and API-only source runs can omit the export. A production build always embeds it.
  if (!existsSync(join(root, 'index.html'))) {
    return;
  }

  const policies = new Map<string, { stamp: string; policy: string }>();

  // The bare host is how people reach the panel; without this it answers 404.
  for (const path of ['/', '/ui']) {
    app.get(path, { config: { publicUiAsset: true } }, async (_request, reply) =>
      reply.redirect('/ui/'),
    );
  }

  void app.register(async (scope) => {
    scope.addHook('onRoute', (route) => {
      route.config = { ...route.config, publicUiAsset: true };
    });

    await scope.register(fastifyStatic, {
      root,
      prefix: '/ui/',
      decorateReply: false,
      dotfiles: 'deny',
      index: ['index.html'],
      setHeaders(reply, path) {
        if (!path.endsWith('.html')) {
          return;
        }

        reply.header('Content-Security-Policy', policyFor(path, policies));
        reply.header('Cache-Control', 'no-cache');
      },
    });
  });
}
