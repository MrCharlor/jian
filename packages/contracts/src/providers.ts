import { z } from 'zod';
import { secretSchema } from './security.js';

/**
 * One vocabulary for reasoning effort across providers: it maps onto OpenAI's
 * `reasoning.effort`, Anthropic's thinking budget and Gemini's thinking budget. `none` asks
 * for thinking to be off where the provider can disable it.
 *
 * Which of these a model accepts is not in any provider's model listing, so it comes from
 * the gateway's capability table and never from the provider response.
 */
export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high']);

/** Input modalities a model accepts. Also absent from the listings; also from the table. */
export const modelModalitySchema = z.enum(['text', 'image', 'audio', 'video', 'pdf']);

export const modelCapabilitiesSchema = z.strictObject({
  contextWindow: z.number().int().min(4096).max(20_000_000),
  maxOutputTokens: z.number().int().min(256).max(1_000_000),
  reasoningEfforts: z.array(reasoningEffortSchema).max(5),
  inputModalities: z.array(modelModalitySchema).min(1).max(5),
  outputModalities: z.array(modelModalitySchema).max(5).optional(),
  /**
   * False when the capability table has no entry for this model: every number above is the
   * gateway's conservative floor, not something the provider stated. The model stays
   * selectable and the panel marks it, because a missing table row is our gap, not a reason
   * to hide a model the account really has.
   */
  known: z.boolean(),
});

export const providerModelSchema = modelCapabilitiesSchema.extend({
  id: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(200).optional(),
});

/**
 * What a provider's models endpoint returned, joined with the capability table. `stale` says
 * the provider could not be reached and these are the last models it did return — possibly
 * none. A failed refresh never empties a saved selection and never yields a made-up list.
 */
export const providerModelListSchema = z.strictObject({
  providerId: z.uuid(),
  models: z.array(providerModelSchema).max(500),
  fetchedAt: z.iso.datetime(),
  stale: z.boolean(),
  reason: z.string().max(300).optional(),
});

/**
 * Anthropic issues two credentials that are not interchangeable. An API key is sent as one;
 * a subscription token, from `claude setup-token`, is only accepted as a bearer from a caller
 * presenting itself as Claude Code. Sending either as the other answers 401, and the owner is
 * the one who knows which they pasted.
 */
export const providerCredentialSchema = z.enum(['key', 'subscription']);

/** The key travels once, on the way in. `createdAt` is the only thing said about it afterwards. */
export const providerInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(['openai', 'anthropic', 'google', 'openrouter', 'groq', 'openai-compatible']),
  // Required for every vendor; a server the owner runs, such as a local Whisper, may need none.
  secret: secretSchema.optional(),
  credential: providerCredentialSchema.optional(),
  // Only for an OpenAI-compatible server: where its API is, up to and including `/v1`.
  baseURL: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .optional(),
});

/**
 * A credential belongs to the installation, which has one owner: signing in to the same vendor
 * once per agent is work nobody would do twice. Which model an agent uses is still its own.
 */
export const providerRecordSchema = providerInputSchema.omit({ secret: true }).extend({
  apiKeyEnv: z.string().optional(),
  authMode: z.enum(['api', 'codex']).optional(),
  credential: providerCredentialSchema.optional(),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
});

export const codexLoginSchema = z.strictObject({
  status: z.enum(['pending', 'connected', 'failed']),
  verificationUrl: z.url().optional(),
  userCode: z.string().optional(),
  error: z.string().optional(),
});

export const modelSelectionSchema = z.strictObject({
  providerId: z.uuid(),
  modelId: z.string().trim().min(1).max(160),
  reasoningEffort: reasoningEffortSchema.optional(),
});

export const modelRoleSchema = z.enum([
  'conversation',
  'channel',
  'compaction',
  'image',
  'vision',
  'audio',
  'speech',
  'transcription',
  'sticker',
]);

export const executedModelRoles = modelRoleSchema.options;
export const optionalModelRoles: ReadonlySet<ModelRole> = new Set([
  'image',
  'vision',
  'audio',
  'speech',
  'sticker',
]);

