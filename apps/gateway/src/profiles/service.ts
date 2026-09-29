import { randomUUID } from 'node:crypto';
import {
  type McpServer,
  mcpImportSchema,
  optionalModelRoles,
  type Profile,
  profilePatchSchema,
  profileSchema,
} from '@jian/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { mcpValueSecret } from '../agent/mcp-connect.js';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { environmentProvider, type ProviderKind, providerCatalog } from '../providers/catalog.js';
import type { Vault } from '../security/vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { modelDefaults, providers } from '../storage/schema.js';
import {
  deleteProfileRow,
  findProfile,
  insertProfile,
  insertRevision,
  listProfiles,
  listRevisions,
  updateProfileRow,
} from './repository.js';
import { forget, hasActiveRun } from './reset.js';

/** One value on its way to the vault, still carrying which server and which slot it came from. */
type TypedMcpValue = { server: string; kind: 'header' | 'env'; name: string; value: string };

/** The profile as it will be stored, and the values that have to leave it. */
function stripMcpValues(profile: Profile): { stored: Profile; values: TypedMcpValue[] } {
  const values: TypedMcpValue[] = [];

  const mcpServers: McpServer[] = profile.mcpServers.map((server) => {
    const strip = (kind: 'header' | 'env', list: McpServer['headers']) =>
      list.map((value) => {
        if (value.value) {
          values.push({ server: server.name, kind, name: value.name, value: value.value });
        }

        return { name: value.name, ...(value.fromEnv ? { fromEnv: value.fromEnv } : {}) };
      });

    return {
      ...server,
      headers: strip('header', server.headers),
      env: strip('env', server.env),
    };
  });

  return { stored: { ...profile, mcpServers }, values };
}

/** Where an MCP server's bearer token lives in the vault, addressed by the server's name. */
export const mcpSecret = (name: string) => `mcp:${name}`;

