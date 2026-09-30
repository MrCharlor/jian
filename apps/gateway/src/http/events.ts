import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import { readEvents, readProgress } from '../core/event-feed.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Store } from '../storage/database.js';

type ProfileParams = { profileId: string };

interface EventOptions {
  profiles: ProfileReader;
  store: Store;
  token: string;
  maxStreams?: number;
}

/** Each connection owns its cursor; durable events survive disconnects and worker restarts. */
export function registerEventRoutes(app: FastifyInstance, options: EventOptions) {
  let streams = 0;
  const cursorSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

  app.get<{ Params: ProfileParams; Querystring: { after?: string } }>(
    '/v1/profiles/:profileId/events',
    async (request) => {
      await options.profiles.profile(request.params.profileId);

      return readEvents(
        options.store.db,
        request.params.profileId,
        cursorSchema.parse(request.query.after ?? 0),
      );
    },
  );

  app.get<{ Params: ProfileParams; Querystring: { after?: string } }>(
    '/v1/profiles/:profileId/events/stream',
    async (request, reply) => {
      const profileId = request.params.profileId;

      await options.profiles.profile(profileId);

      let cursor = cursorSchema.parse(request.headers['last-event-id'] ?? request.query.after ?? 0);

      if (streams >= (options.maxStreams ?? 100)) {
        throw new GatewayError(429, 'Too many event streams');
      }

      streams += 1;
      reply.hijack();

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      reply.raw.write(': connected\n\n');

      let closed = false;
      const wake = new AbortController();
      // When each working run last changed its progress, as this stream last told it.
      const told = new Map<string, string>();

      reply.raw.on('close', () => {
        closed = true;
        streams -= 1;
        wake.abort();
      });

      const pump = async () => {
        if (closed) {
          return;
        }

        try {
          // Close slow consumers instead of buffering an unbounded event history.
          if (reply.raw.writableLength > 256 * 1024) {
            reply.raw.end();

            return;
          }

          if (reply.raw.writableNeedDrain) {
            await new Promise((resolve) => setTimeout(resolve, 1000));

            return pump();
          }

          const events = await readEvents(options.store.db, profileId, cursor);

          for (const event of events) {
            if (closed) {
              return;
            }

            const ready = reply.raw.write(
              `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            );

            cursor = event.id;

            if (!ready) {
              break;
            }
          }

          // Progress changes many times a second and is not worth a row each time; a stream
          // hears of it here, without an id, so it never moves the cursor it resumes from.
          const working = await readProgress(options.store.db, profileId);

          for (const run of working) {
            if (told.get(run.runId) !== run.at) {
              told.set(run.runId, run.at);
              reply.raw.write(`event: run.progress\ndata: ${JSON.stringify(run)}\n\n`);
            }
          }

          for (const runId of told.keys()) {
            if (!working.some((run) => run.runId === runId)) told.delete(runId);
          }

          if (events.length === 0) {
            reply.raw.write(': heartbeat\n\n');
          }
        } catch {
          reply.raw.end();

          return;
        }

        await Promise.race([
          options.store.waitForEvent(profileId, wake.signal),
          new Promise((resolve) => setTimeout(resolve, 25_000)),
        ]);
        return pump();
      };

      void pump();
    },
  );
}
