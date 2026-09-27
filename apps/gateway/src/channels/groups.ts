import { GROUP_AGENT_TURN_LIMIT, type GroupTurn } from '@jian/contracts';
import type { Ask } from '../decisions/service.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Queryable } from '../storage/database.js';
import type { IncomingMessage } from './channel.js';
import type { ContactRecord } from './contacts.js';
import { listGroupContacts, listLiveChannelsOfType, updateContact } from './repository.js';
import type { ChannelRecord } from './service.js';

/**
 * How many recent protocol message ids a room remembers. A redelivered message must not spend
 * a turn twice, and the protocols repeat the most recent messages, not arbitrary old ones.
 */
const OBSERVED_KEYS = 32;

/** Above this probability a message that names an agent is taken as calling it. */
const VERDICT_THRESHOLD = 0.5;

export type GroupDecision =
  | { speak: true; turn: GroupTurn }
  | { speak: false; reason: 'unaddressed' | 'budget' };

type Participant = { profileId: string; name: string };

const quote = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Case and accents are not how a person addresses an agent, so neither decides the match. */
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();

/**
 * A room where people and agents write. Two rules keep it usable: an agent reads everything but
 * answers only when called, and the agents of this installation share one budget of
 * consecutive turns, so a conversation between them ends without a person having to stop it.
 */
export class Groups {
  constructor(
    private readonly profiles: ProfileReader,
    private readonly ask?: Ask,
  ) {}

  /** How this profile is called in a room through this channel. */
  static self(channel: ChannelRecord, name: string) {
    // The API server has no protocol identity; the adapter calling it mentions the channel id.
    const address = channel.address ?? (channel.type === 'api' ? channel.id : undefined);

    return {
      name,
      ...(address ? { address } : {}),
      ...(channel.handle ? { handle: channel.handle } : {}),
    };
  }

  /** The gestures the protocol offers for calling an agent: a mention, or a reply to it. */
  static called(message: IncomingMessage, self: { address?: string; handle?: string }): boolean {
    const called = [self.address, self.handle].filter((item): item is string => Boolean(item));

    return called.some((item) => message.mentions.includes(item) || message.replyTo === item);
  }

  /** The name in the text, and the first word of a composed name, because that is how it is written. */
  static named(text: string, name: string): boolean {
    const folded = fold(text);
    const full = fold(name).trim();
    const first = full.split(/\s+/)[0] ?? '';
    const words = new Set([full, ...(first.length >= 3 ? [first] : [])]);

    return [...words].some((word) =>
      new RegExp(`(?<![\\p{L}\\p{N}])${quote(word)}(?![\\p{L}\\p{N}])`, 'u').test(folded),
    );
  }

  /**
   * A person calls an agent the way the protocol offers: a mention of its connection, or a
   * reply to one of its messages. Agents cannot produce either gesture, so from another agent
   * the name in the text counts. A name alone is ambiguous — people and agents talk *about* an
   * agent too — so when a `verdict` on it exists, it decides; without one, the name calls only
   * when an agent wrote it.
   */
  static addressed(
    message: IncomingMessage,
    self: { name: string; address?: string; handle?: string },
    fromAgent: boolean,
    verdict?: boolean,
  ): boolean {
    if (Groups.called(message, self)) {
      return true;
    }

    return Groups.named(message.text, self.name) && (verdict ?? fromAgent);
  }

