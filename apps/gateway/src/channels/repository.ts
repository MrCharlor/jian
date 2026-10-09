import { channelSchema, contactSchema, deliverySchema } from '@jian/contracts';
import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { channels, contacts, deliveries, profiles } from '../storage/schema.js';
import type { ChannelType } from './channel.js';
import type { ContactRecord } from './contacts.js';
import type { ChannelRecord, DeliveryRecord } from './service.js';

type ChannelRow = typeof channels.$inferSelect;
type ContactRow = typeof contacts.$inferSelect;
type DeliveryRow = typeof deliveries.$inferSelect;

/**
 * Columns come back as dates and as nulls, while the contract speaks ISO strings and leaves an
 * unset field out entirely; the parse is the boundary. What the owner never sees — the webhook
 * token hash and the address this connection speaks as — rides beside the parsed document.
 */
export function toChannel(row: ChannelRow): ChannelRecord {
  return {
    ...channelSchema.parse({
      id: row.id,
      profileId: row.profileId,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
    }),
    tokenHash: row.webhookTokenHash ?? '',
    ...(row.address ? { address: row.address } : {}),
    ...(row.handle ? { handle: row.handle } : {}),
  };
}

export async function findChannel(db: Queryable, id: string): Promise<ChannelRecord | null> {
  const [row] = await db.select().from(channels).where(eq(channels.id, id)).limit(1);

  return row ? toChannel(row) : null;
}

/** The one channel of this type the profile still has connected, if any. */
export async function findLiveChannel(
  db: Queryable,
  profileId: string,
  type: ChannelType,
): Promise<ChannelRecord | null> {
  const [row] = await db
    .select()
    .from(channels)
    .where(
      and(eq(channels.profileId, profileId), eq(channels.type, type), isNull(channels.revokedAt)),
    )
    .limit(1);

  return row ? toChannel(row) : null;
}

export async function listChannels(db: Queryable, profileId: string): Promise<ChannelRecord[]> {
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.profileId, profileId))
    .orderBy(asc(channels.createdAt))
    .limit(100);

  return rows.map(toChannel);
}

/** Live channels that can show a profile picture, with the picture and what they last showed. */
export async function listPictureTargets(db: Queryable) {
  const rows = await db
    .select({ channel: channels, avatar: profiles.avatar })
    .from(channels)
    .innerJoin(profiles, eq(profiles.id, channels.profileId))
    .where(and(isNull(channels.revokedAt), inArray(channels.type, ['telegram', 'whatsapp'])))
    .limit(500);

  return rows.map((row) => ({
    channel: toChannel(row.channel),
    avatar: row.avatar,
    synced: row.channel.pictureSynced,
  }));
}

export async function markPictureSynced(db: Queryable, channelId: string, value: string) {
  await db.update(channels).set({ pictureSynced: value }).where(eq(channels.id, channelId));
}

/** Every profile's live connection of one type: how an agent recognises a colleague in a room. */
export async function listLiveChannelsOfType(
  db: Queryable,
  type: ChannelType,
): Promise<ChannelRecord[]> {
  const rows = await db
    .select()
    .from(channels)
    .where(and(eq(channels.type, type), isNull(channels.revokedAt)))
    .limit(200);

  return rows.map(toChannel);
}

export async function insertChannel(db: Queryable, record: ChannelRecord): Promise<void> {
  await db.insert(channels).values({
    id: record.id,
    profileId: record.profileId,
    type: record.type,
    address: record.address ?? null,
    handle: record.handle ?? null,
    webhookTokenHash: record.tokenHash,
    createdAt: new Date(record.createdAt),
    revokedAt: record.revokedAt ? new Date(record.revokedAt) : null,
  });
}

/** Written unconditionally, as before: revoking twice carries the second instant. */
export async function markChannelRevoked(db: Queryable, id: string, at: Date): Promise<void> {
  await db.update(channels).set({ revokedAt: at }).where(eq(channels.id, id));
}

export async function setChannelAddress(db: Queryable, id: string, address: string): Promise<void> {
  await db.update(channels).set({ address }).where(eq(channels.id, id));
}

/**
 * A contact carries the type of the channel it belongs to, and the channel is where that type
 * lives, so every read of a contact joins it.
 */
