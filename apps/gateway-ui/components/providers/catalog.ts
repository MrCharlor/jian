import { optionalModelRoles } from '@jian/contracts';
import type { ProfileData, ProviderModel, ReasoningEffort } from '../../lib/api';

/** The vendors the panel offers, each with what it is and the host variable it falls back to. */
export const providers = [
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    description: 'One account, many models.',
    symbol: '⇄',
    variables: 'OPENROUTER_API_KEY',
  },
  {
    kind: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models for your agents.',
    symbol: 'A',
    variables: 'ANTHROPIC_API_KEY or ANTHROPIC_API_TOKEN',
  },
  {
    kind: 'google',
    name: 'Gemini',
    description: "Google's Gemini models.",
    symbol: '✦',
    variables: 'GEMINI_API_TOKEN',
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    description: 'The OpenAI API, or your ChatGPT account.',
    symbol: '◎',
    variables: 'OPENAI_API_KEY',
  },
  {
    kind: 'groq',
    name: 'Groq',
    description: 'Fast Whisper transcription for incoming audio, with a free tier.',
    symbol: 'G',
    variables: 'GROQ_API_KEY',
  },
  {
    kind: 'openai-compatible',
    name: 'OpenAI-compatible server',
    description: 'A server you run that speaks the OpenAI API, such as a local Whisper.',
    symbol: '⌘',
    variables: '',
  },
] as const;

/**
 * Anthropic issues two credentials and they are not interchangeable, so the owner says which
 * one they pasted rather than the gateway guessing and answering 401 on every run.
 */
export const anthropicCredentials = [
  { value: 'key', label: 'API key', detail: 'Starts with sk-ant-api. Billed per token.' },
  {
    value: 'subscription',
    label: 'Subscription token',
    detail: 'From claude setup-token. Uses your Claude plan.',
  },
] as const;

/**
 * Each activity selects a model independently; empty selections use the stated fallback.
 * `tools` marks the activities that run the model as an agent, where its context window and
 * reasoning levels set the limits; generating images or speech and transcribing audio use
 * neither, so what is not catalogued about their models does not matter.
 */
export const roles = [
  {
    key: 'conversation',
    label: 'Conversations & channels',
    hint: 'Used by chats, the API, WhatsApp, Telegram and webhooks unless a chat selects its own model.',
    runtime: true,
    tools: true,
  },
  {
    key: 'channel',
    label: 'Channels',
    hint: 'WhatsApp, Telegram and webhooks. Unset, it follows the conversation default.',
    runtime: true,
    tools: true,
  },
  {
    key: 'compaction',
    label: 'Context compaction',
    hint: 'Summarises older context automatically or when the agent requests it. Unset, it uses the conversation model.',
    runtime: true,
    tools: true,
  },
  {
    key: 'image',
    label: 'Image generation',
    hint: 'Generates images with an OpenAI API key or Gemini. Unset, it uses Gemini when configured.',
    runtime: true,
    tools: false,
  },
  {
    key: 'vision',
    label: 'Image analysis',
    hint: 'When selected, analyzes incoming images. Otherwise the conversation model sees them directly when supported; Gemini is the fallback.',
    runtime: true,
    tools: true,
  },
  {
    key: 'sticker',
    label: 'Sticker analysis',
    hint: 'Describes and tags the stickers the agent keeps, once each. Unset, it uses the image analysis model.',
    runtime: true,
    tools: false,
  },
  {
    key: 'audio',
    label: 'Incoming audio',
    hint: 'Voice notes and audio files share this model. Gemini also describes relevant sounds; Whisper, from OpenAI, Groq or your own server, transcribes the speech. Unset, it uses Gemini.',
    runtime: true,
    tools: false,
  },
  {
    key: 'speech',
    label: 'Text to speech',
    hint: 'Generates voice replies with OpenAI or Gemini. Unset, it uses Gemini with the Kore voice.',
    runtime: true,
    tools: false,
  },
] as const;

export type Role = (typeof roles)[number]['key'];
export const optionalRoles = optionalModelRoles;

export const efforts: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'No reasoning' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** A live provider carries its own key: revoking it takes the key with it. */
export const usableProviders = (data: ProfileData) =>
  data.providers.filter((provider) => !provider.revokedAt);

export const modelLabel = (model: ProviderModel, catalogued = true) =>
  `${model.displayName ?? model.id}${model.known || !catalogued ? '' : ' · capabilities unknown'}`;
