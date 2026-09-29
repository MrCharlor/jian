import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelConfig } from '@jian/contracts';
import type { LanguageModel } from 'ai';
import { createSafeFetch } from '../security/outbound.js';
import { providerEnvironment } from './catalog.js';
import {
  anthropicCredential,
  subscriptionFetch,
  subscriptionHeaders,
} from './claude-subscription.js';
import { createCodexModel } from './codex/model.js';

const defaultOutbound = createSafeFetch();

export async function resolveModel(
  config: ModelConfig,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof globalThis.fetch = defaultOutbound.fetch,
  explicitKey?: string,
): Promise<LanguageModel> {
  const apiKey =
    explicitKey ??
    (config.apiKeyEnv ? env[config.apiKeyEnv] : undefined) ??
    (config.apiKeyEnv ||
    config.providerId ||
    config.provider === 'openai-compatible' ||
    config.provider === 'openai-codex'
      ? undefined
      : env[providerEnvironment(config.provider, env) ?? '']);

  if (!apiKey) {
    throw new Error('Provider key is not configured');
  }

  // The local Caveman listener is opt-in. Do not redirect custom endpoints or subscription
  // protocols through an API-key route whose behavior has not been verified.
  const proxy =
    env.JIAN_CAVEMAN_ENABLED === 'true'
      ? (env.JIAN_CAVEMAN_PROXY_URL || 'http://127.0.0.1:8788').replace(/\/$/, '')
      : undefined;

  switch (config.provider) {
    case 'openai':
      return createOpenAI({
        apiKey,
        baseURL: !config.baseURL && proxy ? `${proxy}/w/jian/openai/v1` : config.baseURL,
        fetch: fetcher,
      })(config.modelId);
    case 'openai-codex':
      return createCodexModel(apiKey, config.modelId, fetcher);
    case 'openrouter':
      // The router speaks the OpenAI shape; its model ids carry the vendor prefix as given.
      return createOpenAICompatible({
        name: 'openrouter',
        apiKey,
        baseURL: config.baseURL ?? 'https://openrouter.ai/api/v1',
        fetch: fetcher,
      }).chatModel(config.modelId);
    case 'anthropic': {
      // A subscription token is not a key: it goes as a bearer, with Claude Code's own betas
      // and client identity, or Anthropic refuses it however valid it is.
      const subscription =
        anthropicCredential(config.credential, config.apiKeyEnv, apiKey) === 'subscription';

      return createAnthropic({
        ...(subscription ? { authToken: apiKey, headers: subscriptionHeaders() } : { apiKey }),
        baseURL: !subscription && !config.baseURL && proxy ? `${proxy}/w/jian/v1` : config.baseURL,
        fetch: subscription ? await subscriptionFetch(fetcher) : fetcher,
      })(config.modelId);
    }
    case 'google':
      return createGoogleGenerativeAI({ apiKey, baseURL: config.baseURL, fetch: fetcher })(
        config.modelId,
      );
    case 'openai-compatible':
      if (!config.baseURL) {
        throw new Error('baseURL is required for compatible providers');
      }
      return createOpenAICompatible({
        name: 'compatible',
        apiKey,
        baseURL: config.baseURL,
        fetch: fetcher,
      }).chatModel(config.modelId);
  }
}