export function toContact(row: ContactRow, type: ChannelType): ContactRecord {
  return {
    ...contactSchema.parse({
      id: row.id,
      profileId: row.profileId,
      channelId: row.channelId,
      type,
      scope: row.scope,
      actorId: row.actorId ?? '',
      chatId: row.chatId,
      ...(row.title ? { displayName: row.title } : {}),
      status: row.status,
      owner: row.owner,
      ...(row.sessionId ? { sessionId: row.sessionId } : {}),
      ...(typeof row.heldMessage === 'string' ? { message: row.heldMessage } : {}),
      ...(row.avatar ? { avatar: row.avatar } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
    ...(row.heldMessageId ? { requestKey: row.heldMessageId } : {}),
    agentTurns: row.agentTurns,
    seen: row.seen,
    ...(row.avatarCheckedAt ? { avatarCheckedAt: row.avatarCheckedAt.toISOString() } : {}),
  };
}

/** Written apart from the rest of the contact, so saving a contact never erases its picture. */
export async function setContactAvatar(
  db: Queryable,
  id: string,
  avatar: string | undefined,
  checkedAt: Date,
): Promise<void> {
  await db
    .update(contacts)
    .set({ ...(avatar ? { avatar } : {}), avatarCheckedAt: checkedAt })
    .where(eq(contacts.id, id));
}

function toContactRow(contact: ContactRecord): typeof contacts.$inferInsert {
  return {
    id: contact.id,
    profileId: contact.profileId,
    channelId: contact.channelId,
    scope: contact.scope,
    chatId: contact.chatId,
    actorId: contact.actorId,
    title: contact.displayName ?? null,
    status: contact.status,
    owner: contact.owner,
    sessionId: contact.sessionId ?? null,
    heldMessage: contact.message ?? null,
    heldMessageId: contact.requestKey ?? null,
    agentTurns: contact.agentTurns ?? 0,
    seen: contact.seen ?? [],
    createdAt: new Date(contact.createdAt),
    updatedAt: new Date(contact.updatedAt),
  };
}

function contactQuery(db: Queryable) {
  return db
    .select({ contact: contacts, type: channels.type })
    .from(contacts)
    .innerJoin(channels, eq(contacts.channelId, channels.id));
}

/** The conversation on a channel that a session belongs to, if it belongs to one at all. */
export async function findContactBySession(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<ContactRecord | null> {
  const [row] = await db
    .select({ contact: contacts, type: channels.type })
    .from(contacts)
    .innerJoin(channels, eq(channels.id, contacts.channelId))
    .where(
      and(
        eq(contacts.profileId, profileId),
        eq(contacts.sessionId, sessionId),
        isNull(channels.revokedAt),
      ),
    )
    .limit(1);

  return row ? toContact(row.contact, row.type) : null;
}

export async function findContact(db: Queryable, id: string): Promise<ContactRecord | null> {
  const [row] = await contactQuery(db).where(eq(contacts.id, id)).limit(1);

  return row ? toContact(row.contact, row.type) : null;
}

/**
 * The identity the unique index enforces. A room is identified by itself — `actorId` holds the
 * chat — so everyone who writes there falls on the single decision the owner took about it.
 */
export async function findContactByIdentity(
  db: Queryable,
  channelId: string,
  chatId: string,
  actorId: string,
): Promise<ContactRecord | null> {
  const [row] = await contactQuery(db)
    .where(
      and(
        eq(contacts.channelId, channelId),
        eq(contacts.chatId, chatId),
        eq(contacts.actorId, actorId),
      ),
    )
    .limit(1);

  return row ? toContact(row.contact, row.type) : null;
}

export async function listContacts(db: Queryable, profileId: string): Promise<ContactRecord[]> {
  const rows = await contactQuery(db)
    .where(eq(contacts.profileId, profileId))
    .orderBy(desc(contacts.createdAt))
    .limit(200);

  return rows.map((row) => toContact(row.contact, row.type));
}

/** The approved conversations of a profile that have a session: whom it talks to, and where. */
export async function listConversations(
  db: Queryable,
  profileId: string,
): Promise<ContactRecord[]> {
  const rows = await contactQuery(db)
    .where(
      and(
        eq(contacts.profileId, profileId),
        eq(contacts.status, 'approved'),
        isNotNull(contacts.sessionId),
        isNull(channels.revokedAt),
      ),
    )
    .orderBy(desc(contacts.updatedAt))
    .limit(40);

  return rows.map((row) => toContact(row.contact, row.type));
}

/** Every profile's contacts for one room, or every room of the installation. */
export async function listGroupContacts(
  db: Queryable,
  filter: { chatId?: string; type?: ChannelType; status?: ContactRecord['status'] } = {},
): Promise<ContactRecord[]> {
  const rows = await contactQuery(db)
    .where(
      and(
        eq(contacts.scope, 'group'),
        ...(filter.chatId ? [eq(contacts.chatId, filter.chatId)] : []),
        ...(filter.type ? [eq(channels.type, filter.type)] : []),
        ...(filter.status ? [eq(contacts.status, filter.status)] : []),
      ),
    )
    .limit(500);

  return rows.map((row) => toContact(row.contact, row.type));
}

/**
 * Returns nothing when the identity is already taken: two messages from the same stranger are
 * one request, which the index now guarantees and no longer only the read that came first.
 */
export async function insertContact(
  db: Queryable,
  contact: ContactRecord,
): Promise<ContactRecord | null> {
  const [row] = await db
    .insert(contacts)
    .values(toContactRow(contact))
    .onConflictDoNothing({ target: [contacts.channelId, contacts.chatId, contacts.actorId] })
    .returning();

  return row ? toContact(row, contact.type) : null;
}

export async function updateContact(db: Queryable, contact: ContactRecord): Promise<void> {
  const { createdAt: _created, ...row } = toContactRow(contact);

  await db.update(contacts).set(row).where(eq(contacts.id, contact.id));
}

export function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    ...deliverySchema.parse({
      id: row.id,
      profileId: row.profileId,
      channelId: row.channelId,
      ...(row.runId ? { runId: row.runId } : {}),
      chatId: row.chatId,
      status: row.status,
      ...(row.notice ? { notice: row.notice } : {}),
      ...(row.mediaId ? { mediaId: row.mediaId } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      remoteMessageIds: row.remoteMessageIds,
      saidCount: row.saidCount,
    }),
    ...(row.connectionGeneration === null
      ? {}
      : { connectionGeneration: row.connectionGeneration }),
  };
}

function toDeliveryRow(delivery: DeliveryRecord): typeof deliveries.$inferInsert {
  return {
    id: delivery.id,
    profileId: delivery.profileId,
    channelId: delivery.channelId,
    runId: delivery.runId ?? null,
    chatId: delivery.chatId,
    notice: delivery.notice ?? null,
    mediaId: delivery.mediaId ?? null,
    status: delivery.status,
    remoteMessageIds: delivery.remoteMessageIds,
    saidCount: delivery.saidCount,
    connectionGeneration: delivery.connectionGeneration ?? null,
    createdAt: new Date(delivery.createdAt),
    updatedAt: new Date(delivery.updatedAt),
  };
}

/**
 * The delivery that put a given protocol message on a channel: how a reply or a reaction is
 * known to be on the agent's own words. Telegram numbers its messages and WhatsApp names them,
 * so both forms are looked for.
 */
export async function findDeliveryByRemoteId(
  db: Queryable,
  channelId: string,
  remoteId: string,
): Promise<DeliveryRecord | null> {
  const forms = [JSON.stringify([remoteId])];

  if (/^\d{1,15}$/.test(remoteId)) forms.push(JSON.stringify([Number(remoteId)]));

  const [row] = await db
    .select()
    .from(deliveries)
    .where(
      and(
        eq(deliveries.channelId, channelId),
        or(...forms.map((form) => sql`${deliveries.remoteMessageIds} @> ${form}::jsonb`)),
      ),
    )
    .orderBy(desc(deliveries.createdAt))
    .limit(1);

  return row ? toDelivery(row) : null;
}

export async function findDelivery(db: Queryable, id: string): Promise<DeliveryRecord | null> {
  const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);

  return row ? toDelivery(row) : null;
}

export async function listDeliveries(db: Queryable, profileId: string): Promise<DeliveryRecord[]> {
  const rows = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.profileId, profileId))
    .orderBy(desc(deliveries.createdAt))
    .limit(100);

  return rows.map(toDelivery);
}

