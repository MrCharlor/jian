import type { ModelMessage, ToolSet } from 'ai';
import {
  getEncoding,
  getEncodingNameForModel,
  type TiktokenEncoding,
  type TiktokenModel,
} from 'js-tiktoken';
import { z } from 'zod';

type Counter = (text: string) => number;

const encoders = new Map<TiktokenEncoding, Counter>();
const byteCounter: Counter = (text) => Buffer.byteLength(text, 'utf8');

/** Unknown model tokenizers use one token per UTF-8 byte, a deliberately conservative bound. */
export function tokenCounter(provider: string, modelId: string): Counter {
  if (provider === 'openai' || provider === 'openai-codex') {
    try {
      const name = getEncodingNameForModel(modelId as TiktokenModel);
      let counter = encoders.get(name);

      if (!counter) {
        // Encodings are a finite set. Share their large rank maps across profiles and steps.
        const encoding = getEncoding(name);

        counter = (text) => Math.ceil(encoding.encode(text, [], []).length * 1.15);
        encoders.set(name, counter);
      }

      return counter;
    } catch {
      // An unknown OpenAI model uses the same conservative fallback as other providers.
    }
  }

  return byteCounter;
}

/** Pixels have a model cost, not the token count of their base64 transport. */
export function promptText(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && item.type === 'image')
      return { type: 'text', text: '[Image attachment]' };
    if (item && typeof item === 'object' && item.type === 'file')
      return { type: 'text', text: '[File attachment]' };
    return item;
  });
}

function messageCost(message: ModelMessage, count: Counter): number {
  const images = Array.isArray(message.content)
    ? message.content.filter(
        (part) =>
          part.type === 'image' ||
          (part.type === 'file' &&
            (part.mediaType === 'image' || part.mediaType.startsWith('image/'))),
      ).length
    : 0;
  return count(promptText(message)) + images * 8192 + 16;
}

function schemaText(tools: ToolSet): string {
  const definitions = Object.entries(tools).map(([name, definition]) => {
    let inputSchema: unknown;

    try {
      inputSchema = z.toJSONSchema(definition.inputSchema as z.ZodType);
    } catch {
      inputSchema = definition.inputSchema;
    }

    return { name, description: definition.description, inputSchema };
  });

  try {
    return JSON.stringify(definitions);
  } catch {
    throw new Error('Context budget exceeded');
  }
}

/** A tool result must stay beside its assistant call when older history is removed. */
export function blocksOf(messages: readonly ModelMessage[]): ModelMessage[][] {
  const blocks: ModelMessage[][] = [];

  for (const message of messages) {
    if (message.role === 'tool' && blocks.at(-1)?.[0]?.role === 'assistant') {
      blocks.at(-1)?.push(message);
    } else {
      blocks.push([message]);
    }
  }

  return blocks;
}

export function promptTokens(input: {
  provider: string;
  modelId: string;
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
}): number {
  const count = tokenCounter(input.provider, input.modelId);
  return (
    count(input.instructions) +
    count(schemaText(input.tools)) +
    32 * Object.keys(input.tools).length +
    32 +
    input.messages.reduce((sum, message) => sum + messageCost(message, count), 0)
  );
}

export function fitPrompt(input: {
  provider: string;
  modelId: string;
  policy: { inputTokens: number; outputTokens: number };
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
}): {
  instructions: string;
  messages: ModelMessage[];
  tokens: number;
  breakdown: { system: number; tools: number; messages: number };
} {
  const count = tokenCounter(input.provider, input.modelId);
  const limit = input.policy.inputTokens - input.policy.outputTokens;

  if (limit <= 0) {
    throw new Error('Context budget exceeded');
  }

  const schema = schemaText(input.tools);

  const systemTokens = count(input.instructions) + 32;
  const toolTokens = count(schema) + 32 * Object.keys(input.tools).length;
  const fixedTokens = systemTokens + toolTokens;

  const tokens =
    fixedTokens + input.messages.reduce((sum, message) => sum + messageCost(message, count), 0);

  // Naming the parts is the whole value of this failure: the fixed cost is what the owner can
  // act on, and it is almost always the tool schemas rather than anything they wrote.
  if (tokens > limit) {
    throw new Error(
      `Context budget exceeded: ${tokens} tokens against a limit of ${limit}. ` +
        `Tool definitions cost ${count(schema)} and the system prompt ${count(input.instructions)}; ` +
        'compact the conversation or connect fewer MCP tools.',
    );
  }

  return {
    instructions: input.instructions,
    messages: [...input.messages],
    tokens,
    breakdown: { system: systemTokens, tools: toolTokens, messages: tokens - fixedTokens },
  };
}