  /**
   * Asks whether a message that names this agent, without mentioning it, is speaking to it.
   * Only for a room this profile already takes part in: an unapproved room's messages do not
   * leave the gateway. `undefined` leaves the decision to the fixed rule.
   */
  async verdict(
    reader: Queryable,
    channel: ChannelRecord,
    message: IncomingMessage,
  ): Promise<boolean | undefined> {
    if (!this.ask) {
      return undefined;
    }

    const self = Groups.self(channel, (await this.profiles.profile(channel.profileId)).name);

    if (Groups.called(message, self) || !Groups.named(message.text, self.name)) {
      return undefined;
    }

    const members = await listGroupContacts(reader, {
      type: channel.type,
      chatId: message.chatId,
      status: 'approved',
    });

    if (!members.some((item) => item.profileId === channel.profileId)) {
      return undefined;
    }

    // With several agents in a room, one message often names two of them and speaks to one.
    // Knowing who else is there is what lets the answer tell them apart.
    const others: string[] = [];

    for (const member of members) {
      if (member.profileId === channel.profileId) continue;

      const profile = await this.profiles.profile(member.profileId).catch(() => null);

      if (profile) others.push(profile.name);
    }

    const yes = await this.ask({
      state: {
        room: message.groupName ?? message.chatId,
        agent: self.name,
        ...(others.length ? { otherAgents: others } : {}),
        from: message.displayName ?? message.actorId,
        message: message.text.slice(0, 4000),
      },
      instructions: `Is this group message speaking to ${self.name} — asking them to answer or to do something now — rather than only talking about them${others.length ? ' or speaking to one of `otherAgents`' : ''}?`,
      yes: `The message addresses ${self.name} and expects them to respond.`,
      no: `The message only mentions ${self.name}, quotes them, or is meant for someone else.`,
    });

    return yes === undefined ? undefined : yes >= VERDICT_THRESHOLD;
  }

  /** The other profiles of this installation, recognised by the address their channel speaks as. */
  private async fromAgent(tx: Queryable, channel: ChannelRecord, actorId: string) {
    const channels = await listLiveChannelsOfType(tx, channel.type);

    return channels.some((item) => item.id !== channel.id && item.address === actorId);
  }

  /** Who of this installation answers in this room: an approved group contact is membership. */
  async participants(tx: Queryable, contact: ContactRecord): Promise<Participant[]> {
    const contacts = await listGroupContacts(tx, {
      type: contact.type,
      chatId: contact.chatId,
      status: 'approved',
    });

    const participants: Participant[] = [];

    for (const item of contacts) {
      const profile = await this.profiles.profile(item.profileId, tx).catch(() => null);

      if (profile) {
        participants.push({ profileId: profile.id, name: profile.name });
      }
    }

    return participants;
  }

  /**
   * Reads one group message and decides whether this profile answers it. The counter lives on
   * the room's contact and is written here, inside the caller's transaction: observing an
   * agent spends a turn, a person writing returns the budget, and a message already seen
   * changes nothing — a protocol redelivery is the same turn, not a new one.
   */
  async observe(
    tx: Queryable,
    channel: ChannelRecord,
    contact: ContactRecord,
    message: IncomingMessage,
    profileName: string,
    verdict?: boolean,
  ): Promise<GroupDecision> {
    const fromAgent = await this.fromAgent(tx, channel, message.actorId);
    const seen = contact.seen ?? [];
    const duplicate = seen.includes(message.requestKey);
    const observed = duplicate
      ? (contact.agentTurns ?? 0)
      : fromAgent
        ? (contact.agentTurns ?? 0) + 1
        : 0;

    const save = async (turns: number) => {
      if (duplicate) {
        return;
      }

      await updateContact(tx, {
        ...contact,
        agentTurns: turns,
        seen: [...seen, message.requestKey].slice(-OBSERVED_KEYS),
      });
    };

    const participants = await this.participants(tx, contact);
    const others = participants.filter((item) => item.profileId !== channel.profileId);
    const self = Groups.self(channel, profileName);

    // Even alone in the room: a group is a conversation among people, not a request to the agent.
    if (!Groups.addressed(message, self, fromAgent, verdict)) {
      await save(observed);

      return { speak: false, reason: 'unaddressed' };
    }

    // A message already seen is judged by the same spent budget: a redelivery must never be
    // what reopens a conversation the limit closed.
    if (fromAgent && observed >= GROUP_AGENT_TURN_LIMIT) {
      await save(observed);

      return { speak: false, reason: 'budget' };
    }

    const turns = Math.min(
      duplicate ? Math.max(observed, 1) : observed + 1,
      GROUP_AGENT_TURN_LIMIT,
    );

    await save(turns);

    return {
      speak: true,
      turn: {
        chatId: contact.chatId,
        ...(contact.displayName ? { name: contact.displayName } : {}),
        fromName: message.displayName ?? message.actorId,
        fromAgent,
        turns,
        agents: others.map((item) => item.name),
      },
    };
  }
}