/**
 * Oldest first, so a burst is sent in the order it arrived. `sending` and `unknown` share the
 * labels of `pending` and `sent` until the migration lands, so the phase is filtered here.
 */
export async function listDeliveriesByPhase(
  db: Queryable,
  phase: 'pending' | 'sending',
  limit: number,
): Promise<DeliveryRecord[]> {
  const rows = await db
    .select()
    .from(deliveries)
    .where(eq(deliveries.status, phase))
    .orderBy(asc(deliveries.createdAt))
    .limit(limit);

  return rows.map(toDelivery).filter((delivery) => delivery.status === phase);
}

/** Whether this run already has a way out, so a second one never replays what was sent. */
export async function hasDelivery(db: Queryable, runId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deliveries.id })
    .from(deliveries)
    .where(eq(deliveries.runId, runId))
    .limit(1);

  return Boolean(row);
}

export async function insertDelivery(db: Queryable, delivery: DeliveryRecord): Promise<void> {
  await db.insert(deliveries).values(toDeliveryRow(delivery)).onConflictDoNothing();
}

export async function updateDelivery(db: Queryable, delivery: DeliveryRecord): Promise<void> {
  const { createdAt: _created, ...row } = toDeliveryRow(delivery);

  await db.update(deliveries).set(row).where(eq(deliveries.id, delivery.id));
}
