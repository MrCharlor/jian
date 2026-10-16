import type { InboxKind } from '@jian/contracts';
import type { Settings } from './service.js';

type Panel = (profileId: string, text: string, requestKey: string) => Promise<unknown>;
type Channels = { tellOwners(profileId: string, text: string): Promise<number> };
type Numbers = { announce(kinds: InboxKind[]): Promise<{ panel: string; chat: string }> };

/** The inbox kinds a notice of each kind brings, so it ends with their numbers (B26). */
const INBOX_KINDS: Record<string, InboxKind[]> = {
  plan: ['plano'],
  knowledge: ['regra'],
  validation: ['validacao', 'comentario'],
  mention: ['mencao'],
  roadmap: ['roadmap'],
};

/**
 * The gateway's own word to the owner: a plan waiting, epics to validate. It always reaches the
 * owner's panel conversation, as before; with `panel_and_channel` it is also given as written
 * to the contacts marked as the owner, who answer it from there with the same commands.
 */
export class OwnerNotices {
  private channels?: Channels;
  private inbox?: Numbers;

  constructor(
    private readonly settings: Pick<Settings, 'ownerNotices'>,
    private readonly profile: () => Promise<string | undefined>,
    private readonly panel: Panel,
  ) {}

  /** Wired after construction: channels are built from the services, outside them. */
  useChannels(channels: Channels) {
    this.channels = channels;
  }

  /** Wired after construction: the inbox reads every queue, built after this one. */
  useInbox(inbox: Numbers) {
    this.inbox = inbox;
  }

  /** `short`, when given, is what a chat gets instead: the gist and the command to answer. */
  async tell(given: string, kind: string, givenShort?: string): Promise<void> {
    const profileId = await this.profile();

    if (!profileId) return;

    // A notice that never reached the owner must not keep the numbers it would have brought.
    // On a phone the inbox lines stand in for the notice: one line per item, the numbers only.
    const kinds = INBOX_KINDS[kind];
    const numbers =
      kinds && this.inbox
        ? await this.inbox.announce(kinds).catch(() => ({ panel: '', chat: '' }))
        : { panel: '', chat: '' };
    const text = numbers.panel ? `${given}\n${numbers.panel}` : given;
    const short = numbers.chat || givenShort;

    // One failing must not keep the notice from the other: each is the owner's only way to see it.
    const [panel, channel] = await Promise.allSettled([
      this.panel(profileId, text, `${kind}:${Date.now()}`),
      this.toChannels(profileId, short ?? text),
    ]);

    for (const outcome of [panel, channel]) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
  }

  private async toChannels(profileId: string, text: string): Promise<number> {
    if (!this.channels || (await this.settings.ownerNotices()) !== 'panel_and_channel') return 0;

    return this.channels.tellOwners(profileId, text);
  }
}