// Required agent roles clear to Automatic when omitted. Optional activities default off.
const roleSelection = modelSelectionSchema.nullable().default(null);
// Disabled is distinct from Automatic (null): an old saved null keeps its fallback behavior.
const optionalRoleSelection = z
  .union([modelSelectionSchema, z.literal('disabled')])
  .nullable()
  .default('disabled');

export const modelDefaultsInputSchema = z.strictObject({
  conversation: roleSelection,
  channel: roleSelection,
  compaction: roleSelection,
  image: optionalRoleSelection,
  vision: optionalRoleSelection,
  audio: optionalRoleSelection,
  speech: optionalRoleSelection,
  // Describes and tags the stickers the agent keeps. Unset, it is the image-analysis model.
  sticker: optionalRoleSelection,
  transcription: roleSelection.describe(
    'Deprecated compatibility alias for audio. Incoming audio uses audio when both have a model selected.',
  ),
});

export const modelDefaultsRecordSchema = modelDefaultsInputSchema.extend({
  id: z.uuid(),
  profileId: z.uuid(),
  updatedAt: z.iso.datetime(),
});

export type ProviderCredential = z.infer<typeof providerCredentialSchema>;
export type ProviderRecord = z.infer<typeof providerRecordSchema>;
export type ProviderModel = z.infer<typeof providerModelSchema>;
export type ProviderModelList = z.infer<typeof providerModelListSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type ModelDefaultsRecord = z.infer<typeof modelDefaultsRecordSchema>;
export type ModelRole = z.infer<typeof modelRoleSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Providers must implement the endpoint used by the activity, independent of the model. */
export function supportsProviderRole(
  provider: Pick<ProviderRecord, 'kind' | 'authMode'>,
  role: ModelRole,
): boolean {
  if (['image', 'speech'].includes(role))
    return provider.authMode !== 'codex' && ['openai', 'google'].includes(provider.kind);
  if (['transcription', 'audio'].includes(role))
    return (
      provider.authMode !== 'codex' &&
      ['openai', 'google', 'groq', 'openai-compatible'].includes(provider.kind)
    );
  return true;
}

/** Endpoint compatibility matters as well as input/output modalities. */
export function supportsModelRole(
  provider: Pick<ProviderRecord, 'kind' | 'authMode'>,
  model: Pick<ProviderModel, 'id' | 'inputModalities' | 'outputModalities' | 'known'>,
  role: ModelRole,
): boolean {
  if (!supportsProviderRole(provider, role)) return false;
  const id = model.id.toLowerCase();
  if (role === 'image')
    return (
      provider.authMode !== 'codex' &&
      ((provider.kind === 'openai' && /^(gpt-image|dall-e)/.test(id)) ||
        (provider.kind === 'google' &&
          id.startsWith('gemini-') &&
          (model.outputModalities?.includes('image') || id.includes('-image'))))
    );
  if (role === 'speech')
    return (
      provider.authMode !== 'codex' &&
      ((provider.kind === 'google' && id.includes('tts')) ||
        (provider.kind === 'openai' && /(^tts-|tts)/.test(id)))
    );
  // The OpenAI transcription endpoint, at OpenAI, at Groq, or on a server the owner runs.
  if (
    (role === 'transcription' || role === 'audio') &&
    ['openai', 'groq', 'openai-compatible'].includes(provider.kind)
  )
    return provider.authMode !== 'codex' && /whisper|transcri/.test(id);
  if (role === 'audio' || role === 'transcription')
    return (
      provider.kind === 'google' &&
      !/live|native-audio|tts/.test(id) &&
      (!model.known || model.inputModalities.includes('audio'))
    );
  if (role === 'vision' || role === 'sticker')
    return (
      !/image|tts|live|native-audio/.test(id) &&
      (!model.known || model.inputModalities.includes('image'))
    );
  return (
    !/^(gpt-image|dall-e|tts-|whisper)/.test(id) &&
    !/transcribe|embedding|tts|live|native-audio/.test(id) &&
    (!model.outputModalities?.length || model.outputModalities.includes('text'))
  );
}
