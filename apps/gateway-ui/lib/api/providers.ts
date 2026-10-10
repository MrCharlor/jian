import { type Client, profile } from './params';
import { result } from './result';
import type { DecisionsSettingsPatch, ModelDefaultsInput, NewProvider } from './types';

/**
 * A credential belongs to the installation; the roles it is bound to belong to a profile. That
 * split is why the first four calls take no profile and the last two do.
 */
export const providerCalls = (client: Client) => ({
  providers: () => result(client.GET('/v1/providers')),
  createProvider: (body: NewProvider) => result(client.POST('/v1/providers', { body })),
  revokeProvider: (providerId: string) =>
    result(client.DELETE('/v1/providers/{providerId}', { params: { path: { providerId } } })),
  providerModels: (providerId: string) =>
    result(client.GET('/v1/providers/{providerId}/models', { params: { path: { providerId } } })),
  startCodexLogin: () => result(client.POST('/v1/providers/openai/oauth')),
  codexLogin: () => result(client.GET('/v1/providers/openai/oauth')),
  modelDefaults: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/model-defaults', { params: profile(profileId) })),
  webSearch: () => result(client.GET('/v1/web-search')),
  setWebSearch: (apiKey: string) =>
    result(client.PUT('/v1/web-search', { body: { provider: 'tavily', apiKey } })),
  removeWebSearch: () => result(client.DELETE('/v1/web-search')),
  prototypePrints: () => result(client.GET('/v1/prototype-prints')),
  setPrototypePrints: (token: string) =>
    result(client.PUT('/v1/prototype-prints', { body: { token } })),
  removePrototypePrints: () => result(client.DELETE('/v1/prototype-prints')),
  decisions: () => result(client.GET('/v1/decisions')),
  setDecisions: (apiKey: string) =>
    result(client.PUT('/v1/decisions', { body: { provider: 'jev', apiKey } })),
  updateDecisions: (body: DecisionsSettingsPatch) =>
    result(client.PATCH('/v1/decisions', { body })),
  removeDecisions: () => result(client.DELETE('/v1/decisions')),
  setModelDefaults: (profileId: string, body: ModelDefaultsInput) =>
    result(
      client.PUT('/v1/profiles/{profileId}/model-defaults', { params: profile(profileId), body }),
    ),
});
