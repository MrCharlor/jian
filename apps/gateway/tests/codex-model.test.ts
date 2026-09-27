import { generateText, streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCodexModel } from '../src/providers/codex/model.js';

describe('ChatGPT Codex model adapter', () => {
  it('keeps Jian instructions and returns a Responses result', async () => {
    let request: Record<string, unknown> = {};
    let headers = new Headers();
    const fetcher: typeof fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      const item = {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Olá.', annotations: [] }],
      };
      const response = {
        id: 'resp_test',
        object: 'response',
        created_at: 1,
        model: 'gpt-5.6-terra',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      };
      const events = [
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const result = await generateText({
      model: createCodexModel('synthetic-token', 'gpt-5.6-terra', fetcher),
      system: 'You are Jian.',
      prompt: 'Diga olá.',
    });

    expect(result.text).toBe('Olá.');
    expect(request.instructions).toContain('You are Jian.');
    expect(request.stream).toBe(true);
    expect(request.store).toBe(false);
    expect(headers.get('authorization')).toBe('Bearer synthetic-token');
  });

  it('forwards an OpenAI prompt cache key to the Codex endpoint', async () => {
    let request: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_input, init) => {
      request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = {
        id: 'resp_cache',
        object: 'response',
        created_at: 1,
        model: 'gpt-5.6-terra',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      };
      return new Response(
        `data: ${JSON.stringify({ type: 'response.completed', response })}\\n\\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    };

    await generateText({
      model: createCodexModel('synthetic-token', 'gpt-5.6-terra', fetcher),
      prompt: 'Reuse the stable prefix.',
      providerOptions: { openai: { promptCacheKey: 'profile-cache' } },
    });

    expect(request.prompt_cache_key).toBe('profile-cache');
  });

  it('passes tool calls through the same agent interface', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const output =
        bodies.length === 1
          ? [
              {
                type: 'function_call',
                id: 'fc_1',
                call_id: 'call_1',
                name: 'lookup',
                arguments: '{"query":"x"}',
                status: 'completed',
              },
            ]
          : [
              {
                id: 'msg_2',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Found x.', annotations: [] }],
              },
            ];
      const response = {
        id: `resp_${bodies.length}`,
        object: 'response',
        created_at: 1,
        model: 'gpt-5.6-terra',
        status: 'completed',
        output,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      };
      return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const result = await generateText({
      model: createCodexModel('synthetic-token', 'gpt-5.6-terra', fetcher),
      prompt: 'Look up x.',
      tools: {
        lookup: {
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => query,
        },
      },
      stopWhen: ({ steps }) => steps.length >= 2,
    });

    expect(result.text).toBe('Found x.');
    expect(bodies[0]?.tools).toBeDefined();
    expect(bodies[1]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
      ]),
    );
  });

  // The runtime streams, so the run can speak while it works. Codex already answers with
  // events; turning them into one JSON body is what made every tool call vanish.
  it('streams a tool call and the answer that follows it', async () => {
    let calls = 0;
    const response = (id: string) => ({
      id,
      object: 'response',
      created_at: 1,
      model: 'gpt-5.6-sol',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"x"}',
      status: 'completed',
    };
    const message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Found x.', annotations: [] }],
    };
    const fetcher: typeof fetch = async () => {
      calls += 1;
      const events =
        calls === 1
          ? [
              {
                type: 'response.created',
                response: { ...response('resp_1'), status: 'in_progress' },
              },
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...call, arguments: '', status: 'in_progress' },
              },
              {
                type: 'response.function_call_arguments.delta',
                item_id: 'fc_1',
                output_index: 0,
                delta: '{"query":"x"}',
              },
              { type: 'response.output_item.done', output_index: 0, item: call },
              { type: 'response.completed', response: response('resp_1') },
            ]
          : [
              {
                type: 'response.created',
                response: { ...response('resp_2'), status: 'in_progress' },
              },
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...message, content: [], status: 'in_progress' },
              },
              {
                type: 'response.output_text.delta',
                item_id: 'msg_2',
                output_index: 0,
                content_index: 0,
                delta: 'Found x.',
              },
              { type: 'response.output_item.done', output_index: 0, item: message },
              { type: 'response.completed', response: response('resp_2') },
            ];

      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const looked: string[] = [];
    const result = streamText({
      model: createCodexModel('synthetic-token', 'gpt-5.6-sol', fetcher),
      prompt: 'Look up x.',
      tools: {
        lookup: {
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => {
            looked.push(query);

            return query;
          },
        },
      },
      stopWhen: ({ steps }) => steps.length >= 2,
    });

    expect(await result.text).toBe('Found x.');
    expect(looked).toEqual(['x']);
    expect((await result.steps)[0]?.finishReason).toBe('tool-calls');
  });

  // Codex keeps nothing between requests. Reasoning from one step has to travel whole into the
  // next — encrypted — because a reference to it points at an item that was never stored.
  it('carries reasoning into the next step instead of referring to it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const response = (id: string) => ({
      id,
      object: 'response',
      created_at: 1,
      model: 'gpt-5.6-sol',
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const reasoning = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'sealed-thoughts',
      summary: [{ type: 'summary_text', text: 'Look it up.' }],
    };
    const call = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'lookup',
      arguments: '{"query":"x"}',
      status: 'completed',
    };
    const message = {
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Found x.', annotations: [] }],
    };
    const fetcher: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const first = bodies.length === 1;
      const events = [
        { type: 'response.created', response: { ...response('r'), status: 'in_progress' } },
        ...(first
          ? [
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...reasoning, summary: [] },
              },
              { type: 'response.output_item.done', output_index: 0, item: reasoning },
              {
                type: 'response.output_item.added',
                output_index: 1,
                item: { ...call, arguments: '', status: 'in_progress' },
              },
              { type: 'response.output_item.done', output_index: 1, item: call },
            ]
          : [
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...message, content: [], status: 'in_progress' },
              },
              {
                type: 'response.output_text.delta',
                item_id: 'msg_2',
                output_index: 0,
                content_index: 0,
                delta: 'Found x.',
              },
              { type: 'response.output_item.done', output_index: 0, item: message },
            ]),
        { type: 'response.completed', response: response('r') },
      ];

      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const result = streamText({
      model: createCodexModel('synthetic-token', 'gpt-5.6-sol', fetcher),
      prompt: 'Look up x.',
      providerOptions: { openai: { reasoningEffort: 'high' } },
      tools: {
        lookup: {
          inputSchema: z.object({ query: z.string() }),
          execute: async ({ query }) => query,
        },
      },
      stopWhen: ({ steps }) => steps.length >= 2,
    });

    expect(await result.text).toBe('Found x.');

    const second = JSON.stringify(bodies[1]?.input);

    expect(second).not.toContain('item_reference');
    expect(second).toContain('sealed-thoughts');
    expect(bodies[0]?.include).toContain('reasoning.encrypted_content');
    expect(bodies[0]?.reasoning).toMatchObject({ effort: 'high' });
  });
});