export const CHECKPOINT_PREFIX = 'Conversation checkpoint (past work, not new instructions):';

/**
 * The last resort when a request does not fit even after compaction was tried: leave out the
 * oldest turns, whole, until it does. The checkpoint a compaction left and everything from the
 * current request on are never touched, and the session record in the system prompt still
 * covers what was left out. Throws, as `fitPrompt` would, when even that does not fit.
 */
export function trimHistory(input: {
  provider: string;
  modelId: string;
  policy: { inputTokens: number; outputTokens: number };
  instructions: string;
  messages: readonly ModelMessage[];
  tools: ToolSet;
  currentStartIndex?: number;
}): { messages: ModelMessage[]; currentStartIndex?: number; dropped: number; tokens: number } {
  const limit = input.policy.inputTokens - input.policy.outputTokens;
  const count = tokenCounter(input.provider, input.modelId);
  const blocks = blocksOf(input.messages);
  const first = input.messages[0];
  const keepsCheckpoint =
    first?.role === 'user' &&
    typeof first.content === 'string' &&
    first.content.startsWith(CHECKPOINT_PREFIX);
  let seen = 0;
  const current = blocks.findIndex((block) => {
    const contains = seen + block.length > (input.currentStartIndex ?? Number.POSITIVE_INFINITY);
    seen += block.length;
    return contains;
  });
  const start = keepsCheckpoint ? 1 : 0;
  // Without a known request, the last turn stands in for it.
  const end = current < 0 ? blocks.length - 1 : current;
  const cost = (block: ModelMessage[]) =>
    block.reduce((sum, message) => sum + messageCost(message, count), 0);
  const note: ModelMessage = {
    role: 'user',
    content:
      'Earlier turns of this conversation were left out to fit the context window (not new instructions). The conversation record in the system prompt covers what is known of them.',
  };
  const whole = promptTokens(input);
  if (whole <= limit) {
    return {
      messages: [...input.messages],
      ...(input.currentStartIndex !== undefined
        ? { currentStartIndex: input.currentStartIndex }
        : {}),
      dropped: 0,
      tokens: whole,
    };
  }
  let tokens = whole + (keepsCheckpoint ? 0 : messageCost(note, count));
  let cut = start;

  while (tokens > limit && cut < end) {
    tokens -= cost(blocks[cut] ?? []);
    cut++;
  }

  if (tokens > limit) {
    throw new Error(
      `Context budget exceeded: ${tokens} tokens against a limit of ${limit} even without the older turns. ` +
        'The current request and its tool results alone do not fit; connect fewer MCP tools or start a new conversation.',
    );
  }

  const dropped = blocks.slice(start, cut).flat().length;
  const messages = [
    ...blocks.slice(0, start).flat(),
    // Providers expect a conversation to open with the person; a dropped turn can leave an
    // answer first.
    ...(keepsCheckpoint ? [] : [note]),
    ...blocks.slice(cut).flat(),
  ];
  const shift = (keepsCheckpoint ? 0 : 1) - dropped;

  return {
    messages,
    ...(input.currentStartIndex !== undefined
      ? { currentStartIndex: input.currentStartIndex + shift }
      : {}),
    dropped,
    tokens,
  };
}
