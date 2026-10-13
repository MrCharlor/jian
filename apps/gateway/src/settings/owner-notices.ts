import type { Settings } from './service.js';

type Panel = (profileId: string, text: string, requestKey: string) => Promise<unknown>;
type Channels = { tellOwners(profileId: string, text: string): Promise<number> };

/**
 * The gateway's own word to the owner: a plan waiting, epics to validate. It always reaches the
 * owner's panel conversation, as before; with `panel_and_channel` it is also given as written
 * to the contacts marked as the owner, who answer it from there with the same commands.
 */
export class OwnerNotices {
  private channels?: Channels;

  constructor(
    private readonly settings: Pick<Settings, 'ownerNotices'>,
    private readonly profile: () => Promise<string | undefined>,
    private readonly panel: Panel,
  ) {}

  /** Wired after construction: channels are built from the services, outside them. */
  useChannels(channels: Channels) {
    this.channels = channels;
  }

  /** `short`, when given, is what a chat gets instead: the gist and the command to answer. */
  async tell(text: string, kind: string, short?: string): Promise<void> {
    const profileId = await this.profile();

    if (!profileId) return;

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
