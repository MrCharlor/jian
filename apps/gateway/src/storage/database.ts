import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type * as schema from './schema.js';

export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Reads and writes inside one profile's advisory lock. Every service takes this rather than a
 * connection, so a nested call joins the caller's transaction instead of deadlocking on it.
 */
export type Queryable = Database;

export interface Store {
  readonly db: Database;
  /**
   * Serializes everything that touches one profile. Version checks, state changes and the
   * events that describe them land together or not at all, across workers.
   */
  transaction<T>(profileId: string, body: (tx: Queryable) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  /** Wakes event streams when a profile transaction commits a change. */
  waitForEvent(profileId: string, signal: AbortSignal): Promise<void>;
}

/** The SQL drizzle-kit writes. It ships with the image and is applied on startup. */
export const migrationsFolder = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** Two workers starting together must not both run the migrations. */
export const MIGRATION_LOCK = 4_021_959_221;
