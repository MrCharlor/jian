import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { createSafeFetch } from '../src/security/outbound.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

it.each([false, true])(
  'sends a server tool to the model only after the agent loads it (large catalog: %s)',
  async (largeCatalog) => {
    const called: string[] = [];

    const extraTools = largeCatalog
      ? Array.from({ length: 20 }, (_, index) => ({
          name: `archive_${index}`,
          description: `Archived documents ${index}`,
          inputSchema: { type: 'object', properties: {} },
        }))
      : [];

    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();

        return;
      }

      let body = '';

      for await (const chunk of req) {
        body += chunk;
      }

      const message = JSON.parse(body);

      if (message.id === undefined) {
        res.writeHead(202).end();

        return;
      }

      let result: unknown;

      if (message.method === 'initialize') {
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'test', version: '1' },
        };
      } else if (message.method === 'tools/list') {
        result = {
          tools: [
            ...extraTools,
            {
              name: 'search',
              description: 'Search docs',
              inputSchema: { type: 'object', properties: {} },
            },
            {
              name: 'delete_everything',
              description: 'Offered by the server, and never sent to the model unloaded',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        };
      } else if (message.method === 'tools/call') {
        called.push(message.params.name);
        result = { content: [{ type: 'text', text: 'Documentation found' }] };
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );

        return;
      }

      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });
    const services = await testServices();

    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };

    let calls = 0;

    const model = mockModel({
      doGenerate: async (options) => {
        calls++;

        if (largeCatalog && calls === 1) {
          const exposed = options.tools?.filter((tool) => tool.type === 'function') ?? [];

          expect(exposed.find((tool) => tool.name === 'load_mcp_tools')?.description).not.toContain(
            'archive_19',
          );

          expect(exposed.some((tool) => tool.name === 'search_mcp_tools')).toBe(true);

          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'discover',
                toolName: 'search_mcp_tools',
                input: JSON.stringify({ query: 'archive_19' }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        const phase = calls - (largeCatalog ? 1 : 0);

        if (phase === 1) {
          const tools = options.tools?.filter((t) => t.type === 'function') ?? [];

          if (tools.some((t) => t.name.includes('delete_everything'))) {
            throw new Error('Forbidden tool exposed');
          }

          expect(tools.some((t) => t.name.startsWith('mcp__docs_search_'))).toBe(false);

          const selector = tools.find((t) => t.name === 'load_mcp_tools');

          assert.ok(selector, 'The selector must be available before MCP schemas');

          const searchName = largeCatalog
            ? JSON.stringify(options.prompt).match(/mcp__docs_archive_19_[a-f0-9]{8}/)?.[0]
            : selector.description?.match(/mcp__docs_search_[a-f0-9]{8}/)?.[0];

          assert.ok(searchName, 'The allowlisted tool must be in the catalog');

          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'select',
                toolName: selector.name,
                input: JSON.stringify({ names: [searchName] }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        if (phase === 2) {
          const tools = options.tools?.filter((t) => t.type === 'function') ?? [];

          if (tools.some((t) => t.name.includes('delete_everything'))) {
            throw new Error('Forbidden tool exposed');
          }

          const search = tools.find((t) =>
            t.name.startsWith(largeCatalog ? 'mcp__docs_archive_19_' : 'mcp__docs_search_'),
          );

          assert.ok(search, 'The selected search tool must now be available');

          return {
            content: [{ type: 'tool-call', toolCallId: 'one', toolName: search.name, input: '{}' }],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        if (largeCatalog && phase === 3) {
          // A search ranks by shared words: the other archives come after the exact one.
          const name = JSON.stringify(options.prompt).match(/mcp__docs_archive_0_[a-f0-9]{8}/)?.[0];
          assert.ok(name);
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'add-another',
                toolName: 'load_mcp_tools',
                input: JSON.stringify({ names: [name] }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }
        if (largeCatalog && phase === 4) {
          const names =
            options.tools?.filter((t) => t.type === 'function').map((t) => t.name) ?? [];
          expect(names.some((name) => name.includes('archive_19_'))).toBe(true);
          expect(names.some((name) => name.includes('archive_0_'))).toBe(true);
        }

        return {
          content: [{ type: 'text', text: 'Found the documentation.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      },
    });

    try {
      const profile = await services.profiles.createProfile({
        name: 'MCP test',
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
        mcpServers: [
          {
            name: 'docs',
            url: `${origin}/mcp`,
          },
        ],
      });

      const session = await services.sessions.createSession(profile.id, { title: 'MCP' });

      const run = await services.runs.submit(profile.id, session.id, {
        text: 'Find docs',
        requestKey: 'mcp',
      });

      await new AgentRuntime(services, () => model, { outbound }).execute(profile.id, run.id);
      expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
      expect(called).toEqual([largeCatalog ? 'archive_19' : 'search']);
    } finally {
      await outbound.close();
      server.closeAllConnections();

      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  },
);

it.each(['disconnect', 'isError', 'readOnlyError'])(
  'stops on an unknowable remote outcome and carries on from a refused one (%s)',
  async (failure) => {
    let effects = 0;

    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();

        return;
      }

      let body = '';

      for await (const chunk of req) {
        body += chunk;
      }

      const message = JSON.parse(body);

      if (message.id === undefined) {
        res.writeHead(202).end();

        return;
      }

      if (message.method === 'tools/call') {
        effects++;

        if (failure === 'disconnect') {
          req.socket.destroy();
        } else if (failure === 'readOnlyError') {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32602,
                message: 'header mismatch: missing Mcp-Param-owner header for parameter "owner"',
              },
            }),
          );
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                isError: true,
                content: [{ type: 'text', text: 'Effect applied; verification failed.' }],
              },
            }),
          );
        }

        return;
      }

      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'effect', version: '1' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: failure === 'readOnlyError' ? 'search' : 'mutate',
                    description:
                      failure === 'readOnlyError' ? 'Search pull requests' : 'External mutation',
                    ...(failure === 'readOnlyError' ? { annotations: { readOnlyHint: true } } : {}),
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : undefined;

      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const outbound = createSafeFetch({ allowPrivateOrigins: [origin] });

    try {
      const services = await testServices();

      const profile = await services.profiles.createProfile({
        name: 'Effect test',
        instructions: 'Help.',
        model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
        mcpServers: [{ name: 'effects', url: `${origin}/mcp` }],
      });

      const session = await services.sessions.createSession(profile.id, { title: 'Effects' });

      const run = await services.runs.submit(profile.id, session.id, {
        text: 'Do it',
        requestKey: 'effect',
      });

      const usage = {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      };

      let calls = 0;
      let remoteName = '';

      const model = mockModel({
        doGenerate: async (options) => {
          calls++;

          if (calls === 1) {
            const selector = options.tools
              ?.filter((item) => item.type === 'function')
              .find((item) => item.name === 'load_mcp_tools');

            assert.ok(selector);
            remoteName =
              selector.description?.match(/mcp__effects_(?:mutate|search)_[a-f0-9]{8}/)?.[0] ?? '';
            assert.ok(remoteName);

            return {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'select',
                  toolName: 'load_mcp_tools',
                  input: JSON.stringify({ names: [remoteName] }),
                },
              ],
              finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
              usage,
              warnings: [],
            };
          }

          // Told the server refused, the agent stops asking and says so, which is what a
          // reported failure is for.
          if (calls > 2) {
            return {
              content: [{ type: 'text', text: 'The server refused the change.' }],
              finishReason: { unified: 'stop', raw: 'stop' },
              usage,
              warnings: [],
            };
          }

          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: `effect-${calls}-a`,
                toolName: remoteName,
                input: '{}',
              },
              {
                type: 'tool-call',
                toolCallId: `effect-${calls}-b`,
                toolName: remoteName,
                input: '{}',
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        },
      });

      await new AgentRuntime(services, () => model, { outbound }).execute(profile.id, run.id);

      const finished = await services.runs.run(profile.id, run.id);

      if (failure === 'disconnect') {
        // The call never came back, so whether the server acted is unknowable: the second call
        // of the same step never starts and everything stops until the owner has looked.
        expect(effects).toBe(1);
        expect(finished.status).toBe('interrupted');
        expect(calls).toBe(2);
        expect(finished.error).toContain('reconcil');
        expect(finished.error).toContain(remoteName);
      } else {
        // A refusal stops nothing: the other call of the step still runs.
        expect(effects).toBe(2);
        // The server answered and said no. That is a fact the agent can act on, so the turn
        // carries on with it rather than being abandoned.
        expect(finished.status).toBe('completed');
        expect(calls).toBeGreaterThan(2);
        if (failure === 'readOnlyError') {
          expect(
            (await services.lifecycle.checkpoints(profile.id, run.id)).some((checkpoint) => {
              const data = checkpoint.data as { phase?: string; reason?: string };

              return (
                data.phase === 'tool-failed' &&
                data.reason?.includes('missing Mcp-Param-owner header')
              );
            }),
          ).toBe(true);
        }
      }

      // One record per call actually started: a call that never started leaves none.
      expect(
        (await services.lifecycle.checkpoints(profile.id, run.id)).filter((checkpoint) => {
          const data = checkpoint.data as { phase?: string; toolName?: string };

          return data.phase === 'tool-started' && data.toolName === remoteName;
        }),
      ).toHaveLength(failure === 'disconnect' ? 1 : 2);
    } finally {
      await outbound.close();
      server.closeAllConnections();

      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
