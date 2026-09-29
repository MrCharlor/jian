import { randomUUID } from 'node:crypto';
import type { Message } from '@jian/contracts';
import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { fitPrompt, promptTokens, tokenCounter } from '../src/context/budget.js';
import { buildContext } from '../src/context/build.js';
import { compactPrompt, needsCompaction } from '../src/context/compaction.js';
import { toolHistoryByRun } from '../src/context/tool-history.js';
import { insertMessage } from '../src/sessions/repository.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

async function fixture() {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help the owner.',
    identity: {
      role: 'Researcher',
      tone: 'Concise',
      goals: ['Find deployment facts'],
      boundaries: ['No external writes'],
    },
    model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    skills: [
      { name: 'lookup', description: 'Search the catalog', instructions: 'Private skill body' },
    ],
  });

  const session = await services.sessions.createSession(profile.id, { title: 'Test' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'When was the deployment?',
    requestKey: 'one',
  });

  return { services, profile, session, run };
}

describe('context', () => {
  it('replays tool inputs and results from the previous run without executing them', async () => {
    const { services, profile, session, run: first } = await fixture();
    const owner = randomUUID();
    expect(await services.lifecycle.claim(first.id, profile.id, owner)).not.toBeNull();
    await services.lifecycle.checkpoint(profile.id, first.id, owner, {
      phase: 'tool-started',
      toolName: 'lookup',
      toolCallId: 'call-1',
      input: { query: 'invoice-47' },
    });
    await services.lifecycle.checkpoint(profile.id, first.id, owner, {
      phase: 'step-completed',
      tools: [
        {
          toolName: 'lookup',
          toolCallId: 'call-1',
          result: { invoice: 'invoice-47', status: 'paid' },
        },
      ],
    });
    await services.lifecycle.finish(
      profile.id,
      first.id,
      owner,
      'completed',
      'The invoice was paid.',
    );
    const second = await services.runs.submit(profile.id, session.id, {
      text: 'What was the invoice number?',
      requestKey: 'two',
    });
    const context = await services.contexts.context(second);
    const evidence = context.messages.find((message) =>
      message.content.includes('Recorded tool activity'),
    );
    expect(evidence?.content).toContain('invoice-47');
    expect(evidence?.content).toContain('"status":"paid"');
    expect(context.messages.at(-1)?.content).toBe('What was the invoice number?');

    const priorAnswer = (await services.sessions.messages(profile.id, session.id)).find(
      (message) => message.runId === first.id && message.role === 'assistant',
    );
    expect(priorAnswer).toBeDefined();
    if (!priorAnswer) throw new Error('Previous answer missing');
    await services.sessions.summarize(
      profile.id,
      session.id,
      'The invoice lookup returned invoice-47, paid.',
      priorAnswer.createdAt,
      priorAnswer.id,
    );
    const compacted = await services.contexts.context(second);
    expect(compacted.system).toContain('invoice-47, paid');
    expect(
      compacted.messages.some((message) => message.content.includes('Recorded tool activity')),
    ).toBe(false);
  });

  it('uses the saved summary instead of replaying tool results it already covers', () => {
    const runId = '11111111-1111-4111-8111-111111111111';
    const rows = [
      {
        runId,
        createdAt: new Date('2026-09-29T10:00:00Z'),
        data: {
          phase: 'tool-started',
          toolName: 'search',
          toolCallId: 'old',
          input: { query: 'old' },
        },
      },
      {
        runId,
        createdAt: new Date('2026-09-29T10:00:01Z'),
        data: {
          phase: 'context-compacted',
          summary: 'Old search was completed.',
        },
      },
      {
        runId,
        createdAt: new Date('2026-09-29T10:00:02Z'),
        data: {
          phase: 'tool-uncertain',
          toolName: 'update',
          toolCallId: 'new',
          reason: 'Connection lost',
        },
      },
    ];
    const result = toolHistoryByRun(rows, 'Old search was completed.').get(runId) ?? '';
    expect(result).not.toContain('"old"');
    expect(result).toContain('"state":"uncertain"');
    expect(result).toContain('Connection lost');
    expect(toolHistoryByRun(rows, 'Another summary').get(runId)).toContain('"old"');
  });

  it('carries more than 40 group turns and resumes exactly after a checkpoint', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Group reader',
      instructions: 'Read the group.',
      model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Group' });
    const stamp = '2026-09-29T10:00:00.000Z';
    const ids = Array.from(
      { length: 52 },
      (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    );
    for (const [index, id] of ids.entries()) {
      await insertMessage(services.store.db, {
        id,
        profileId: profile.id,
        sessionId: session.id,
        role: 'user',
        content: `Alice: group turn ${index}`,
        author: { id: 'alice', name: 'Alice' },
        createdAt: stamp,
      });
    }
    const first = await services.runs.submit(profile.id, session.id, {
      text: 'What did Alice say?',
      requestKey: 'group-first',
    });
    const full = await services.contexts.context(first);
    expect(full.messages[0]?.content).toContain('group turn 0');
    expect(full.messages[0]?.content).toContain('group turn 51');
    expect(full.messages.at(-1)?.content).toContain('What did Alice say?');

    await services.sessions.summarize(profile.id, session.id, 'Legacy checkpoint', stamp);
    expect((await services.contexts.context(first)).messages[0]?.content).toContain('group turn 0');

    await services.sessions.summarize(
      profile.id,
      session.id,
      'Alice discussed the group.',
      stamp,
      ids[49],
    );
    const resumed = await services.contexts.context(first);
    expect(resumed.system).toContain('Alice discussed the group.');
    expect(resumed.messages[0]?.content).not.toContain('group turn 49');
    expect(resumed.messages[0]?.content).toContain('group turn 50');
    expect(resumed.messages[0]?.content).toContain('group turn 51');
    expect(resumed.messages.at(-1)?.content).toContain('What did Alice say?');
  });

  it('retains a Unicode current turn when the old history setting is zero', async () => {
    const services = await testServices();

    const profile = await services.profiles.createProfile({
      name: 'Zero history',
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'gpt-4o', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
      contextPolicy: { historyTokens: 0 },
    });

    const session = await services.sessions.createSession(profile.id, { title: 'Unicode' });

    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Olá 世界 🌍',
      requestKey: 'current',
    });

    const context = await services.contexts.context(run);

    expect(context.messages).toEqual([{ role: 'user', content: 'Olá 世界 🌍' }]);
  });

  it('includes structured identity and a skill catalog while selecting relevant memories', async () => {
    const { services, profile, run } = await fixture();

    await services.memories.remember(profile.id, {
      key: 'deployment',
      content: 'Deployment completed at 21:00',
      expectedVersion: 0,
    });

    await services.memories.remember(profile.id, {
      key: 'weather',
      content: 'Forecast is sunny',
      expectedVersion: 0,
    });

    const context = buildContext(run, {
      memories: await services.memories.memories(profile.id),
      activities: [],
      history: await services.sessions.messages(profile.id, run.sessionId),
    });

    expect(context.system).toContain('Researcher');
    expect(context.system).toContain('No external writes');
    expect(context.system).toContain('Deployment completed at 21:00');
    expect(context.system).not.toContain('Forecast is sunny');
    expect(context.system).toContain('Search the catalog');
    expect(context.system).not.toContain('Private skill body');
    expect(context.messages.at(-1)?.content).toBe('When was the deployment?');
  });

  it('refuses an oversized prompt instead of silently dropping tool-call/result blocks', () => {
    const messages = [
      { role: 'user' as const, content: 'old'.repeat(5000) },
      { role: 'assistant' as const, content: 'old answer'.repeat(3000) },
      { role: 'user' as const, content: 'current question' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'tool-call' as const, toolCallId: 'latest', toolName: 'search', input: {} },
        ],
      },
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'latest',
            toolName: 'search',
            output: { type: 'text' as const, value: 'answer' },
          },
        ],
      },
    ];

    expect(() =>
      fitPrompt({
        provider: 'anthropic',
        modelId: 'test',
        policy: { inputTokens: 4096, outputTokens: 256 },
        instructions: 'Answer carefully.',
        messages,
        tools: {},
      }),
    ).toThrow('Context budget exceeded');
  });

  it('fails if the mandatory current turn and tool schemas cannot fit with output reserved', () => {
    expect(() =>
      fitPrompt({
        provider: 'anthropic',
        modelId: 'test',
        policy: { inputTokens: 4096, outputTokens: 256 },
        instructions: 'x'.repeat(5000),
        messages: [{ role: 'user', content: 'current' }],
        tools: {},
      }),
    ).toThrow('Context budget exceeded');
  });

  it('charges exposed tool descriptions and schemas against the input budget', () => {
    const tools = {
      oversized: tool({
        description: 'x'.repeat(5000),
        inputSchema: z.object({ query: z.string() }),
      }),
    };

    expect(() =>
      fitPrompt({
        provider: 'anthropic',
        modelId: 'test',
        policy: { inputTokens: 4096, outputTokens: 256 },
        instructions: 'Answer.',
        messages: [{ role: 'user', content: 'Find this' }],
        tools,
      }),
    ).toThrow('Context budget exceeded');
  });
});

