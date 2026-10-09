import { createHash, randomUUID } from 'node:crypto';
import {
  channelInputSchema,
  type channelSchema,
  contactOwnerSchema,
  type deliverySchema,
  type Group,
  type GroupTurn,
  type ingressResultSchema,
} from '@jian/contracts';
import type { z } from 'zod';
import { assertFound, GatewayError, NoModelAvailable } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { stableUuid } from '../core/ids.js';
import type { Decisions } from '../decisions/service.js';
import { Errands } from '../errands/service.js';
import { pictureOf } from '../media/picture.js';
import { bindMedia, releaseHeldMedia } from '../media/repository.js';
import type { Media } from '../media/service.js';
import type { ProfileReader } from '../profiles/port.js';
import { isUniqueViolation } from '../providers/repository.js';
import type { RunWriter } from '../runs/port.js';
import { issueToken, verifyToken } from '../security/tokens.js';
import type { Vault } from '../security/vault.js';
import type { SessionWriter } from '../sessions/port.js';
import { insertMessage } from '../sessions/repository.js';
import type { Stickers } from '../stickers/service.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  type ChannelRequest,
  type ChannelType,
  CredentialRefused,
  type DeliveryOutcome,
  type IncomingMessage,
} from './channel.js';
import { type ContactRecord, Contacts, type Intake } from './contacts.js';
import { conversational } from './conversation.js';
import { type GroupDecision, Groups } from './groups.js';
import { channelLog } from './logging.js';
import {
  findPerson,
  type PersonRecord,
  rememberPerson,
  sessionPeople,
  setPersonAvatar,
  toPerson,
} from './people.js';
import { plainText } from './plain.js';
import { ChannelRegistry } from './registry.js';
import {
  findChannel,
  findContactByIdentity,
  findContactBySession,
  findDelivery,
  findDeliveryByRemoteId,
  findLiveChannel,
  hasDelivery,
  insertChannel,
  insertDelivery,
  listChannels,
  listContacts,
  listDeliveries,
  listDeliveriesByPhase,
  listGroupContacts,
  listPictureTargets,
  markChannelRevoked,
  markPictureSynced,
  setContactAvatar,
  updateDelivery,
} from './repository.js';
import { findConnection, writeAuthChunks, writeConnection } from './whatsapp/repository.js';

/**
 * `address` is what this connection speaks as on its protocol — the linked WhatsApp account or
 * the bot's own id. It is how a message from another profile of this installation is
 * recognised as an agent's instead of a person's, and it never reaches the owner-facing shape.
 */
export type ChannelRecord = z.infer<typeof channelSchema> & {
  tokenHash: string;
  address?: string;
  handle?: string;
};

/** Where a channel's bot token lives in the vault. Revoking the channel takes it with it. */
export const channelSecret = (channelId: string) => `channel:${channelId}`;

export type DeliveryRecord = z.infer<typeof deliverySchema> & { connectionGeneration?: number };

const DISPATCH_INTERVAL_MS = 2000;
/** How often channels are compared with their profile's picture: a change shows within this. */
const PICTURE_SYNC_MS = 15_000;
/** After a refusal, how long before the same picture is offered again. */
const PICTURE_RETRY_MS = 10 * 60_000;
/** What one message holds on the chat protocols; the adapter still enforces its own. */
const MESSAGE_LIMIT = 4000;
/** The longest a part waits behind the composing bubble before it is sent. */
const BETWEEN_MESSAGES_MS = 1200;
const UNCERTAIN_DELIVERY_AFTER_MS = 10 * 60_000;

/** Who wrote a message in a room, as the panel shows it beside the message. */
const authorOf = (data: IncomingMessage) => ({
  id: data.actorId,
  ...(data.displayName ? { name: data.displayName } : {}),
});

type IngressResult = z.infer<typeof ingressResultSchema>;

/** How much of a quoted message the agent reads: enough to know which one, not a copy of it. */
const QUOTE_CHARS = 300;

/**
 * The message a reply answers or a reaction is on, put where the agent reads it: a reply gets
 * the quote above its text, and a reaction becomes a line saying what it was on.
 */
export function withQuote(data: IncomingMessage, mine: boolean) {
  const words = data.quoted?.text.replace(/\s+/g, ' ').trim();
  const quote = words
    ? `: "${words.length > QUOTE_CHARS ? `${words.slice(0, QUOTE_CHARS)}…` : words}"`
    : '';
  const whose = mine
    ? 'your message'
    : data.quoted?.name
      ? `${data.quoted.name}'s message`
      : 'a message';

  if (data.reaction) return `[Reacted ${data.text} to ${whose}${quote}]`;
  if (!quote && !mine) return data.text;

  return `[Replying to ${whose}${quote}]\n${data.text}`;
}

/** Sent once to a sender the owner has not decided on yet. It must never depend on a run. */
const APPROVAL_NOTICE =
  'This gateway does not know you yet. Its owner was asked to approve this conversation, and your message is waiting for that decision.';

/**
 * Sent when a message arrives and the profile has no model to answer with. Without it the chat
 * looks as if the gateway never received anything, and the owner hunts in the wrong place.
 */
const NO_MODEL_NOTICE =
  '⚠️ I received your message, but I cannot answer yet: no AI model is set up for me. My owner can choose one in the gateway panel, under Model defaults. Send your message again after that.';

/** One notice per chat in this window, so a person who writes five times is told once. */
const NO_MODEL_NOTICE_MS = 10 * 60_000;

/** Resolves after the wait, or at once when the gateway is shutting down. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(done, ms);

    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }

    signal.addEventListener('abort', done, { once: true });
  });
}

/** Owns access checks and durable delivery state, independently of each protocol adapter. */
type ChannelServices = {
  profiles: ProfileReader;
  sessions: SessionWriter;
  runs: RunWriter;
  store: Store;
  vault: Vault;
  media?: Media;
  stickers?: Pick<Stickers, 'keep'>;
  decisions?: Pick<Decisions, 'ask'>;
};

export class Channels {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(
    private readonly services: ChannelServices,
    private readonly fetcher: typeof fetch,
    private readonly registry = new ChannelRegistry(),
    private readonly errands = new Errands(services.store),
    private readonly people = new Contacts(services),
    private readonly rooms = new Groups(services.profiles, services.decisions?.ask),
  ) {}

  /** Where the outside world reaches this gateway (`JIAN_PUBLIC_URL`), for webhooks. */
  private publicUrl?: string;

  usePublicUrl(url: string | undefined) {
    this.publicUrl = url?.replace(/\/+$/, '');
  }

