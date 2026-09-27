import { createHash } from 'node:crypto';
import type { JSONValue, ModelMessage, SystemModelMessage } from 'ai';
import { CLAUDE_CODE_IDENTITY } from '../providers/claude-subscription.js';

/** OpenAI uses this key to keep unrelated profiles from sharing a prompt-cache partition. */
export function openAiPromptCacheOptions(
  profileId: string,
  provider: string,
  modelId: string,
): { openai: { promptCacheKey: string } } | undefined {
  if (provider !== 'openai' && provider !== 'openai-codex') return undefined;

  const promptCacheKey = createHash('sha256')
    .update(`jian:${profileId}:${provider}:${modelId}`)
    .digest('hex')
    .slice(0, 48);

  return { openai: { promptCacheKey } };
}

/** Merge provider options without replacing reasoning settings already selected for the turn. */
export function withOpenAiPromptCache(
  options: Record<string, Record<string, JSONValue>> | undefined,
  profileId: string,
  provider: string,
  modelId: string,
): Record<string, Record<string, JSONValue>> | undefined {
  const cache = openAiPromptCacheOptions(profileId, provider, modelId);
  if (!cache) return options;

  return { ...options, openai: { ...options?.openai, ...cache.openai } };
}

/** What Anthropic accepts per request. Anything past it is refused and silently not cached. */
const BREAKPOINTS = 4;

/**
 * How long a cached prefix is kept. A conversation a person types into pauses for minutes
 * between turns, so the five-minute tier has usually expired by the time they answer and every
 * turn pays for the whole prompt again; the hour tier costs more to write once and is read
 * back for the rest of the conversation. Agents answer each other in seconds and never collect
 * that retention, so they stay on the cheaper write.
 */
export type CacheTtl = '5m' | '1h';

/** Keep the reusable instructions cached when retrieved memories or the session summary change. */
export function cacheableInstructions(system: string, ttl: CacheTtl): SystemModelMessage[] {
  const messages: SystemModelMessage[] = [];
  if (system.startsWith(CLAUDE_CODE_IDENTITY)) {
    messages.push({ role: 'system', content: CLAUDE_CODE_IDENTITY });
    system = system.slice(CLAUDE_CODE_IDENTITY.length).trim();
  }
  const boundary = system.indexOf('Relevant shared memories:');
  const stable = boundary < 0 ? system : system.slice(0, boundary).trimEnd();
  messages.push({
    role: 'system',
    content: stable,
    providerOptions: {
      anthropic: {
        cacheControl: ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' },
      },
    },
  });
  if (boundary >= 0) messages.push({ role: 'system', content: system.slice(boundary) });
  return messages;
}

/** A message can carry a mark only if it has content for the mark to sit on. */
function markable(message: ModelMessage): boolean {
  const content = message.content;

  return Array.isArray(content)
    ? content.length > 0
    : typeof content === 'string' && content !== '';
}

/**
 * Anthropic reuses a prompt only up to a point the request marks, and re-reading that prefix
 * costs a tenth of sending it. The marks go where the prompt stops changing:
 *
 * - on the first message, which puts the tool definitions and the instructions behind it —
 *   the largest stable block of every request, and identical across a whole conversation;
 * - on the last two messages, so the turns and tool results already accumulated are read back
 *   instead of re-sent. A mark at the head alone would cache the head and nothing else, since
 *   what is reused is the prefix that ends at a mark.
 *
 * Marks are stripped before being placed: the loop hands its own messages back on every step,
 * and leaving the old ones would add a breakpoint per step until Anthropic refused them. A
 * prefix below the model's minimum is simply not cached, so marking a short prompt costs
 * nothing.
 */
export function cacheable(
  messages: ModelMessage[],
  ttl: CacheTtl = '5m',
  breakpoints = BREAKPOINTS,
): ModelMessage[] {
  const eligible = messages.flatMap((message, index) => (markable(message) ? [index] : []));

  if (eligible.length === 0) {
    return messages;
  }

  const head = eligible[0] as number;
  const marks = new Set([head, ...eligible.slice(-(breakpoints - 1))]);

  return messages.map((message, index) => {
    const anthropic = { ...message.providerOptions?.anthropic } as Record<string, JSONValue>;

    delete anthropic.cacheControl;

    if (marks.has(index)) {
      anthropic.cacheControl = ttl === '1h' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
    }

    if (!message.providerOptions && !marks.has(index)) {
      return message;
    }

    return {
      ...message,
      providerOptions: { ...message.providerOptions, anthropic },
    } as ModelMessage;
  });
}
