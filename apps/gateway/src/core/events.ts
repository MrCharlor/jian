import { sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { events } from '../storage/schema.js';
import type { Clock } from './clock.js';

/** The durable feed every client follows. Written inside the caller's profile transaction. */
export async function recordEvent(
  tx: Queryable,
  clock: Clock,
  profileId: string,
  type: string,
  data: unknown,
  runId?: string,
): Promise<void> {
  await tx.insert(events).values({
    profileId,
    runId: runId ?? null,
    type,
    data: data ?? null,
    createdAt: new Date(clock()),
  });
  await tx.execute(sql`select pg_notify('jian_events', ${profileId})`);
}
