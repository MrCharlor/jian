import { createOpenAI } from '@ai-sdk/openai';
import { defaultSettingsMiddleware, wrapLanguageModel } from 'ai';

const endpoint = 'https://chatgpt.com/backend-api/codex';

export function accountHeaders(token: string) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      'https://api.openai.com/auth'?: {
        chatgpt_account_id?: string;
        chatgpt_data_residency?: string;
        chatgpt_compute_residency?: string;
      };
    };
    const account = payload['https://api.openai.com/auth'];
    const residency = account?.chatgpt_data_residency ?? account?.chatgpt_compute_residency;
    return {
      ...(account?.chatgpt_account_id ? { 'ChatGPT-Account-ID': account.chatgpt_account_id } : {}),
      ...(residency ? { 'x-openai-internal-codex-residency': residency } : {}),
    };
  } catch {
    return {};
  }
}

async function completedResponse(response: Response) {
  if (!response.ok) return response;
  if (!response.body) throw new Error('Codex returned no response');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed: unknown;
  let failure: string | undefined;
  const output = new Map<number, unknown>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');
        if (!data || data === '[DONE]') continue;
        const payload = JSON.parse(data) as {
          type?: string;
          response?: unknown;
          error?: { message?: string };
        };
        if (
          payload.type === 'response.output_item.done' &&
          typeof (payload as { output_index?: unknown }).output_index === 'number'
        ) {
          const item = (payload as { item?: unknown }).item;
          if (item) output.set((payload as { output_index: number }).output_index, item);
        }
        if (payload.type === 'response.completed') completed = payload.response;
        if (payload.type === 'response.failed' || payload.type === 'response.incomplete') {
          failure = payload.error?.message ?? 'Codex did not complete';
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!completed) throw new Error(failure ?? 'Codex did not complete');
  if (output.size && completed && typeof completed === 'object') {
    completed = {
      ...completed,
      output: [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
    };
  }
  return new Response(JSON.stringify(completed), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function createCodexModel(token: string, modelId: string, fetcher: typeof fetch = fetch) {
  const codexFetch: typeof fetch = async (input, init) => {
    const original = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const inputItems = Array.isArray(original.input) ? [...original.input] : [];
    const instructions = inputItems
      .filter(
        (item) =>
          item &&
          typeof item === 'object' &&
          'role' in item &&
          (item.role === 'system' || item.role === 'developer'),
      )
      .flatMap((item) => {
        if (!('content' in item)) return [];
        if (typeof item.content === 'string') return [item.content];
        return Array.isArray(item.content)
          ? item.content
              .filter((part: { type?: string }) => part.type === 'input_text')
              .map((part: { text: string }) => part.text)
          : [];
      })
      .join('\n\n');
    const body = {
      model: original.model,
      instructions: instructions || original.instructions || 'You are a helpful assistant.',
      input: inputItems.filter(
        (item) =>
          !(
            item &&
            typeof item === 'object' &&
            'role' in item &&
            (item.role === 'system' || item.role === 'developer')
          ),
      ),
      store: false,
      stream: true,
      ...(original.tools ? { tools: original.tools } : {}),
      ...(original.tool_choice ? { tool_choice: original.tool_choice } : {}),
      ...(original.parallel_tool_calls
        ? { parallel_tool_calls: original.parallel_tool_calls }
        : {}),
      ...(original.reasoning ? { reasoning: original.reasoning } : {}),
      ...(original.include ? { include: original.include } : {}),
      ...(original.prompt_cache_key ? { prompt_cache_key: original.prompt_cache_key } : {}),
      ...(original.prompt_cache_retention
        ? { prompt_cache_retention: original.prompt_cache_retention }
        : {}),
    };
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    headers.set('content-type', 'application/json');
    headers.set('accept', 'text/event-stream');
    headers.set('originator', 'jian');
    headers.set('user-agent', 'Jian/0.1.0');
    for (const [name, value] of Object.entries(accountHeaders(token))) headers.set(name, value);

    const response = await fetcher(String(input), {
      ...init,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Codex only answers with events. A streaming caller reads them as they are; folding them
    // into one body is only for a caller that asked for one, and a streaming parser that gets
    // that body finds no events at all — no text, and no tool call.
    return original.stream === true ? response : completedResponse(response);
  };

  // Codex stores nothing, so the SDK must not either: told otherwise, it replaces the previous
  // step's reasoning with a reference to it, and Codex answers 404 for an item it never kept.
  // Stored off, the reasoning travels whole, encrypted, as Codex's own CLI sends it.
  return wrapLanguageModel({
    model: createOpenAI({ apiKey: token, baseURL: endpoint, fetch: codexFetch }).responses(modelId),
    middleware: defaultSettingsMiddleware({
      settings: { providerOptions: { openai: { store: false } } },
    }),
  });
}
