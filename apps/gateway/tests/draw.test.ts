import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerDrawRoutes } from '../src/draw/routes.js';

const token = 'x'.repeat(40);

async function board(at = Date.parse('2026-10-09T12:00:00Z')) {
  let now = at;
  const app = Fastify();
  registerDrawRoutes(app, { token, drawUrl: 'https://draw.example', clock: () => now });
  await app.ready();

  return { app, later: (ms: number) => (now += ms) };
}

describe('the drawing board gate', () => {
  it('lets in only who came through a fresh link from the panel', async () => {
    const { app, later } = await board();
    const { url } = (await app.inject({ method: 'POST', url: '/v1/draw/link' })).json();
    const query = new URL(url).search;

    expect(url).toMatch(/^https:\/\/draw\.example\/__jian\/enter\?exp=\d+&sig=[0-9a-f]{64}$/);
    expect((await app.inject({ url: '/v1/draw/check' })).statusCode).toBe(401);

    const entered = await app.inject({ url: `/v1/draw/enter${query}` });
    expect(entered.statusCode).toBe(302);
    expect(entered.headers.location).toBe('/');
    const cookie = String(entered.headers['set-cookie']).split(';')[0] ?? '';

    expect((await app.inject({ url: '/v1/draw/check', headers: { cookie } })).statusCode).toBe(200);
    expect(
      (await app.inject({ url: '/v1/draw/check', headers: { cookie: `${cookie}0` } })).statusCode,
    ).toBe(401);

    const room = (
      await app.inject({ method: 'POST', url: '/v1/draw/link', payload: { to: '/#room=abc,key' } })
    ).json().url;
    const landed = await app.inject({ url: `/v1/draw/enter${new URL(room).search}` });
    expect(landed.headers.location).toBe('/#room=abc,key');
    const forged = new URL(room);
    forged.searchParams.set('to', '/#room=other,key');
    expect((await app.inject({ url: `/v1/draw/enter${forged.search}` })).statusCode).toBe(401);

    later(3 * 60_000);
    expect((await app.inject({ url: `/v1/draw/enter${query}` })).statusCode).toBe(401);

    later(31 * 86_400_000);
    expect((await app.inject({ url: '/v1/draw/check', headers: { cookie } })).statusCode).toBe(401);
  });
});
