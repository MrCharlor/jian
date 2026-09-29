import {
  type ModelDefaultsRecord,
  type ModelRole,
  type ModelSelection,
  modelDefaultsRecordSchema,
  modelRoleSchema,
  optionalModelRoles,
  type ProviderRecord,
  providerRecordSchema,
} from '@jian/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { modelDefaults, providers } from '../storage/schema.js';

type Row = typeof providers.$inferSelect;
// An older gateway reads this as a selected but unavailable provider, failing closed on rollback.
const DISABLED_PROVIDER_ID = '00000000-0000-0000-0000-000000000000';

/** One selection per role; optional roles without a row start disabled. */
export type RoleSelections = Record<ModelRole, ModelSelection | 'disabled' | null>;

/**
 * Columns come back as dates and as nulls, while the contract speaks ISO strings and leaves an
 * unset field out entirely; the parse is the boundary.
 */
export function toProviderRecord(row: Row): ProviderRecord {
  return providerRecordSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    ...(row.authMode ? { authMode: row.authMode } : {}),
    ...(row.credential ? { credential: row.credential } : {}),
    ...(row.apiKeyEnv ? { apiKeyEnv: row.apiKeyEnv } : {}),
    ...(row.baseUrl ? { baseURL: row.baseUrl } : {}),
    createdAt: row.createdAt.toISOString(),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  });
}

/**
 * Postgres reports a broken unique index as 23505, and the driver error reaches here wrapped by
 * drizzle, so the whole cause chain is walked instead of the outermost code.
 */
export function isUniqueViolation(error: unknown): boolean {
  let cursor: unknown = error;

  while (cursor instanceof Error) {
    if ((cursor as { code?: unknown }).code === '23505') {
      return true;
    }

    cursor = cursor.cause;
  }

  return false;
}

export async function findProvider(db: Queryable, id: string): Promise<ProviderRecord | null> {
  const [row] = await db.select().from(providers).where(eq(providers.id, id)).limit(1);

  return row ? toProviderRecord(row) : null;
}

export async function listProviders(db: Queryable): Promise<ProviderRecord[]> {
  const rows = await db.select().from(providers).orderBy(providers.createdAt).limit(100);

  return rows.map(toProviderRecord);
}

export async function insertProvider(db: Queryable, provider: ProviderRecord): Promise<void> {
  await db.insert(providers).values({
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    authMode: provider.authMode ?? null,
    credential: provider.credential ?? null,
    apiKeyEnv: provider.apiKeyEnv ?? null,
    baseUrl: provider.baseURL ?? null,
    createdAt: new Date(provider.createdAt),
    revokedAt: provider.revokedAt ? new Date(provider.revokedAt) : null,
  });
}

/**
 * Retires whatever this vendor still had live and names it, so the caller can discard the key
 * that went with it. Revoking first is what keeps the live-per-vendor index free for the
 * replacement inside the same transaction.
 */
export async function revokeLiveProviders(
  db: Queryable,
  kind: ProviderRecord['kind'],
  at: Date,
  authMode: 'api' | 'codex' = 'api',
): Promise<string[]> {
  const rows = await db
    .update(providers)
    .set({ revokedAt: at })
    .where(
      and(
        eq(providers.kind, kind),
        isNull(providers.revokedAt),
        sql`coalesce(${providers.authMode}, 'api') = ${authMode}`,
      ),
    )
    .returning({ id: providers.id });

  return rows.map((row) => row.id);
}

/** Written unconditionally: a second revocation carries the first one's instant, not a new one. */
export async function markProviderRevoked(db: Queryable, id: string, at: Date): Promise<void> {
  await db.update(providers).set({ revokedAt: at }).where(eq(providers.id, id));
}

/**
 * A role per row, so the record is assembled rather than read. A row with no provider is a
 * role the owner cleared, which is why clearing everything still dates the record.
 */
export async function readModelDefaults(
  db: Queryable,
  profileId: string,
  fallbackUpdatedAt: string,
): Promise<ModelDefaultsRecord> {
  const rows = await db.select().from(modelDefaults).where(eq(modelDefaults.profileId, profileId));

  const byRole = new Map(rows.map((row) => [row.role, row]));
  const selections: Record<string, ModelSelection | 'disabled' | null> = {};

  for (const role of modelRoleSchema.options) {
    const row = byRole.get(role);

    selections[role] =
      !row && optionalModelRoles.has(role)
        ? 'disabled'
        : (row?.modelId === 'disabled' || row?.modelId === 'disabled_legacy_default') &&
            (!row.providerId || row.providerId === DISABLED_PROVIDER_ID)
          ? 'disabled'
          : row?.providerId && row.modelId
            ? {
                providerId: row.providerId,
                modelId: row.modelId,
                ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
              }
            : null;
  }

  selections.audio = !byRole.has('audio')
    ? (selections.transcription ?? 'disabled')
    : (selections.audio ?? selections.transcription ?? null);
  selections.transcription =
    selections.audio && selections.audio !== 'disabled' ? selections.audio : null;

  // The record carries one timestamp for what is now several rows: the newest write stands for
  // the set, so a client that polls it still sees a change to any single role.
  const latest = rows.reduce<Date | null>(
    (newest, row) => (!newest || row.updatedAt > newest ? row.updatedAt : newest),
    null,
  );

  return modelDefaultsRecordSchema.parse({
    ...selections,
    id: profileId,
    profileId,
    updatedAt: latest ? latest.toISOString() : fallbackUpdatedAt,
  });
}

/** Every role keeps a row, cleared or not, so the record's timestamp is stored and not guessed. */
export async function writeModelDefaults(
  db: Queryable,
  profileId: string,
  selections: RoleSelections,
  at: Date,
): Promise<void> {
  await db.delete(modelDefaults).where(eq(modelDefaults.profileId, profileId));

  const rows = modelRoleSchema.options.map((role) => {
    const selection = selections[role];

    return {
      profileId,
      role,
      providerId:
        selection === 'disabled' ? DISABLED_PROVIDER_ID : selection ? selection.providerId : null,
      modelId: selection === 'disabled' ? 'disabled' : (selection?.modelId ?? null),
      reasoningEffort:
        selection && selection !== 'disabled' ? (selection.reasoningEffort ?? null) : null,
      updatedAt: at,
    };
  });

  await db.insert(modelDefaults).values(rows);
}
