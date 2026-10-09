import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

const text = (value: string) => Buffer.from(value, 'utf8');

/** A small design system in the Claude Design layout: guide, tokens, one component, a font. */
const designSystem = [
  { path: 'project/README.md', data: text('# ERP\n\nTela desktop em pt-BR.') },
  { path: 'project/tokens.json', data: text('{"color":{"primary":"#0d6efd"}}') },
  { path: 'project/preferencias-do-po.md', data: text('- Dados em toda tela.') },
  {
    path: 'project/components/Button/README.md',
    data: text('# Button\n\nBotão em pílula, 36px de altura.'),
  },
  {
    path: 'project/components/Button/Button.d.ts',
    data: text('export declare function Button(): void;'),
  },
  { path: 'project/components/Button/preview.html', data: text('<!doctype html><p>Botão</p>') },
  { path: 'project/fonts/poppins-400.woff2', data: Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00]) },
];

describe('applications', () => {
  it('is created without code, and a second one with the same slug is refused', async () => {
    const { applications } = await testServices();

    const created = await applications.create({
      slug: 'app-gestores',
      name: 'App Gestores',
      platform: 'mobile',
    });

    expect(created).toMatchObject({
      slug: 'app-gestores',
      platform: 'mobile',
      version: 0,
      files: 0,
    });
    await expect(applications.create({ slug: 'app-gestores', name: 'Outro' })).rejects.toThrow(
      'already exists',
    );
    expect((await applications.list()).map((item) => item.slug)).toEqual(['app-gestores']);
  });

  it('keeps text as written and the rest as bytes, and bumps the version once per write', async () => {
    const { applications } = await testServices();
    await applications.create({ slug: 'erp', name: 'VXCASE ERP' });

    const after = await applications.put('erp', designSystem);

    expect(after).toMatchObject({ version: 1, files: designSystem.length });
    expect(await applications.readText('erp', { path: 'project/tokens.json' })).toMatchObject({
      contentType: 'application/json',
      text: '{"color":{"primary":"#0d6efd"}}',
    });
    await expect(
      applications.readText('erp', { path: 'project/fonts/poppins-400.woff2' }),
    ).rejects.toThrow('not a text file');
    await expect(applications.readText('erp', { path: '../etc/passwd' })).rejects.toThrow();
  });

  it('gives an agent the preferences, the guide, the tokens and the components', async () => {
    const { applications } = await testServices();
    await applications.create({
      slug: 'erp',
      name: 'VXCASE ERP',
      url: 'https://erp-novo.vxcase.com.br',
    });
    await applications.put('erp', designSystem);

    const brief = await applications.brief('erp');

    expect(brief).toContain('Owner preferences');
    expect(brief).toContain('- Dados em toda tela.');
    expect(brief).toContain('# ERP');
    expect(brief).not.toContain('Tela desktop em pt-BR.');
    expect(brief).toContain('"primary":"#0d6efd"');
    expect(brief).toContain('- Button: Botão em pílula, 36px de altura.');
    expect(brief.indexOf('Owner preferences')).toBeLessThan(brief.indexOf('## Guide'));
    expect(
      await applications.readForAgent('erp', 'project/components/Button/Button.d.ts'),
    ).toContain('declare function Button');
  });

  it('keeps the owner’s preferences over a re-import, and drops what the source no longer has', async () => {
    const { applications } = await testServices();
    await applications.create({ slug: 'erp', name: 'VXCASE ERP' });
    await applications.put('erp', designSystem);

    await applications.writeText(
      'erp',
      { path: 'project/preferencias-do-po.md' },
      { text: '- Dados em toda tela.\n- Filtro funcional.' },
    );

    const updated = designSystem.filter((file) => !file.path.includes('/Button/'));
    const after = await applications.put('erp', updated, { keepOwnerFiles: true, replace: true });

    expect(after.version).toBe(3);
    expect(
      (await applications.readText('erp', { path: 'project/preferencias-do-po.md' })).text,
    ).toContain('Filtro funcional.');
    expect((await applications.files('erp')).map((file) => file.path)).not.toContain(
      'project/components/Button/README.md',
    );
  });
});

describe('component previews', () => {
  it('are served at a signed address, sandboxed, and refused when the signature is wrong', async () => {
    const { createApp } = await import('../src/app.js');
    const services = await testServices();
    const token = 'test-token-that-is-at-least-32-characters';
    const app = createApp({ ...services, token, logger: false });

    try {
      await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });
      await services.applications.put('erp', designSystem);

      const link = await app.inject({
        method: 'POST',
        url: '/v1/applications/erp/preview?path=project/components/Button/preview.html',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(link.statusCode).toBe(200);
      const { url } = link.json() as { url: string };

      const page = await app.inject({ method: 'GET', url });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<p>Botão</p>');
      // The runtime the preview expects is linked in front of it, at signed addresses too.
      expect(page.body).not.toContain('bundle.js');
      expect(page.headers['content-security-policy']).toContain('sandbox allow-scripts');

      const forged = await app.inject({
        method: 'GET',
        url: url.replace(/sig=[a-f0-9]{4}/, 'sig=0000'),
      });
      expect(forged.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