  start() {
    const tick = async () => {
      if (this.stopped) {
        return;
      }

      this.pending = this.dispatch()
        .catch((error) => channelLog('dispatch.failed', {}, error))
        .then(() => this.syncPictures())
        .catch((error) => channelLog('picture.failed', {}, error));
      await this.pending;

      if (!this.stopped) {
        this.timer = setTimeout(tick, DISPATCH_INTERVAL_MS);
        this.timer.unref();
      }
    };

    void tick();
  }

  async stop() {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.timer);
    await this.pending;
  }

  private metadata({
    tokenHash: _hash,
    address: _address,
    handle: _handle,
    ...channel
  }: ChannelRecord) {
    return channel;
  }

  /** Asked once, when the channel is connected: a protocol that cannot say stays unidentified. */
  /**
   * Who the credential speaks as, asked before anything is stored: a protocol that refuses it
   * is a channel that would look connected and never receive a message.
   */
  private async identify(type: ChannelType, credential: string) {
    const adapter = this.registry.get(type);

    if (!adapter.identify) return undefined;

    let identity: Awaited<ReturnType<NonNullable<typeof adapter.identify>>>;

    try {
      identity = await adapter.identify(credential, this.fetcher, this.abort.signal);
    } catch (error) {
      if (error instanceof CredentialRefused) {
        throw new GatewayError(
          400,
          `Telegram refused this bot token (${error.message}). Copy it again from @BotFather.`,
        );
      }

      identity = undefined;
    }

    if (!identity) {
      throw new GatewayError(
        502,
        'Telegram could not be reached to check the bot token. Try again.',
      );
    }

    return identity;
  }

  /** Runs after the channel is stored, so the first update Telegram pushes finds it. */
  private async register(
    record: ChannelRecord,
    credential: string,
    origin: string,
    secret: string,
  ) {
    const adapter = this.registry.get(record.type);

    if (!adapter.register) {
      return undefined;
    }

    try {
      return await adapter.register(
        credential,
        { channelId: record.id, origin, secret },
        this.fetcher,
        this.abort.signal,
      );
    } catch {
      return { registered: false, reason: 'the request to register it failed' };
    }
  }

  /**
   * One channel of each type per profile: connecting is the whole configuration. `origin` is
   * the public address the owner reached the gateway through; without it the protocol is not
   * told where to deliver, and the owner registers the webhook by hand.
   */
  async connect(profileId: string, input: unknown, origin?: string) {
    const { botToken, ...data } = channelInputSchema.parse(input);

    await this.services.profiles.profile(profileId);
    this.registry.get(data.type);

    if (await findLiveChannel(this.services.store.db, profileId, data.type)) {
      throw new GatewayError(409, 'This channel type is already connected');
    }

    const issued = issueToken();
    const identity = botToken ? await this.identify(data.type, botToken) : undefined;

    const record: ChannelRecord = {
      id: randomUUID(),
      profileId,
      type: data.type,
      tokenHash: issued.hash,
      ...(identity?.address ? { address: identity.address } : {}),
      ...(identity?.handle ? { handle: identity.handle } : {}),
      createdAt: new Date().toISOString(),
    };

    await this.services.store.transaction(profileId, async (tx) => {
      // The vault owns the bot token, addressed by this channel; revoking it takes the token.
      if (botToken) {
        await this.services.vault.put(profileId, channelSecret(record.id), botToken, tx);
      }

      try {
        await insertChannel(tx, record);
      } catch (error) {
        // The partial unique index has the last word on one live channel per type. Reaching it
        // means another request connected this type first, which is a conflict for the owner
        // rather than a gateway fault.
        if (isUniqueViolation(error)) {
          throw new GatewayError(409, 'This channel type is already connected');
        }

        throw error;
      }

      await recordEvent(tx, () => Date.parse(record.createdAt), profileId, 'channel.connected', {
        id: record.id,
        type: record.type,
      });
    });

    // The address the owner set for the outside world wins over the one they happen to be
    // using: a panel opened on localhost is not an address Telegram can call.
    const address = this.publicUrl ?? origin;
    const webhook =
      botToken && address
        ? await this.register(record, botToken, address, issued.token)
        : undefined;

    return {
      ...this.metadata(record),
      webhookToken: issued.token,
      ...(webhook
        ? {
            webhookRegistered: webhook.registered,
            ...(webhook.reason
              ? {
                  webhookError: `Telegram refused the webhook ${address}/v1/telegram/${record.id}: ${webhook.reason}`,
                }
              : {}),
          }
        : {}),
    };
  }

  async list(profileId: string) {
    await this.services.profiles.profile(profileId);

    return (await listChannels(this.services.store.db, profileId)).map((channel) =>
      this.metadata(channel),
    );
  }

  private async revokeWithin(profileId: string, id: string, tx: Queryable): Promise<ChannelRecord> {
    const value = await findChannel(tx, id);
    const channel = assertFound(value?.profileId === profileId ? value : null, 'Channel');
    const record = { ...channel, revokedAt: new Date().toISOString() };

    await markChannelRevoked(tx, id, new Date(record.revokedAt));
    await this.services.vault.discard(profileId, channelSecret(id), tx);

    await recordEvent(tx, () => Date.parse(record.revokedAt), profileId, 'channel.disconnected', {
      id: record.id,
      type: record.type,
    });

    const connection = await findConnection(tx, id);

    if (connection) {
      // Revocation also invalidates linked-device callbacks and removes the recoverable session.
      await writeConnection(tx, {
        id,
        profileId,
        desired: false,
        generation: connection.generation + 1,
        status: 'disconnected',
        updatedAt: record.revokedAt,
      });
      await writeAuthChunks(tx, id, profileId, [], new Date(record.revokedAt));
    }

    return record;
  }

  async revoke(profileId: string, id: string) {
    const record = await this.services.store.transaction(profileId, (tx) =>
      this.revokeWithin(profileId, id, tx),
    );

    return this.metadata(record);
  }

  /**
   * Every live channel disconnected, ahead of deleting the profile they belong to. Takes the
   * caller's transaction rather than opening one of its own: `deleteProfile` already holds this
   * profile's advisory lock for the delete, and a second `store.transaction` call here would
   * queue behind it in another session and never return. A row that cascades from the profile
   * takes its channel with it either way; this is what stops a WhatsApp socket still open in a
   * worker's memory from outliving the row it was reading.
   */
  async revokeAll(profileId: string, tx: Queryable): Promise<void> {
    const live = (await listChannels(tx, profileId)).filter((channel) => !channel.revokedAt);

    for (const channel of live) {
      await this.revokeWithin(profileId, channel.id, tx);
    }
  }

  async contacts(profileId: string) {
    const list = await this.people.list(profileId);

    // Contacts that have not written since pictures existed get theirs when the owner looks.
    void this.refreshAvatars(profileId).catch(() => {});

    return list;
  }

  /** Asked at most this often per contact: a picture changes rarely, and each ask is a call. */
  private static readonly AVATAR_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly fetchingAvatars = new Set<string>();
  /** When each chat was last told there is no model, by channel and chat. */
  private readonly toldNoModel = new Map<string, number>();

  private picturesDueAt = 0;
  private readonly pictureRefused = new Map<string, { value: string; until: number }>();

  /**
   * Keeps each channel's account showing its profile's picture, so it is changed in one place.
   * What a channel last showed is kept against the account it showed it on: a new picture, a
   * picture taken off, or another number paired on the channel each count as a change. A
   * channel that never showed one is left alone while the profile has none.
   */
  async syncPictures() {
    if (Date.now() < this.picturesDueAt) return;
    this.picturesDueAt = Date.now() + PICTURE_SYNC_MS;

    for (const { channel, avatar, synced } of await listPictureTargets(this.services.store.db)) {
      const adapter = this.registry.get(channel.type);
      const account = channel.address ?? '';

      if (!adapter.setPicture || !account) continue;

      const want = avatar
        ? `${account}:${createHash('sha256').update(avatar).digest('hex').slice(0, 32)}`
        : synced?.startsWith(`${account}:`)
          ? `${account}:none`
          : undefined;

      if (!want || want === synced) continue;

      const refused = this.pictureRefused.get(channel.id);

      if (refused?.value === want && refused.until > Date.now()) continue;

      try {
        const done = await adapter.setPicture(avatar ? pictureOf(avatar) : null, {
          channelId: channel.id,
          credential: await this.services.vault.read(channel.profileId, channelSecret(channel.id)),
          fetch: this.fetcher,
          signal: this.abort.signal,
        });

        if (done) {
          await markPictureSynced(this.services.store.db, channel.id, want);
          this.pictureRefused.delete(channel.id);
        }
      } catch (error) {
        this.pictureRefused.set(channel.id, { value: want, until: Date.now() + PICTURE_RETRY_MS });
        channelLog('picture.refused', { channelId: channel.id }, error);
      }
    }
  }

  private async refreshAvatars(profileId: string) {
    const stale = (await listContacts(this.services.store.db, profileId))
      .filter((contact) => this.avatarStale(contact))
      .slice(0, 12);

    for (const contact of stale) {
      const channel = await findChannel(this.services.store.db, contact.channelId);

      if (channel && !channel.revokedAt) {
        await this.refreshAvatar(channel, contact);
      }
    }
  }

  private avatarStale(contact: { avatarCheckedAt?: string }) {
    return (
      !contact.avatarCheckedAt ||
      Date.parse(contact.avatarCheckedAt) < Date.now() - Channels.AVATAR_TTL_MS
    );
  }

  /**
   * Fetches the picture the protocol shows for this contact and keeps it on the contact. The
   * attempt is recorded either way, so a contact without a picture is not asked on every
   * message. Nothing here can fail the caller.
   */
  private async refreshAvatar(channel: ChannelRecord, contact: ContactRecord) {
    const adapter = this.registry.get(channel.type);

    if (!adapter.avatar || !this.avatarStale(contact) || this.fetchingAvatars.has(contact.id)) {
      return;
    }

    this.fetchingAvatars.add(contact.id);

    try {
      const credential = await this.services.vault.read(
        channel.profileId,
        channelSecret(channel.id),
      );
      const picture = await adapter
        .avatar(
          { chatId: contact.chatId, actorId: contact.actorId, scope: contact.scope },
          {
            channelId: channel.id,
            ...(credential ? { credential } : {}),
            fetch: this.fetcher,
            signal: this.abort.signal,
          },
        )
        .catch(() => undefined);

      const avatar = picture ? `data:${picture.mimeType};base64,${picture.data}` : undefined;

      await this.services.store.transaction(channel.profileId, async (tx) => {
        await setContactAvatar(tx, contact.id, avatar, new Date());

        // An open panel reloads on contact events; a new picture is worth one.
        if (avatar && avatar !== contact.avatar) {
          await recordEvent(tx, Date.now, channel.profileId, 'contact.updated', { id: contact.id });
        }
      });
    } finally {
      this.fetchingAvatars.delete(contact.id);
    }
  }

  /** After a message, the one who wrote it: the moment a picture is most likely to be new. */
  private async refreshAvatarOf(channel: ChannelRecord, data: IncomingMessage) {
    const contact = await findContactByIdentity(
      this.services.store.db,
      channel.id,
      data.chatId,
      data.scope === 'group' ? data.chatId : data.actorId,
    );

    if (contact) {
      await this.refreshAvatar(channel, contact);
    }

    if (data.scope === 'group') {
      const person = await findPerson(this.services.store.db, channel.id, data.actorId);

      if (person) {
        await this.refreshPersonAvatar(channel, data.chatId, person);
      }
    }
  }

  /**
   * Everyone who wrote in a group conversation, with their pictures. A member not asked for a
   * picture lately is asked in the background, so the next read has it.
   */
  async sessionPeople(profileId: string, sessionId: string) {
    await this.services.sessions.session(profileId, sessionId);

    const list = await sessionPeople(this.services.store.db, profileId, sessionId);
    const contact = await findContactBySession(this.services.store.db, profileId, sessionId);
    const channel = contact && (await findChannel(this.services.store.db, contact.channelId));

    if (contact && channel) {
      void (async () => {
        for (const person of list.filter((item) => this.avatarStale(item)).slice(0, 12)) {
          await this.refreshPersonAvatar(channel, contact.chatId, person);
        }
      })().catch(() => {});
    }

    return list.map(toPerson);
  }

  /** As `refreshAvatar`, for a member of a group: their own picture, not the group's. */
  private async refreshPersonAvatar(channel: ChannelRecord, chatId: string, person: PersonRecord) {
    const adapter = this.registry.get(channel.type);
    const key = `${channel.id}:${person.actorId}`;

    if (!adapter.avatar || !this.avatarStale(person) || this.fetchingAvatars.has(key)) {
      return;
    }

    this.fetchingAvatars.add(key);

    try {
      const credential = await this.services.vault.read(
        channel.profileId,
        channelSecret(channel.id),
      );
      const picture = await adapter
        .avatar(
          { chatId, actorId: person.actorId, scope: 'direct' },
          {
            channelId: channel.id,
            ...(credential ? { credential } : {}),
            fetch: this.fetcher,
            signal: this.abort.signal,
          },
        )
        .catch(() => undefined);
      const avatar = picture ? `data:${picture.mimeType};base64,${picture.data}` : undefined;

      await setPersonAvatar(this.services.store.db, channel.id, person.actorId, avatar, new Date());
    } finally {
      this.fetchingAvatars.delete(key);
    }
  }

  /**
   * Approval is what creates the conversation: the session appears here, and the message that
   * was waiting reaches the agent exactly once, because its text is dropped after it is used.
   */
  async approveContact(profileId: string, contactId: string) {
    const contact = await this.people.approve(profileId, contactId);

    if (!contact.message || !contact.sessionId) {
      return this.people.view(contact);
    }

    const channel = await findChannel(this.services.store.db, contact.channelId);

    if (!channel || channel.revokedAt) {
      throw new GatewayError(409, 'The channel of this contact is disconnected');
    }

    const mediaIds = await this.services.store.transaction(profileId, (tx) =>
      releaseHeldMedia(
        tx,
        profileId,
        contact.id,
        assertFound(contact.sessionId ?? null, 'Session'),
      ),
    );
    await this.submit(
      channel,
      contact,
      contact.message,
      contact.requestKey ?? contact.id,
      undefined,
      undefined,
      mediaIds,
    );

    return this.people.release(profileId, contactId);
  }

  blockContact(profileId: string, contactId: string) {
    return this.people.block(profileId, contactId);
  }

  setContactOwner(profileId: string, contactId: string, input: unknown) {
    const { owner } = contactOwnerSchema.parse(input);

    return this.people.setOwner(profileId, contactId, owner);
  }

  async receive(id: string, request: ChannelRequest) {
    const adapter = this.registry.get(request.type);
    if (!adapter.webhookHeader) {
      throw new GatewayError(401, 'Channel does not accept webhooks');
    }

    const token = request.headers[adapter.webhookHeader];
    const channel = await findChannel(this.services.store.db, id);

    if (
      !channel ||
      channel.revokedAt ||
      typeof token !== 'string' ||
      token.length > 512 ||
      !verifyToken(token, channel.tokenHash)
    ) {
      throw new GatewayError(401, 'Unauthorized');
    }

    if (channel.type !== adapter.type) {
      throw new GatewayError(400, 'Channel type mismatch');
    }

    const data = adapter.receive(request.payload);

    if (!data) {
      return { accepted: false };
    }

    if (adapter.download) {
      const files = await adapter.download(request.payload, {
        channelId: channel.id,
        credential: await this.services.vault.read(channel.profileId, channelSecret(channel.id)),
        fetch: this.fetcher,
        signal: this.abort.signal,
      });

      if (files.media?.length) data.media = files.media;
      if (files.note) data.text = `${data.text.slice(0, 7800)}\n${files.note}`;
    }

    const accepted = await this.accept(channel, data);

    void this.refreshAvatarOf(channel, data).catch(() => {});

    return accepted;
  }

  /** Called only by the worker that owns an authenticated linked-device connection. */
  async receiveLinked(id: string, input: unknown, generation: number) {
    const channel = assertFound(await findChannel(this.services.store.db, id), 'Channel');
    const adapter = this.registry.get(channel.type);

    const connection = await findConnection(this.services.store.db, id);

    if (
      channel.revokedAt ||
      adapter.webhookHeader ||
      !connection?.desired ||
      connection.generation !== generation
    ) {
      throw new GatewayError(403, 'Linked channel unavailable');
    }

    const data = adapter.receive(input);

    if (!data) {
      return { accepted: false };
    }

    const accepted = await this.accept(channel, data, generation);

    void this.refreshAvatarOf(channel, data).catch(() => {});

    return accepted;
  }

  private async accept(
    channel: ChannelRecord,
    data: IncomingMessage,
    connectionGeneration?: number,
  ): Promise<IngressResult> {
    // A message this connection wrote itself is not a turn someone took in the conversation.
    if (channel.address && data.actorId === channel.address) {
      return { accepted: false };
    }

    // A reply or a reaction on something the agent sent: known from the delivery that sent it,
    // which also says what it was when the protocol did not quote it.
    const target = data.target
      ? await findDeliveryByRemoteId(this.services.store.db, channel.id, data.target)
      : null;
    const mine = Boolean(target) || (Boolean(channel.address) && data.replyTo === channel.address);

    if (target && !data.quoted) {
      const said = target.runId
        ? (await this.services.runs.run(channel.profileId, target.runId).catch(() => undefined))
            ?.output
        : target.notice;

      if (said) data.quoted = { text: said.slice(0, 1000) };
    }

    if (target && channel.address && !data.replyTo) data.replyTo = channel.address;

    // WhatsApp quotes the words but not who wrote them; the room's members are known by now.
    if (data.quoted && !data.quoted.name && !mine && data.replyTo) {
      const author = await findPerson(this.services.store.db, channel.id, data.replyTo);

      if (author?.displayName) data.quoted = { ...data.quoted, name: author.displayName };
    }

    data.text = withQuote(data, mine).slice(0, 8000);

    if (data.reaction) {
      return this.noteReaction(channel, data);
    }

    // Asked before the transaction: an answer from outside must not hold the profile's lock.
    const verdict =
      data.scope === 'group'
        ? await this.rooms.verdict(this.services.store.db, channel, data)
        : undefined;
    const mediaIds: string[] = [];
    const intake = await this.services.store.transaction(
      channel.profileId,
      async (tx): Promise<Intake & { decision?: GroupDecision }> => {
        const outcome = await this.people.intake(tx, channel, data);
        if (outcome.status === 'pending' && outcome.announce)
          await this.notify(tx, channel, data.chatId, connectionGeneration);
        let decision: GroupDecision | undefined;
        if (outcome.status === 'approved' && data.scope === 'group') {
          await rememberPerson(tx, {
            profileId: channel.profileId,
            channelId: channel.id,
            actorId: data.actorId,
            ...(data.displayName ? { displayName: data.displayName } : {}),
          });
          const profile = await this.services.profiles.profile(channel.profileId, tx);
          decision = await this.rooms.observe(
            tx,
            channel,
            outcome.contact,
            data,
            profile.name,
            verdict,
          );

          // What was not said to the agent is still what it heard: when it is called later, it
          // answers the room with the conversation it followed, like anyone else who was there.
          if (!decision.speak && outcome.contact.sessionId) {
            const heard: string[] = [];
            for (const [index, media] of (data.media ?? []).entries()) {
              const id = await this.services.media
                ?.keepHeard(
                  tx,
                  channel.profileId,
                  outcome.contact.sessionId,
                  `heard:${channel.id}:${data.requestKey}:${index}`,
                  media,
                )
                .catch(() => undefined);
              heard.push(
                id
                  ? `\n[File not opened, it was not sent to you: ${media.name ?? media.mimeType}, media ID ${id}. Open it with analyze_media if it matters.]`
                  : '\n[File not kept: it was not sent to you.]',
              );
            }
            await insertMessage(
              tx,
              {
                id: stableUuid(`heard:${channel.id}:${data.chatId}:${data.requestKey}`),
                profileId: channel.profileId,
                sessionId: outcome.contact.sessionId,
                role: 'user',
                content: `${data.displayName ?? data.actorId}: ${data.text}${heard.join('')}`,
                author: authorOf(data),
                createdAt: new Date().toISOString(),
              },
              true,
            );
            // An open conversation shows it now, as it would a turn the agent answered.
            await recordEvent(tx, Date.now, channel.profileId, 'session.message', {
              sessionId: outcome.contact.sessionId,
            });
          }
        }
        // Intake and attachment persistence share the approval lock: approval cannot miss pixels.
        if (
          outcome.status !== 'blocked' &&
          (data.scope === 'direct' || outcome.status === 'approved') &&
          (!decision || decision.speak) &&
          this.services.media
        ) {
          const contact =
            outcome.status === 'approved'
              ? outcome.contact
              : await findContactByIdentity(tx, channel.id, data.chatId, data.actorId);
          if (contact)
            for (const [index, media] of (data.media ?? []).entries()) {
              try {
                mediaIds.push(
                  await this.services.media.stage(
                    tx,
                    channel.profileId,
                    contact.id,
                    contact.sessionId,
                    `${channel.id}:${data.requestKey}:${index}`,
                    media,
                  ),
                );
              } catch (error) {
                if (!(error instanceof GatewayError) || ![413, 429].includes(error.statusCode))
                  throw error;
                data.text = `${data.text.slice(0, 7600)}\n[Attachment rejected: ${error.message}]`;
              }
            }
        }
        return { ...outcome, ...(decision ? { decision } : {}) };
      },
    );
    // Every sticker from a conversation the owner approved joins the agent's collection, sent to
    // it or not: that is how the collection grows with the people it talks to.
    if (intake.status === 'approved' && this.services.stickers) {
      for (const media of data.media ?? []) {
        if (media.sticker)
          await this.services.stickers.keep(channel.profileId, media).catch(() => undefined);
      }
    }

    if (intake.status !== 'approved') {
      return { accepted: false, contact: intake.status };
    }

    if (intake.decision && !intake.decision.speak) {
      return { accepted: false, contact: 'approved' as const, silence: intake.decision.reason };
    }

    // The answer to a question the agent put to this contact belongs to the conversation that
    // asked, not to this one: nobody here is waiting for it.
    if (data.scope === 'direct') {
      const errand = await this.services.store.transaction(channel.profileId, (tx) =>
        this.errands.answer(tx, intake.contact.id, data.text, data.requestKey),
      );

      if (errand) {
        const relayed = await this.relay(channel, intake.contact, errand, data, mediaIds);

        // The asking conversation was busy. The answer is on the errand either way, and it
        // still reaches the owner as an ordinary turn rather than disappearing.
        if (relayed) {
          return relayed;
        }
      }
    }

    // In a room the author is part of the message: an agent answers people and colleagues by
    // name, and it can only do that if it reads who wrote what.
    const text =
      data.scope === 'group' ? `${data.displayName ?? data.actorId}: ${data.text}` : data.text;

    const author = data.scope === 'group' ? authorOf(data) : undefined;
    let run: Awaited<ReturnType<typeof this.submit>>;

    try {
      run = await this.submit(
        channel,
        intake.contact,
        text,
        data.requestKey,
        connectionGeneration,
        intake.decision?.turn,
        mediaIds,
        author,
      );
    } catch (error) {
      if (!(error instanceof NoModelAvailable)) throw error;

      await this.withoutModel(
        channel,
        intake.contact,
        text,
        data.requestKey,
        connectionGeneration,
        author,
      );

      return { accepted: false, contact: 'approved' as const, silence: 'no-model' as const };
    }

    return { accepted: true, runId: run.id, contact: 'approved' as const };
  }

  /**
   * A message that cannot start a turn because the profile has no model. It is kept in the
   * conversation, so the owner sees what arrived, and the chat is told why nothing answers.
   * Settling it here matters as much as the notice: refused, it would stay first in the
   * channel's queue and hold back every message behind it until a model exists.
   */
  private async withoutModel(
    channel: ChannelRecord,
    contact: ContactRecord,
    text: string,
    requestKey: string,
    connectionGeneration?: number,
    author?: { id: string; name?: string },
  ) {
    const sessionId = assertFound(contact.sessionId ?? null, 'Session');
    const key = `${channel.id}\u0000${contact.chatId}`;
    const now = Date.now();
    const tell = now - (this.toldNoModel.get(key) ?? 0) >= NO_MODEL_NOTICE_MS;

    await this.services.store.transaction(channel.profileId, async (tx) => {
      await insertMessage(
        tx,
        {
          id: stableUuid(`no-model:${channel.id}:${contact.chatId}:${requestKey}`),
          profileId: channel.profileId,
          sessionId,
          role: 'user',
          content: text,
          ...(author ? { author } : {}),
          createdAt: new Date(now).toISOString(),
        },
        true,
      );
      await recordEvent(tx, Date.now, channel.profileId, 'session.message', { sessionId });

      if (tell && this.registry.get(channel.type).send) {
        await insertDelivery(tx, {
          id: randomUUID(),
          profileId: channel.profileId,
          channelId: channel.id,
          chatId: contact.chatId,
          notice: NO_MODEL_NOTICE,
          status: 'pending',
          createdAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString(),
          remoteMessageIds: [],
          saidCount: 0,
          connectionGeneration,
        });
      }
    });

    if (tell) this.toldNoModel.set(key, now);
    channelLog('ingress.no_model', { channelId: channel.id });
  }

  /**
   * A reaction is read, not answered: it goes into the conversation as a line the agent sees
   * next time it speaks there, and starts nothing. Only a conversation already approved keeps
   * one; a stranger's reaction is not a request.
   */
  private async noteReaction(
    channel: ChannelRecord,
    data: IncomingMessage,
  ): Promise<IngressResult> {
    const group = data.scope === 'group';

    return this.services.store.transaction(channel.profileId, async (tx) => {
      const contact = await findContactByIdentity(
        tx,
        channel.id,
        data.chatId,
        group ? data.chatId : data.actorId,
      );

      if (contact?.status !== 'approved' || !contact.sessionId) {
        return { accepted: false };
      }

      await insertMessage(
        tx,
        {
          id: stableUuid(`reaction:${channel.id}:${data.chatId}:${data.requestKey}`),
          profileId: channel.profileId,
          sessionId: contact.sessionId,
          role: 'user',
          content: group ? `${data.displayName ?? data.actorId}: ${data.text}` : data.text,
          ...(group ? { author: authorOf(data) } : {}),
          createdAt: new Date().toISOString(),
        },
        true,
      );
      await recordEvent(tx, Date.now, channel.profileId, 'session.message', {
        sessionId: contact.sessionId,
      });

      return { accepted: false, contact: 'approved' as const, silence: 'reaction' as const };
    });
  }

  /**
   * Carries a contact's answer into the conversation that asked. It arrives as a turn there,
   * so the agent is the one who decides how to pass it on to whoever asked.
   */
  private async relay(
    channel: ChannelRecord,
    contact: ContactRecord,
    errand: { id: string; fromSessionId: string; question: string },
    data: IncomingMessage,
    mediaIds: string[] = [],
  ): Promise<{ accepted: true; runId: string; contact: 'approved' } | null> {
    const who = contact.displayName ?? data.displayName ?? contact.actorId;

    try {
      const forwarded =
        mediaIds.length && contact.sessionId && this.services.media
          ? await this.services.media.forward(
              channel.profileId,
              contact.sessionId,
              errand.fromSessionId,
              mediaIds,
            )
          : [];
      const run = await this.services.runs.submit(
        channel.profileId,
        errand.fromSessionId,
        {
          mediaIds: forwarded,
          text: [
            `${who} answered the question you sent them.`,
            `You asked: ${errand.question}`,
            `They replied: ${data.text}`,
          ].join('\n\n'),
          requestKey: createHash('sha256')
            .update(JSON.stringify(['errand', errand.id, data.requestKey]))
            .digest('hex'),
        },
        { activity: 'channel' },
      );

      // The answer arrived in their conversation; it is recorded there as well as carried
      // into the one that asked, or their own history shows a question and no reply.
      if (contact.sessionId) {
        await this.services.store.transaction(channel.profileId, (tx) =>
          insertMessage(
            tx,
            {
              id: stableUuid(`relay:${run.id}:${data.requestKey}`),
              profileId: channel.profileId,
              sessionId: contact.sessionId as string,
              runId: run.id,
              role: 'user',
              content: data.text,
              createdAt: new Date().toISOString(),
            },
            true,
          ),
        );
      }

      if (contact.sessionId && mediaIds.length)
        await this.services.store.transaction(channel.profileId, (tx) =>
          bindMedia(tx, channel.profileId, contact.sessionId as string, mediaIds, run.id),
        );
      await this.deliverRun(channel.profileId, errand.fromSessionId, run.id);

      return { accepted: true, runId: run.id, contact: 'approved' as const };
    } catch {
      return null;
    }
  }

  /** The binding, not the inbound payload, chooses the profile and session. */
  private async submit(
    channel: ChannelRecord,
    contact: ContactRecord,
    text: string,
    requestKey: string,
    connectionGeneration?: number,
    group?: GroupTurn,
    mediaIds: string[] = [],
    author?: { id: string; name?: string },
  ) {
    const sessionId = assertFound(contact.sessionId ?? null, 'Session');

    const run = await this.services.runs.submit(
      channel.profileId,
      sessionId,
      {
        text,
        mediaIds,
        requestKey: createHash('sha256')
          .update(JSON.stringify([channel.id, contact.chatId, contact.actorId, requestKey]))
          .digest('hex'),
      },
      { activity: 'channel', ...(group ? { group } : {}), ...(author ? { author } : {}) },
    );

    if (this.registry.get(channel.type).send) {
      await this.services.store.transaction(channel.profileId, async (tx) => {
        if (await findDelivery(tx, run.id)) {
          return;
        }

        const now = new Date().toISOString();

        await insertDelivery(tx, {
          id: run.id,
          runId: run.id,
          profileId: channel.profileId,
          channelId: channel.id,
          chatId: contact.chatId,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
          remoteMessageIds: [],
          saidCount: 0,
          connectionGeneration,
        });
      });
    }

    return run;
  }

  private async notify(
    tx: Queryable,
    channel: ChannelRecord,
    chatId: string,
    connectionGeneration?: number,
  ) {
    if (!this.registry.get(channel.type).send) {
      return;
    }

    const now = new Date().toISOString();

    await insertDelivery(tx, {
      id: randomUUID(),
      profileId: channel.profileId,
      channelId: channel.id,
      chatId,
      notice: APPROVAL_NOTICE,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      remoteMessageIds: [],
      saidCount: 0,
      connectionGeneration,
    });
  }

  /**
   * The rooms this installation is in, with the profiles that sit in each one. A group is a
   * conversation several agents share, so the owner reads it whole instead of once per profile.
   */
  async groups(): Promise<Group[]> {
    const contacts = await listGroupContacts(this.services.store.db);
    const names = new Map<string, string | null>();

    const rooms = new Map<string, Group>();

    for (const contact of contacts) {
      const key = `${contact.type}\u0000${contact.chatId}`;
      const room = rooms.get(key) ?? { type: contact.type, chatId: contact.chatId, profiles: [] };

      if (!names.has(contact.profileId)) {
        const profile = await this.services.profiles.profile(contact.profileId).catch(() => null);

        names.set(contact.profileId, profile?.name ?? null);
      }

      if (contact.displayName && !room.name) {
        room.name = contact.displayName;
      }

      room.profiles.push({
        profileId: contact.profileId,
        name: names.get(contact.profileId) ?? 'Perfil removido',
        contactId: contact.id,
        status: contact.status,
      });

      rooms.set(key, room);
    }

    return [...rooms.values()].map((room) => ({
      ...room,
      profiles: room.profiles.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }

  /**
   * Gives a run its way out to the person. A run created from an incoming message gets this
   * when the message arrives; one created by the gateway itself — a colleague's late answer, a
   * contact's reply — has no incoming message to hang it on, and without this its answer
   * reaches the transcript and nothing else.
   */
  async deliverRun(
    profileId: string,
    sessionId: string,
    runId: string,
    transaction?: Store['db'],
  ): Promise<void> {
    const db = transaction ?? this.services.store.db;
    const contact = await findContactBySession(db, profileId, sessionId);

    if (contact?.status !== 'approved') {
      return;
    }

    // A run already on its way out needs no second exit. A late answer that arrived while the
    // conversation was busy joins the turn in flight instead of starting one, and a second
    // delivery against that turn would replay every message it had already sent.
    if (await hasDelivery(db, runId)) {
      return;
    }

    const connection = await findConnection(db, contact.channelId);
    const now = new Date().toISOString();

    const delivery = {
      id: randomUUID(),
      profileId,
      channelId: contact.channelId,
      runId,
      chatId: contact.chatId,
      status: 'pending' as const,
      createdAt: now,
      updatedAt: now,
      remoteMessageIds: [],
      saidCount: 0,
      ...(connection ? { connectionGeneration: connection.generation } : {}),
    };
    if (transaction) await insertDelivery(transaction, delivery);
    else await this.services.store.transaction(profileId, (tx) => insertDelivery(tx, delivery));
  }

  async deliveries(profileId: string) {
    await this.services.profiles.profile(profileId);

    return listDeliveries(this.services.store.db, profileId);
  }

  async dispatch() {
    await this.recoverUncertainDeliveries();

    const deliveries = await listDeliveriesByPhase(this.services.store.db, 'pending', 20);

    for (const delivery of deliveries) {
      if (this.stopped) {
        return;
      }

      let text = delivery.notice ?? '';
      let commentary: string[] = [];
      // What the room received from the agent itself, not a failure notice the gateway wrote.
      let spoken = Boolean(delivery.notice);

      if (delivery.runId) {
        const run = await this.services.runs.run(delivery.profileId, delivery.runId);

        commentary = run.commentary ?? [];

        if (run.status === 'queued' || run.status === 'running') {
          // Anything the agent has said on its way to a tool goes out now. The answer follows
          // when the run ends, so the chat moves with the work instead of after it.
          if (!(await this.saySoFar(delivery, commentary))) {
            await this.showProgress(delivery);
          }

          continue;
        }

        // The reason the gateway stored is already redacted and one line: saying it here is what
        // lets someone on a phone understand what went wrong without the gateway's log.
        text =
          run.output ??
          (run.error
            ? `⚠️ I could not finish this.\n\n${run.error}`
            : '⚠️ I could not finish this, and no reason was recorded.');
        spoken = run.output !== undefined;
      }

      const channel = await findChannel(this.services.store.db, delivery.channelId);
      const adapter = channel ? this.registry.get(channel.type) : undefined;

      const generationChanged =
        delivery.connectionGeneration !== undefined &&
        (await findConnection(this.services.store.db, delivery.channelId))?.generation !==
          delivery.connectionGeneration;

      // A linked device can only send from its owning worker. Offline deliveries stay pending.
      if (
        !generationChanged &&
        channel &&
        !channel.revokedAt &&
        adapter?.canSend &&
        !(await adapter.canSend(channel.id))
      ) {
        continue;
      }

      // A run that finished between two ticks leaves its last lines unsent; they belong in
      // front of the answer, not lost.
      await this.saySoFar(delivery, commentary);

      if (!(await this.claimDelivery(delivery))) {
        continue;
      }

      const outcome = await this.deliver(delivery, text);

      await this.services.store.transaction(delivery.profileId, async (tx) => {
        const current = assertFound(await findDelivery(tx, delivery.id), 'Delivery');

        await updateDelivery(tx, {
          ...current,
          ...outcome,
          // A retry keeps the ids of what is already on screen; the attempt confirmed none.
          remoteMessageIds: outcome.remoteMessageIds.length
            ? outcome.remoteMessageIds
            : current.remoteMessageIds,
          updatedAt: new Date().toISOString(),
        });
      });
      channelLog('delivery.result', {
        channelId: delivery.channelId,
        deliveryId: delivery.id,
        runId: delivery.runId ?? undefined,
        status: outcome.status,
      });

      if (outcome.status === 'sent' && channel && spoken) {
        // The paragraphs said while working went out first; the other agents read the turn
        // whole, as the room did. What they missed is logged, not retried: the room has it.
        const turn = [...commentary, text].filter(Boolean).join('\n\n');

        await this.showToOtherAgents(channel, delivery, turn).catch(() =>
          channelLog('delivery.peer_failed', {
            channelId: delivery.channelId,
            deliveryId: delivery.id,
          }),
        );
      }
    }
  }

  /**
   * What an agent said in a room, handed to the installation's other agents in it when the
   * protocol will not. It enters each of them exactly as a message from the room would: kept in
   * their session as something heard, answered only when it calls them, and counted against
   * the room's budget of turns between agents. The delivery id keeps a retried tick from
   * handing it over twice.
   */
  private async showToOtherAgents(channel: ChannelRecord, delivery: DeliveryRecord, text: string) {
    if (!this.registry.get(channel.type).hidesAgentsFromEachOther || !channel.address) {
      return;
    }

    const room = await listGroupContacts(this.services.store.db, {
      type: channel.type,
      chatId: delivery.chatId,
      status: 'approved',
    });

    if (!room.some((contact) => contact.channelId === channel.id)) {
      return;
    }

    const author = await this.services.profiles.profile(channel.profileId);

    for (const contact of room) {
      if (contact.channelId === channel.id) {
        continue;
      }

      const peer = await findChannel(this.services.store.db, contact.channelId);

      if (!peer || peer.revokedAt) {
        continue;
      }

      await this.accept(peer, {
        actorId: channel.address,
        chatId: delivery.chatId,
        text: text.slice(0, 8000),
        requestKey: `agent:${delivery.id}`,
        displayName: author.name,
        scope: 'group',
        ...(contact.displayName ? { groupName: contact.displayName } : {}),
        // An agent cannot mention through the protocol; the handles it writes are its mentions.
        mentions: [...new Set(text.toLowerCase().match(/@[a-z0-9_]{3,64}/g) ?? [])],
      });
    }
  }

  /**
   * Sends what the run has said since the last tick, and reports whether anything went. The
   * count is raised before the send and under the profile lock: two workers, or two ticks,
   * would otherwise both read the same backlog and the person would see it twice. The cost of
   * that order is a message lost to a failing adapter, which is the right way round — a
   * duplicate is confusing and this is commentary, not the answer.
   */
  private async saySoFar(delivery: DeliveryRecord, commentary: string[]): Promise<boolean> {
    if (commentary.length <= delivery.saidCount) {
      return false;
    }

    const claimed = await this.services.store.transaction(delivery.profileId, async (tx) => {
      const current = await findDelivery(tx, delivery.id);

      if (current?.status !== 'pending' || current.saidCount >= commentary.length) {
        return [];
      }

      await updateDelivery(tx, {
        ...current,
        saidCount: commentary.length,
        updatedAt: new Date().toISOString(),
      });

      return commentary.slice(current.saidCount);
    });

    for (const text of claimed) {
      await this.deliver(delivery, text);
    }

    return claimed.length > 0;
  }

  /**
   * While a run is live and silent the chat shows only that the agent is answering. The answer
   * itself is never shown half-written: it arrives when it is finished, as the messages it was
   * written in. Nothing here is history, so a tick that fails is simply skipped.
   */
  private async showProgress(delivery: DeliveryRecord): Promise<void> {
    const channel = await findChannel(this.services.store.db, delivery.channelId);

    if (!channel || channel.revokedAt) {
      return;
    }

    const adapter = this.registry.get(channel.type);

    if (!adapter.typing || (adapter.canSend && !(await adapter.canSend(channel.id)))) {
      return;
    }

    await adapter
      .typing(delivery.chatId, {
        channelId: delivery.channelId,
        connectionGeneration: delivery.connectionGeneration,
        credential: await this.services.vault.read(delivery.profileId, channelSecret(channel.id)),
        fetch: this.fetcher,
        signal: this.abort.signal,
      })
      .catch(() => undefined);
  }

  private async claimDelivery(delivery: DeliveryRecord): Promise<boolean> {
    return this.services.store.transaction(delivery.profileId, async (tx) => {
      const current = await findDelivery(tx, delivery.id);

      if (current?.status !== 'pending') {
        return false;
      }

      // Persist intent before network I/O so another worker cannot send the same delivery.
      await updateDelivery(tx, {
        ...current,
        status: 'sending',
        updatedAt: new Date().toISOString(),
      });

      return true;
    });
  }

  private async deliver(delivery: DeliveryRecord, text: string): Promise<DeliveryOutcome> {
    let attemptedSend = false;

    try {
      const channel = await findChannel(this.services.store.db, delivery.channelId);

      if (!channel || channel.revokedAt) {
        throw new Error('Channel unavailable');
      }

      if (delivery.connectionGeneration !== undefined) {
        const connection = await findConnection(this.services.store.db, delivery.channelId);

        if (!connection?.desired || connection.generation !== delivery.connectionGeneration) {
          throw new Error('Delivery belongs to a disconnected device');
        }
      }

      const adapter = this.registry.get(channel.type);

      const credential = await this.services.vault.read(
        delivery.profileId,
        channelSecret(channel.id),
      );

      if (!adapter.send || (!text && !delivery.mediaId)) {
        throw new Error('Channel does not support delivery');
      }

      attemptedSend = true;

      const context = {
        channelId: delivery.channelId,
        connectionGeneration: delivery.connectionGeneration,
        credential,
        fetch: this.fetcher,
        signal: this.abort.signal,
      };
      const people = await this.groupPeople(delivery);

      if (delivery.mediaId) {
        if (!this.services.media) throw new Error('Media delivery is unavailable');
        const media = await this.services.media.read(delivery.profileId, delivery.mediaId);
        return adapter.send(
          {
            chatId: delivery.chatId,
            text,
            media: {
              mimeType: media.mimeType as import('@jian/contracts').InlineMedia['mimeType'],
              data: media.data,
              ...(media.name ? { name: media.name } : {}),
              ...(media.sticker ? { sticker: true } : {}),
            },
            people,
          },
          context,
        );
      }

      const parts = adapter.rendersMarkdown
        ? [text.trim()]
        : conversational(plainText(text), MESSAGE_LIMIT);

      const remoteMessageIds: Array<string | number> = [];

      for (const [index, part] of parts.entries()) {
        if (index > 0) {
          // Between messages the bubble goes back to composing, and the pause is what keeps a
          // three-part answer from landing as one burst of notifications.
          await adapter.typing?.(delivery.chatId, context).catch(() => undefined);
          await pause(Math.min(BETWEEN_MESSAGES_MS, 200 + part.length * 8), this.abort.signal);
        }

        const outcome = await adapter.send(
          { chatId: delivery.chatId, text: part, people },
          context,
        );

        remoteMessageIds.push(...outcome.remoteMessageIds);

        if (outcome.status !== 'sent') {
          // Part of the answer is already there, so nothing may be replayed from the start.
          return {
            status: remoteMessageIds.length ? 'unknown' : outcome.status,
            remoteMessageIds,
          };
        }
      }

      return { status: 'sent', remoteMessageIds };
    } catch {
      // An unexpected adapter failure may happen after a remote write. Never retry it blindly.
      return { status: attemptedSend ? 'unknown' : 'failed', remoteMessageIds: [] };
    }
  }

  /**
   * Everyone known to have written in the group a delivery goes to, by the name they write
   * under: what lets the channel turn the agent's `@Name` into a real mention. A direct chat
   * has nobody to mention.
   */
  private async groupPeople(delivery: DeliveryRecord) {
    const db = this.services.store.db;
    // A room is its own actor, so the group's contact is found by the chat twice.
    const group = await findContactByIdentity(
      db,
      delivery.channelId,
      delivery.chatId,
      delivery.chatId,
    );

    if (group?.scope !== 'group' || !group.sessionId) return [];

    const people = await sessionPeople(db, delivery.profileId, group.sessionId);

    return people.flatMap((person) =>
      person.displayName ? [{ id: person.actorId, name: person.displayName }] : [],
    );
  }

  private async recoverUncertainDeliveries(): Promise<void> {
    const sending = await listDeliveriesByPhase(this.services.store.db, 'sending', 100);

    for (const delivery of sending) {
      if (Date.parse(delivery.updatedAt) > Date.now() - UNCERTAIN_DELIVERY_AFTER_MS) {
        continue;
      }

      await this.services.store.transaction(delivery.profileId, async (tx) => {
        const current = await findDelivery(tx, delivery.id);

        // Recheck under the profile lock: another worker may have confirmed this delivery.
        if (
          current?.status === 'sending' &&
          Date.parse(current.updatedAt) <= Date.now() - UNCERTAIN_DELIVERY_AFTER_MS
        ) {
          await updateDelivery(tx, {
            ...current,
            status: 'unknown',
            updatedAt: new Date().toISOString(),
          });
        }
      });
    }
  }
}
