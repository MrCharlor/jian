import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGatewayUi } from '../src/http/ui.js';

const page = (script: string) =>
  `<!doctype html><html><head><script src="/ui/app.js"></script><script>${script}</script></head><body></body></html>`;

const hash = (script: string) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

const apps: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function serve(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'jian-ui-'));
  const file = join(root, 'index.html');

  writeFileSync(file, page(script));

  const app = Fastify();

  registerGatewayUi(app, root);
  await app.ready();
  apps.push(app);

  return { app, file };
}

describe('the policy the panel is served with', () => {
  it('names the hash of the inline script in the page it is attached to', async () => {
    const { app } = await serve('window.__jian = 1');

    const response = await app.inject({ method: 'GET', url: '/ui/' });
    const policy = String(response.headers['content-security-policy']);

    expect(policy).toContain(`script-src 'self' ${hash('window.__jian = 1')}`);
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it("lets the viewer show a PDF from the panel's own blob address", async () => {
    const { app } = await serve('window.__jian = 1');

    const response = await app.inject({ method: 'GET', url: '/ui/' });
    const policy = String(response.headers['content-security-policy']);

    expect(policy).toContain("frame-src 'self' blob:");
    expect(policy).toContain("object-src 'self' blob:");
  });

  it('lets videos and voice notes play from the data addresses the panel builds', async () => {
    const { app } = await serve('window.__jian = 1');

    const response = await app.inject({ method: 'GET', url: '/ui/' });

    expect(String(response.headers['content-security-policy'])).toContain("media-src 'self' data:");
  });

  it('follows a rebuild under a running gateway instead of blocking the new page', async () => {
    const { app, file } = await serve('window.__jian = 1');

    await app.inject({ method: 'GET', url: '/ui/' });

    // What `pnpm build` does to a gateway that is already serving.
    writeFileSync(file, page('window.__jian = 2'));
    utimesSync(file, new Date(), new Date(Date.now() + 1000));

    const response = await app.inject({ method: 'GET', url: '/ui/' });

    expect(String(response.headers['content-security-policy'])).toContain(
      hash('window.__jian = 2'),
    );
  });
});