it('counts special-token literals as ordinary input', () => {
  const first = tokenCounter('openai', 'gpt-4o');

  expect(first('Explain <|endoftext|> literally.')).toBeGreaterThan(0);
});

describe('compaction', () => {
  const message = (id: string, content: string, at: string): Message => ({
    id,
    profileId: '11111111-1111-4111-8111-111111111111',
    sessionId: '33333333-3333-4333-8333-333333333333',
    runId: '22222222-2222-4222-8222-222222222222',
    role: 'user',
    content,
    createdAt: at,
  });

  it('replaces the older turns and keeps the recent ones as written', async () => {
    const history = Array.from({ length: 12 }, (_, index) =>
      message(
        `m${index}`,
        `turn ${index}: ${'details '.repeat(100)}`,
        new Date(1700000000000 + index * 1000).toISOString(),
      ),
    );

    let asked = '';

    const compacted = await compactPrompt({
      provider: 'openai',
      modelId: 'test',
      policy: { inputTokens: 16000, outputTokens: 512 },
      onUsage: async () => {},
      model: mockModel({
        doGenerate: async (options) => {
          asked = JSON.stringify(options.prompt);

          return {
            content: [{ type: 'text', text: '## Open request\nNone' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
      previous: undefined,
      messages: history.map(({ role, content }) => ({ role, content })),
      signal: AbortSignal.timeout(5000),
    });

    expect(compacted?.messages.at(-1)?.content).toBe(history[11]?.content);
    expect(asked).toContain('turn 9');
    expect(asked).not.toContain('turn 10');
  });

  it('summarizes all history through a compactor with a smaller context', async () => {
    const messages = Array.from({ length: 14 }, (_, index) => ({
      role: 'user' as const,
      content: `turn-${index}: ${'details '.repeat(200)}`,
    }));
    let consumed = '';
    const result = await compactPrompt({
      provider: 'test',
      modelId: 'small',
      policy: { inputTokens: 5000, outputTokens: 512 },
      messages,
      signal: AbortSignal.timeout(5000),
      onUsage: async () => {},
      model: mockModel({
        doGenerate: async (options) => {
          const user = options.prompt.filter((message) => message.role === 'user');
          consumed += user
            .map((message) =>
              message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
            )
            .join('');
          return {
            content: [{ type: 'text', text: 'Checkpoint with decisions.' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 5, text: 5, reasoning: 0 },
            },
            warnings: [],
          };
        },
      }),
    });
    expect(consumed).toBe(JSON.stringify(messages.slice(0, -2)));
    expect(result?.messages.at(-1)).toEqual(messages.at(-1));
    expect(result?.summary).toBe('Checkpoint with decisions.');
  });

  it('leaves a short conversation alone', async () => {
    const history = Array.from({ length: 3 }, (_, index) =>
      message(
        `m${index}`,
        `turn ${index}: ${'details '.repeat(100)}`,
        new Date(1700000000000 + index * 1000).toISOString(),
      ),
    );

    await expect(
      compactPrompt({
        provider: 'openai',
        modelId: 'test',
        policy: { inputTokens: 16000, outputTokens: 512 },
        onUsage: async () => {},
        model: mockModel({ doGenerate: async () => ({}) as never }),
        previous: undefined,
        messages: history.map(({ role, content }) => ({ role, content })),
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toBeUndefined();
  });

  it('compacts only once the prompt is nearly full', () => {
    expect(needsCompaction(8600, 10000)).toBe(true);
    expect(needsCompaction(8000, 10000)).toBe(false);
  });
});

it('reserves pixel tokens for image files without counting their base64 transport', () => {
  const cost = (data: string) =>
    promptTokens({
      provider: 'anthropic',
      modelId: 'test',
      instructions: '',
      tools: {},
      messages: [{ role: 'user', content: [{ type: 'file', mediaType: 'image/png', data }] }],
    });
  expect(cost('AA==')).toBeGreaterThan(8192);
  expect(cost('AA==')).toBe(cost('AA=='.repeat(10000)));
});
