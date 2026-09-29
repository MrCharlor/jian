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
