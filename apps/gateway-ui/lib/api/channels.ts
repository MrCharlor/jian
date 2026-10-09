import { type Client, channel, profile } from './params';
import { result } from './result';
import type { NewChannel } from './types';

/** Channels, the pairing each one needs, and who is allowed to write through them. */
export const channelCalls = (client: Client) => ({
  channels: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/channels', { params: profile(profileId) })),
  createChannel: (profileId: string, body: NewChannel) =>
    result(client.POST('/v1/profiles/{profileId}/channels', { params: profile(profileId), body })),
  revokeChannel: (profileId: string, channelId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/channels/{channelId}', {
        params: channel(profileId, channelId),
      }),
    ),
  connect: (profileId: string, channelId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/channels/{channelId}/connect', {
        params: channel(profileId, channelId),
      }),
    ),
  connection: (profileId: string, channelId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/channels/{channelId}/connection', {
        params: channel(profileId, channelId),
      }),
    ),
  qr: (profileId: string, channelId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/channels/{channelId}/qr', {
        params: channel(profileId, channelId),
      }),
    ),
  disconnect: (profileId: string, channelId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/channels/{channelId}/disconnect', {
        params: channel(profileId, channelId),
      }),
    ),
  deliveries: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/deliveries', { params: profile(profileId) })),
  contacts: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/contacts', { params: profile(profileId) })),
  // A room belongs to the installation, not to one profile: several agents sit in the same one.
  groups: () => result(client.GET('/v1/groups')),
  approveContact: (profileId: string, contactId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/contacts/{contactId}/approve', {
        params: { path: { profileId, contactId } },
      }),
    ),
  setContactOwner: (profileId: string, contactId: string, owner: boolean) =>
    result(
      client.PUT('/v1/profiles/{profileId}/contacts/{contactId}/owner', {
        params: { path: { profileId, contactId } },
        body: { owner },
      }),
    ),
  blockContact: (profileId: string, contactId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/contacts/{contactId}/block', {
        params: { path: { profileId, contactId } },
      }),
    ),
});
