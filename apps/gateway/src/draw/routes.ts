import { createHmac, timingSafeEqual } from 'node:crypto';
import { drawLinkInputSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';

const COOKIE = 'jian_draw';
const ENTER_MS = 2 * 60_000;
const SESSION_MS = 30 * 86_400_000;

const sign = (token: string, purpose: string, exp: number, extra = '') =>
  createHmac('sha256', token).update(`draw\n${purpose}\n${exp}\n${extra}`).digest('hex');

/** The cookie the board's router accepts; the gateway uses one too when it stores a drawing. */
export function drawCookie(token: string, now: number) {
  const until = now + SESSION_MS;

  return `${COOKIE}=${until}.${sign(token, 'session', until)}`;
}

/** Only a path on the board itself, so a signed link never sends anyone elsewhere. */
const onBoard = (to: string | undefined) =>
  to?.startsWith('/') && !to.startsWith('//') ? to : '/';

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
  const valid = (purpose: string, exp: number, sig: string, extra = '') => {
    const expected = Buffer.from(sign(deps.token, purpose, exp, extra));
    const given = Buffer.from(sig);

    return exp > now() && expected.length === given.length && timingSafeEqual(expected, given);
  };

  app.post('/v1/draw/link', async (request) => {
    if (!deps.drawUrl) throw new GatewayError(503, 'No drawing board on this gateway');

    const to = onBoard(drawLinkInputSchema.parse(request.body ?? {}).to);
    const exp = now() + ENTER_MS;
    const query = new URLSearchParams({
      exp: String(exp),
      sig: sign(deps.token, 'enter', exp, to),
    });

    if (to !== '/') query.set('to', to);

    return { url: `${deps.drawUrl}/__jian/enter?${query}` };
  });

  app.get<{ Querystring: { exp?: string; sig?: string; to?: string } }>(
    '/v1/draw/enter',
    async (request, reply) => {
      const exp = Number(request.query.exp);
      const to = onBoard(request.query.to);

      if (!valid('enter', exp, request.query.sig ?? '', to)) {
        throw new GatewayError(401, 'This link expired. Open the drawing board from the panel.');
      }

      return reply
        .header(
          'Set-Cookie',
          `${drawCookie(deps.token, now())}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Lax`,
        )
        .redirect(to, 302);
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
