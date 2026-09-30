import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import type { Database, Queryable, Store } from './database.js';
import { MIGRATION_LOCK, migrationsFolder } from './database.js';
import * as schema from './schema.js';

export class PostgresStore implements Store {
  private readonly pool: Pool;
  private readonly listener: Client;
  private readonly listening: Promise<void>;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly client: ReturnType<typeof drizzle<typeof schema>>;
  readonly db: Database;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
    this.listener = new Client({ connectionString });
    this.listener.on('error', () => {});
    this.listening = this.listen();
    void this.listening.catch(() => {});
    this.client = drizzle(this.pool, { schema, casing: 'snake_case' });
    this.db = this.client as unknown as Database;
  }

  private async listen(): Promise<void> {
    await this.listener.connect();
    this.listener.on('notification', (message) => {
      if (message.channel !== 'jian_events' || !message.payload) return;
      for (const resolve of this.waiters.get(message.payload) ?? []) resolve();
      this.waiters.delete(message.payload);
    });
    await this.listener.query('LISTEN jian_events');
  }

  waitForEvent(profileId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return this.listening
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve) => {
            const done = () => {
              signal.removeEventListener('abort', done);
              this.waiters.get(profileId)?.delete(done);
              resolve();
            };
            const current = this.waiters.get(profileId) ?? new Set<() => void>();
            current.add(done);
            this.waiters.set(profileId, current);
            signal.addEventListener('abort', done, { once: true });
          }),
      );
  }

  async migrate(): Promise<void> {
    const connection = await this.pool.connect();

    try {
      // Held for the whole run and released with the session, so a worker that dies mid
      // migration does not leave the next one waiting forever.
      await connection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
      await migrate(this.client, { migrationsFolder });
    } finally {
      await connection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
      connection.release();
    }
  }

  async transaction<T>(profileId: string, body: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.client.transaction(async (tx) => {
      // Hashed to a bigint because an advisory lock takes numbers, not a uuid.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${profileId}, 0))`);

      return body(tx as unknown as Queryable);
    });
  }

  async close(): Promise<void> {
    await this.listener.end().catch(() => {});
    await this.pool.end();
  }
}
