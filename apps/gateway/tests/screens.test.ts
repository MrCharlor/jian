import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const admin = { authorization: `Bearer ${token}` };

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString(
  'base64',
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5]).toString('base64');

const listing = [
  { route: '/cadastros/cores', menuPath: 'Cadastros > Cores', title: 'Cores de Aparelhos' },
  { route: '/vendas/pedidos', menuPath: 'Vendas > Pedidos', title: 'Pedidos' },
];

const sheet = {
  today: [{ text: 'Lists colors with a filter by status.', source: 'screen' as const }],
  requirements: [{ text: 'A color can be switched off.', source: 'code' as const }],
  questions: [{ text: 'Who may delete a color?', source: 'unknown' as const }],
  problems: [],
};

async function fixture() {
  const services = await testServices();
  await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });

  return services;
}

describe('screens', () => {
  it('lists screens twice without doubling them or losing a sheet', async () => {
    const { screens } = await fixture();

    expect(await screens.saveInventory({ application: 'erp', screens: listing })).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
    });

    const [colors] = await screens.list({ application: 'erp' });
    await screens.writeSheet(colors?.id ?? '', sheet);

    expect(
      await screens.saveInventory({
        application: 'erp',
        screens: [{ ...listing[0], title: 'Cores' }, listing[1]],
      }),
    ).toEqual({ created: 0, updated: 1, unchanged: 1 });

    // A partial list keeps what is not in it.
    await screens.saveInventory({
      application: 'erp',
      screens: [{ route: '/estoque', menuPath: 'Estoque', title: 'Estoque' }],
    });

    const all = await screens.list({ application: 'erp' });
    const again = all.find((screen) => screen.route === '/cadastros/cores');

    expect(all).toHaveLength(3);
    expect(again).toMatchObject({ title: 'Cores', state: 'draft', sheet });
  });

  it('keeps a proposed squad when a later listing does not name one', async () => {
    const { screens } = await fixture();

    await screens.saveInventory({
      application: 'erp',
      screens: [{ ...listing[0], squad: 'Sigma' }],
    });
    await screens.saveInventory({ application: 'erp', screens: [listing[0]] });

    expect((await screens.list())[0]?.squad).toBe('Sigma');
  });

  it('makes a draft from a sheet and refuses a fact with no source', async () => {
    const { screens } = await fixture();
    await screens.saveInventory({ application: 'erp', screens: listing });
    const [screen] = await screens.list({ state: 'listed' });
    const id = screen?.id ?? '';

    await expect(
      screens.writeSheet(id, {
        ...sheet,
        today: [{ text: 'Probably exports to Excel.', source: 'unknown' }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    const written = await screens.writeSheet(id, { ...sheet, squad: 'Sigma' });

    expect(written).toMatchObject({ state: 'draft', squad: 'Sigma', sheet });
    expect(written.mappedAt).toBeDefined();
    expect(await screens.list({ state: 'listed' })).toHaveLength(1);
  });

  it('reviews only a draft, and a new sheet takes the review back', async () => {
    const { screens } = await fixture();
    await screens.saveInventory({ application: 'erp', screens: listing });
    const [screen] = await screens.list();
    const id = screen?.id ?? '';

    await expect(screens.review(id)).rejects.toMatchObject({ statusCode: 409 });

    await screens.writeSheet(id, sheet);
    const reviewed = await screens.review(id);

    expect(reviewed.state).toBe('reviewed');
    expect(reviewed.reviewedAt).toBeDefined();
    await expect(screens.review(id)).rejects.toMatchObject({ statusCode: 409 });

    const rewritten = await screens.writeSheet(id, sheet);

    expect(rewritten.state).toBe('draft');
    expect(rewritten.reviewedAt).toBeUndefined();
  });

  it('keeps prints that are the image they claim, replacing one of the same name', async () => {
    const { screens } = await fixture();
    await screens.saveInventory({ application: 'erp', screens: listing });
    const [screen] = await screens.list();
    const id = screen?.id ?? '';

    await expect(
      screens.attachPrints(id, {
        prints: [{ name: 'list.png', contentType: 'image/png', data: jpeg }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await screens.attachPrints(id, {
      prints: [{ name: 'list.png', contentType: 'image/png', data: png }],
    });
    const replaced = await screens.attachPrints(id, {
      prints: [
        { name: 'list.png', contentType: 'image/jpeg', data: jpeg },
        { name: 'filter.png', contentType: 'image/png', data: png },
      ],
    });

    expect(replaced.prints).toEqual(['filter.png', 'list.png']);
    expect(await screens.print(id, 'list.png')).toEqual({
      name: 'list.png',
      contentType: 'image/jpeg',
      data: jpeg,
    });
    await expect(screens.print(id, 'other.png')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves the map over the API, prints and review included', async () => {
    const services = await fixture();
    const app = createApp({ ...services, token, logger: false });

    try {
      const listed = await app.inject({
        method: 'POST',
        url: '/v1/screens/inventory',
        headers: admin,
        payload: { application: 'erp', screens: listing },
      });
      expect(listed.json()).toMatchObject({ created: 2 });

      const [screen] = (
        await app.inject({ method: 'GET', url: '/v1/screens?state=listed', headers: admin })
      ).json() as Array<{ id: string }>;
      const base = `/v1/screens/${screen?.id}`;

      expect(
        (await app.inject({ method: 'PUT', url: `${base}/sheet`, headers: admin, payload: sheet }))
          .statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `${base}/prints`,
            headers: admin,
            payload: {
              prints: [{ name: 'tela inicial.png', contentType: 'image/png', data: png }],
            },
          })
        ).json(),
      ).toMatchObject({ prints: ['tela inicial.png'] });

      const print = await app.inject({
        method: 'GET',
        url: `${base}/prints/${encodeURIComponent('tela inicial.png')}`,
        headers: admin,
      });
      expect(print.json()).toMatchObject({ contentType: 'image/png', data: png });

      const reviewed = await app.inject({ method: 'POST', url: `${base}/review`, headers: admin });
      expect(reviewed.json()).toMatchObject({ state: 'reviewed' });
    } finally {
      await app.close();
    }
  });
});