export class Profiles {
  constructor(
    private readonly store: Store,
    private readonly vault: Vault,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * Run ahead of every delete, inside the same transaction the row dies in. Wired once, from
   * outside — `Profiles` does not know `Channels` exists, only that something may need telling
   * before a profile it is watching disappears (a live WhatsApp socket, an open webhook).
   */
  private beforeDelete?: (profileId: string, tx: Queryable) => Promise<void>;

  useBeforeDelete(hook: (profileId: string, tx: Queryable) => Promise<void>): void {
    this.beforeDelete = hook;
  }

  async profile(id: string, reader: Queryable = this.store.db) {
    return assertFound(await findProfile(reader, id), 'Profile');
  }

  async profiles() {
    return listProfiles(this.store.db);
  }

  async createProfile(input: unknown) {
    const data = profileSchema.parse(input);

    const profile: Profile = {
      ...data,
      id: randomUUID(),
      version: 1,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
    };

    return this.store.transaction(profile.id, async (tx) => {
      await this.validateReferences(profile, tx);

      // Stripped before the row exists and written after it: a secret references its profile,
      // so there has to be one to reference.
      const { stored, values } = stripMcpValues(profile);

      await insertProfile(tx, stored);
      await tx.insert(modelDefaults).values(
        [...optionalModelRoles].map((role) => ({
          profileId: stored.id,
          role,
          providerId: '00000000-0000-0000-0000-000000000000',
          modelId: 'disabled',
        })),
      );
      await this.writeMcpValues(profile.id, values, tx);
      await insertRevision(tx, stored);

      await recordEvent(tx, this.clock, stored.id, 'profile.created', {
        profileId: stored.id,
        version: 1,
      });

      return stored;
    });
  }

  /**
   * A value typed for an MCP server is kept out of the profile document, which every client
   * reads and every revision preserves. A patch that omits a value keeps the stored one, which
   * is how an owner edits a server without retyping a credential the panel cannot show them.
   */
  private async storeMcpTokens(
    profile: Profile,
    previous: Profile | undefined,
    tx: Queryable,
  ): Promise<Profile> {
    const { stored, values } = stripMcpValues(profile);

    await this.writeMcpValues(profile.id, values, tx);

    for (const server of stored.mcpServers) {
      await this.discardStaleMcpValues(profile.id, server, previous, tx);
    }

    for (const stale of previous?.mcpServers ?? []) {
      if (!stored.mcpServers.some((server) => server.name === stale.name)) {
        await this.discardMcpValues(profile.id, stale, tx);
      }
    }

    return stored;
  }

  private async writeMcpValues(
    profileId: string,
    values: TypedMcpValue[],
    tx: Queryable,
  ): Promise<void> {
    for (const { server, kind, name, value } of values) {
      await this.vault.put(profileId, mcpValueSecret(server, kind, name), value, tx);
    }
  }

  /** A header or variable the owner removed takes its secret with it. */
  private async discardStaleMcpValues(
    profileId: string,
    server: McpServer,
    previous: Profile | undefined,
    tx: Queryable,
  ): Promise<void> {
    const before = previous?.mcpServers.find((item) => item.name === server.name);

    if (!before) {
      return;
    }

    for (const kind of ['header', 'env'] as const) {
      const kept = new Set((kind === 'header' ? server.headers : server.env).map((v) => v.name));

      for (const value of kind === 'header' ? before.headers : before.env) {
        if (!kept.has(value.name)) {
          await this.vault.discard(profileId, mcpValueSecret(server.name, kind, value.name), tx);
        }
      }
    }
  }

  private async discardMcpValues(
    profileId: string,
    server: McpServer,
    tx: Queryable,
  ): Promise<void> {
    // The legacy single-token entry and the sign-in share the server's own address.
    await this.vault.discard(profileId, mcpSecret(server.name), tx);
    await this.vault.discard(profileId, `${mcpSecret(server.name)}:oauth`, tx);

    for (const kind of ['header', 'env'] as const) {
      for (const value of kind === 'header' ? server.headers : server.env) {
        await this.vault.discard(profileId, mcpValueSecret(server.name, kind, value.name), tx);
      }
    }
  }

  /** A profile may only name its own live provider, and one capability per name. */
  private async validateReferences(profile: Profile, reader: Queryable) {
    for (const names of [
      profile.skills.map((skill) => skill.name),
      profile.mcpServers.map((server) => server.name),
    ]) {
      if (new Set(names).size !== names.length) {
        throw new GatewayError(400, 'Skill and MCP names must be unique within a profile');
      }
    }

    const providerId = profile.model.providerId;

    if (!providerId) {
      return;
    }

    const fromEnvironment = (Object.keys(providerCatalog) as ProviderKind[]).some(
      (kind) => environmentProvider(kind)?.id === providerId,
    );

    if (fromEnvironment) {
      return;
    }

    const [live] = await reader
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.id, providerId), isNull(providers.revokedAt)))
      .limit(1);

    if (!live) {
      throw new GatewayError(400, 'Provider reference is not configured on this gateway');
    }
  }

  /**
   * Copies MCP servers from another profile into this one, each as this profile's own: the
   * definition, and a copy of every value typed for it, so the two are configured once and then
   * live apart. A sign-in is not copied: it belongs to the profile that made it, and one refresh
   * token shared by two would be spent by whichever refreshed first.
   */
  async importMcpServers(profileId: string, input: unknown) {
    const { fromProfileId, servers: names } = mcpImportSchema.parse(input);

    if (fromProfileId === profileId) {
      throw new GatewayError(400, 'Choose another profile to import from');
    }

    const source = await this.profile(fromProfileId);
    const target = await this.profile(profileId);
    const chosen = source.mcpServers.filter((server) => !names || names.includes(server.name));
    const skipped: Array<{ name: string; reason: string }> = [];
    const added: McpServer[] = [];

    for (const server of chosen) {
      if (target.mcpServers.some((item) => item.name === server.name)) {
        skipped.push({
          name: server.name,
          reason: 'This profile already has a server with this name',
        });
        continue;
      }

      const copy = async (kind: 'header' | 'env', list: McpServer['headers']) =>
        Promise.all(
          list.map(async (value) => {
            if (value.fromEnv) return value;

            const secret = await this.vault.read(
              fromProfileId,
              mcpValueSecret(server.name, kind, value.name),
            );

            return { name: value.name, ...(secret ? { value: secret } : {}) };
          }),
        );

      added.push({
        ...server,
        headers: await copy('header', server.headers),
        env: await copy('env', server.env),
      });
    }

    if (added.length) {
      // A value not typed here is kept as stored by the update, which is how the servers this
      // profile already has keep their credentials while the new ones bring theirs.
      await this.updateProfile(profileId, {
        expectedVersion: target.version,
        mcpServers: [...target.mcpServers, ...added],
      });

      // A single bearer token from before headers existed lives at the server's own address.
      for (const server of added) {
        const legacy = await this.vault.read(fromProfileId, mcpSecret(server.name));

        if (legacy) await this.vault.put(profileId, mcpSecret(server.name), legacy);
      }
    }

    return {
      imported: added.map((server) => server.name),
      skipped,
      signIn: added.filter((server) => server.auth === 'oauth').map((server) => server.name),
    };
  }

  async updateProfile(id: string, input: unknown) {
    const { expectedVersion, ...patch } = profilePatchSchema.parse(input);

    return this.store.transaction(id, async (tx) => {
      const current = await this.profile(id, tx);

      if (current.version !== expectedVersion) {
        throw new GatewayError(409, 'Profile version changed; reload before editing');
      }

      const patched: Profile = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: nowIso(this.clock),
      };

      await this.validateReferences(patched, tx);
      const profile = await this.storeMcpTokens(patched, current, tx);

      await updateProfileRow(tx, profile);
      await insertRevision(tx, profile);

      await recordEvent(tx, this.clock, id, 'profile.updated', {
        profileId: id,
        version: profile.version,
      });

      return profile;
    });
  }

  async revisions(id: string) {
    await this.profile(id);

    return listRevisions(this.store.db, id);
  }

  /**
   * The one row every session, memory, channel, contact, run and secret of this profile
   * references with `ON DELETE CASCADE` — removing it takes all of that with it, in the
   * database. `beforeDelete` gets a chance first, inside the same transaction, for whatever
   * lives outside a row: a linked device's open socket, a webhook a vendor still calls.
   */
  async deleteProfile(id: string): Promise<{ id: string }> {
    await this.profile(id);

    await this.store.transaction(id, async (tx) => {
      await this.beforeDelete?.(id, tx);
      await deleteProfileRow(tx, id);
    });

    return { id };
  }

  /**
   * The profile forgets everything it lived: sessions, memories and its activity. What the
   * owner gave it stays — name, instructions, skills, MCP servers, permissions, model defaults,
   * channels, contacts and secrets. Refused while an answer is running, which would otherwise
   * write into a conversation that no longer exists.
   */
  async resetProfile(id: string): Promise<{ id: string; sessions: number; memories: number }> {
    await this.profile(id);

    return this.store.transaction(id, async (tx) => {
      if (await hasActiveRun(tx, id)) {
        throw new GatewayError(
          409,
          'An answer is still running. Wait for it to finish, or cancel it, then reset.',
        );
      }

      const forgotten = await forget(tx, id);

      // The feed starts over with this, so an open panel reloads what is left.
      await recordEvent(tx, this.clock, id, 'profile.reset', forgotten);

      return { id, ...forgotten };
    });
  }
}
