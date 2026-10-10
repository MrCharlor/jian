import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';

const COOKIE = 'jian_draw';
const ENTER_MS = 2 * 60_000;
const SESSION_MS = 30 * 86_400_000;

/**
 * The drawing board runs beside the gateway on its own address, and opens only for the owner:
 * the panel hands out a short-lived signed link, the board's router sends it here, and the
 * cookie set in return is what the router checks on every request after that.
 */
export function registerDrawRoutes(
  app: FastifyInstance,
  deps: { token: string; drawUrl?: string; clock?: () => number },
) {
  const now = () => (deps.clock ?? Date.now)();
  const sign = (purpose: string, exp: number) =>
    createHmac('sha256', deps.token).update(`draw\n${purpose}\n${exp}`).digest('hex');
  const valid = (purpose: string, exp: number, sig: string) => {
    const expected = Buffer.from(sign(purpose, exp));
    const given = Buffer.from(sig);

    return exp > now() && expected.length === given.length && timingSafeEqual(expected, given);
  };

  app.post('/v1/draw/link', async () => {
    if (!deps.drawUrl) throw new GatewayError(503, 'No drawing board on this gateway');

    const exp = now() + ENTER_MS;

    return { url: `${deps.drawUrl}/__jian/enter?exp=${exp}&sig=${sign('enter', exp)}` };
  });

  app.get<{ Querystring: { exp?: string; sig?: string } }>(
    '/v1/draw/enter',
    async (request, reply) => {
      const exp = Number(request.query.exp);

      if (!valid('enter', exp, request.query.sig ?? '')) {
        throw new GatewayError(401, 'This link expired. Open the drawing board from the panel.');
      }

      const until = now() + SESSION_MS;

      return reply
        .header(
          'Set-Cookie',
          `${COOKIE}=${until}.${sign('session', until)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
        )
        .redirect('/', 302);
    },
  );

  app.get('/v1/draw/check', async (request) => {
    const cookie = (request.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const [exp, sig] = (cookie ?? '').split('.');

    if (!valid('session', Number(exp), sig ?? '')) {
      throw new GatewayError(401, 'Open the drawing board from the panel');
    }

    return { ok: true as const };
  });
}
