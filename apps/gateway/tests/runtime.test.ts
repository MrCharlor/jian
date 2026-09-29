import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { mockModel } from './helpers/model.js';
import { events } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Atlas',
  instructions: 'Help.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

it('keeps what the agent said before a tool apart from what it says after', async () => {
  const { services, profile, run } = await fixture();
  let step = 0;
  const model = mockModel({
    doGenerate: async () =>
      step++ === 0
        ? {
            content: [
              { type: 'text', text: 'Saving the deploy time now.' },
              {
                type: 'tool-call',
                toolCallId: 'save-time',
                toolName: 'remember',
                input: JSON.stringify({
                  key: 'deploy',
                  content: 'Deploy at 21:00',
                  expectedVersion: 0,
                }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          }
        : answer('Saved: deploy at 21:00.'),
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  expect(finished.commentary).toEqual(['Saving the deploy time now.']);
  expect(finished.output).toBe('Saved: deploy at 21:00.');
});

it('recovers an empty final response without repeating completed actions', async () => {
  const { services, profile, run } = await fixture();
  let step = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      if (!options.tools?.length) {
        expect(JSON.stringify(options.prompt)).toContain('Deploy at 21:00');
        return answer('Saved the deployment time.');
      }
      if (step++ === 0) {
        return {
          content: [
            { type: 'text', text: 'Found it.' },
            {
              type: 'tool-call',
              toolCallId: 'save-time',
              toolName: 'remember',
              input: JSON.stringify({
                key: 'deploy',
                content: 'Deploy at 21:00',
                expectedVersion: 0,
              }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return {
        ...answer(''),
        content: [{ type: 'reasoning', text: 'The work is saved.' }],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('Saved the deployment time.');
  expect(await services.memories.memories(profile.id)).toMatchObject([
    { key: 'deploy', content: 'Deploy at 21:00', version: 1 },
  ]);
});

it('reports a missing final response when the recovery also returns no text', async () => {
  const { services, profile, run } = await fixture();
  let calls = 0;
  const model = mockModel({
    doGenerate: async () => {
      calls++;
      return answer('');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('failed');
  expect(finished.error).toContain('without a final response');
  expect(calls).toBe(2);
});

it('names a new conversation without an uncounted model request', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, {});
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Please prepare a deployment report with all the completed steps and remaining checks.',
    requestKey: 'title',
  });
  let calls = 0;
  const model = mockModel({
    doGenerate: async () => {
      calls++;
      return answer('Report ready.');
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.sessions.session(profile.id, session.id)).title).toContain(
    'Please prepare',
  );
  expect(calls).toBe(1);
});

async function fixture(contextPolicy?: Record<string, number>, subscription = false) {
  const services = await testServices();
  const configured = subscription
    ? {
        ...input,
        model: {
          provider: 'anthropic',
          modelId: 'test',
          credential: 'subscription',
          apiKeyEnv: 'ANTHROPIC_API_TOKEN',
        },
      }
    : input;
  const profile = await services.profiles.createProfile(
    contextPolicy ? { ...configured, contextPolicy } : configured,
  );
  const session = await services.sessions.createSession(profile.id, { title: 'Mac' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Remember the deployment time',
    requestKey: 'one',
  });

  return { services, profile, session, run };
}

it('hides disabled generation tools but keeps saved stickers available to the agent', async () => {
  const { services, profile, run } = await fixture();
  let step = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      if (step++ === 0)
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'load',
              toolName: 'load_tools',
              input: JSON.stringify({ groups: ['media'] }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      const names = options.tools?.map((tool) => tool.name) ?? [];
      expect(names).not.toContain('generate_image');
      expect(names).not.toContain('generate_speech');
      expect(names).not.toContain('list_speech_voices');
      expect(names).toContain('find_stickers');
      expect(names).toContain('send_sticker');
      return answer('Done.');
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
});

describe('agent runtime', () => {
  it('holds one prompt for the whole turn so the provider can read it back', async () => {
    const { services, profile, session, run } = await fixture();
    const systems: string[] = [];
    let step = 0;

    const model = mockModel({
      doGenerate: async (options) => {
        step++;

        if (step === 1) {
          systems.push(JSON.stringify(options.prompt.filter((m) => m.role === 'system')));

          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'remember',
                input: JSON.stringify({
                  key: 'deployment',
                  content: 'Deploy at 21:00',
                  expectedVersion: 0,
                }),
              },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        systems.push(JSON.stringify(options.prompt.filter((m) => m.role === 'system')));

        return answer('Saved: deploy at 21:00.');
      },
    });

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const completed = await services.runs.run(profile.id, run.id);

    expect(completed.status).toBe('completed');
    expect(completed.output).toBe('Saved: deploy at 21:00.');

    // Byte for byte the same instructions on both steps: rebuilding them per step changed the
    // one part of the request the provider caches, and every step paid for it again.
    expect(systems).toHaveLength(2);
    expect(systems[0]).toBe(systems[1]);
    expect((await services.memories.memories(profile.id))[0]?.sourceSessionId).toBe(session.id);

    const other = await services.sessions.createSession(profile.id, { title: 'Telegram' });

    const otherRun = await services.runs.submit(profile.id, other.id, {
      text: 'When was the deployment?',
      requestKey: 'two',
    });

    expect((await services.contexts.context(otherRun)).system).toContain('Deploy at 21:00');

    expect(
      (await events(services.store, profile.id, 0)).filter(
        (e) => e.type === 'run.step' && (e.data as { phase: string }).phase === 'step-completed',
      ),
    ).toHaveLength(2);
  });

  it('persists a safe failure without leaking provider credentials', async () => {
    const { services, profile, run } = await fixture();

    const model = mockModel({
      doGenerate: async () => {
        throw new Error('Bearer secret-api-key');
      },
    });

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const result = await services.runs.run(profile.id, run.id);

    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('secret-api-key');

    expect(JSON.stringify(await events(services.store, profile.id, 0))).not.toContain(
      'secret-api-key',
    );
  });

  it('says what went wrong, in a line, with every credential masked', async () => {
    const { services, profile, run } = await fixture();

    const model = mockModel({
      doGenerate: async () => {
        throw new Error('fetch failed: upstream reset while sending api_key=abc123secret', {
          cause: new Error('socket hang up near sk-proj-0123456789abcdefghij'),
        });
      },
    });

    await new AgentRuntime(services, () => model).execute(profile.id, run.id);

    const { error } = await services.runs.run(profile.id, run.id);

    expect(error).toBe('The run failed: socket hang up near [REDACTED]');
    expect(error).not.toContain('abc123secret');
  });

  it('does not execute a cancelled or already claimed run', async () => {
    const { services, profile, run } = await fixture();

    await services.runs.cancel(profile.id, run.id);

    await new AgentRuntime(services, () => {
      throw new Error('must not resolve');
    }).execute(profile.id, run.id);

    expect((await services.runs.run(profile.id, run.id)).status).toBe('cancelled');
  });

  it('bounds context without dropping the newest user message', async () => {
    const { services, profile, run } = await fixture();

    for (let i = 0; i < 20; i++) {
      await services.memories.remember(profile.id, {
        key: `memory-${i}`,
        content: 'x'.repeat(4000),
        expectedVersion: 0,
      });
    }

    const context = await services.contexts.context(run);

    expect(context.system.length).toBeLessThan(24_000);
    expect(context.messages.at(-1)?.content).toBe('Remember the deployment time');
  });
});

it('resolves a provider key from the installation vault and keeps it out of durable events', async () => {
  const { services, profile } = await fixture();
  const vaultSecret = 'vault"\\\nsecret';

  const provider = await services.providers.createProvider({
    name: 'Model',
    kind: 'openai',
    secret: vaultSecret,
  });

  const updated = await services.profiles.updateProfile(profile.id, {
    expectedVersion: profile.version,
    model: { provider: 'openai', modelId: 'test', providerId: provider.id },
  });

  const session = await services.sessions.createSession(updated.id, { title: 'Vault' });
  const run = await services.runs.submit(updated.id, session.id, {
    text: 'Hello',
    requestKey: 'vault',
  });
  let resolvedKey: string | undefined;
  const model = mockModel({ doGenerate: async () => answer(`Hello ${vaultSecret}`) });

  await new AgentRuntime(
    services,
    (_config, _env, _fetch, key) => {
      resolvedKey = key;

      return model;
    },
    { gatewayVault: services.gatewayVault },
  ).execute(updated.id, run.id);

  expect(resolvedKey).toBe(vaultSecret);

  const finished = await services.runs.run(updated.id, run.id);

  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('Hello [REDACTED]');

  expect(JSON.stringify(await events(services.store, updated.id, 0))).not.toContain(
    JSON.stringify(vaultSecret).slice(1, -1),
  );
});

it.each([31700, 32000])('answers at or beyond the token cap (input: %s)', async (inputTokens) => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    ...input,
    model: {
      provider: 'anthropic',
      modelId: 'test',
      credential: 'subscription',
      apiKeyEnv: 'ANTHROPIC_API_TOKEN',
    },
    contextPolicy: { maxRunTokens: 32000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Budget' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello',
    requestKey: 'budget',
  });
  let calls = 0;

  const model = mockModel({
    doGenerate: async (options) => {
      calls++;

      if (!options.tools?.length) {
        if (
          !JSON.stringify(options.prompt).includes(
            "You are Claude Code, Anthropic's official CLI for Claude.",
          )
        ) {
          throw new Error('Missing subscription identity on closing call');
        }
        expect(JSON.stringify(options.prompt)).toContain('Hello');
        return {
          content: [{ type: 'text', text: 'I ran out of budget mid-way.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 5, text: 5, reasoning: 0 },
          },
          warnings: [],
        };
      }

      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `call-${calls}`,
            toolName: 'list_activities',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: {
          inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 300, text: 300, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).usage).toEqual({
    inputTokens: inputTokens + 10,
    outputTokens: 305,
    cachedInputTokens: 0,
    estimated: false,
    steps: 1,
  });

  // One step of the loop, then the closing call: no further tool round is started.
  expect(calls).toBe(2);

  const finished = await services.runs.run(profile.id, run.id);

  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('I ran out of budget mid-way.');
});

it('uses conservative estimates when a provider omits usage counters', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    ...input,
    contextPolicy: { maxRunTokens: 32000 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Missing usage' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Continue',
    requestKey: 'missing-usage',
  });

  let calls = 0;

  const absentUsage = {
    inputTokens: {
      total: undefined,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  } as unknown as typeof usage;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `unknown-${calls}`,
            toolName: 'list_activities',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: absentUsage,
        warnings: [],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  expect(finished.status).toBe('completed');
  expect(calls).toBeLessThan(12);
  expect(finished.usage?.inputTokens).toBeGreaterThan(0);
  expect(finished.output).toContain('checkpoint');
});

it('does not charge the estimated full prompt against the remaining run budget', async () => {
  const { services, profile, run } = await fixture({ maxRunTokens: 32000 });
  let step = 0;
  const model = mockModel({
    doGenerate: async () => {
      if (step++ > 0) return answer('The saved work is ready.');
      return {
        content: [
          { type: 'tool-call', toolCallId: 'read', toolName: 'list_activities', input: '{}' },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 30000, noCache: 30000, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 10, text: 10, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('The saved work is ready.');
});

it('keeps a complete answer that crosses the budget without paying for a second answer', async () => {
  const { services, profile, run } = await fixture({ maxRunTokens: 32000 });
  const model = mockModel({
    doGenerate: async () => ({
      ...answer('All requested work is done.'),
      usage: {
        inputTokens: { total: 32000, noCache: 32000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 300, text: 300, reasoning: 0 },
      },
    }),
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.output).toBe('All requested work is done.');
  expect(finished.usage?.inputTokens).toBe(32000);
});

it.each([false, true])(
  'compacts tool work into a durable checkpoint (subscription: %s)',
  async (subscription) => {
    const { services, profile, session, run } = await fixture(
      {
        inputTokens: 32000,
        historyTokens: 1000,
        toolResultTokens: 8000,
        maxSteps: 10,
      },
      subscription,
    );
    await services.memories.remember(
      profile.id,
      {
        key: 'unrelated',
        content: `receipt-123 ${'large result '.repeat(280)}`,
        expectedVersion: 0,
      },
      session.id,
    );
    let step = 0;
    let afterCheckpoint = false;
    const model = mockModel({
      doGenerate: async (options) => {
        const prompt = JSON.stringify(options.prompt);
        if (!options.tools?.length) {
          if (
            subscription &&
            !prompt.includes("You are Claude Code, Anthropic's official CLI for Claude.")
          ) {
            throw new Error('Missing subscription system identity');
          }
          expect(prompt).toContain('receipt-123');
          return answer('Checkpoint: receipt-123 was inspected; finish the deployment report.');
        }
        if (prompt.includes('Checkpoint: receipt-123')) {
          afterCheckpoint = true;
          expect(prompt).toContain('Remember the deployment time');
          return answer('Report complete using receipt-123.');
        }
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `read-${step++}`,
              toolName: 'read_memories',
              input: '{}',
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      },
    });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
    const finished = await services.runs.run(profile.id, run.id);
    expect(afterCheckpoint).toBe(true);
    expect(finished.status).toBe('completed');
    expect(finished.commentary ?? []).not.toContain(
      'Summarising what we said earlier so I can carry on.',
    );
    expect((await services.sessions.session(profile.id, session.id)).summary).toContain(
      'receipt-123',
    );
    expect(finished.usage?.inputTokens).toBe((step + 2) * 10);
  },
);

it.each([false])('uses the separately selected compaction model', async (subscription) => {
  const { services, profile, session, run } = await fixture(
    {
      inputTokens: 32000,
      historyTokens: 1000,
      toolResultTokens: 8000,
      maxSteps: 10,
    },
    subscription,
  );
  await services.memories.remember(
    profile.id,
    {
      key: 'unrelated',
      content: `receipt-123 ${'large result '.repeat(280)}`,
      expectedVersion: 0,
    },
    session.id,
  );
  const provider = await services.providers.createProvider({
    name: 'Summary',
    kind: 'google',
    secret: 'synthetic-summary-key-1234567890',
  });
  await services.providers.setModelDefaults(profile.id, {
    compaction: { providerId: provider.id, modelId: 'summary-model' },
  });
  let summaryCalls = 0;
  let step = 0;
  let afterCheckpoint = false;
  const model = mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (!options.tools?.length) {
        if (
          subscription &&
          !prompt.includes("You are Claude Code, Anthropic's official CLI for Claude.")
        ) {
          throw new Error('Missing subscription system identity');
        }
        expect(prompt).toContain('receipt-123');
        return answer('Checkpoint: receipt-123 was inspected; finish the deployment report.');
      }
      if (prompt.includes('Checkpoint: receipt-123')) {
        afterCheckpoint = true;
        expect(prompt).toContain('Remember the deployment time');
        return answer('Report complete using receipt-123.');
      }
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `read-${step++}`,
            toolName: 'read_memories',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });
  await new AgentRuntime(
    services,
    (config, _env, _fetch, key) => {
      if (config.modelId === 'summary-model') {
        expect(key).toBe('synthetic-summary-key-1234567890');
        summaryCalls++;
      }
      return model;
    },
    { gatewayVault: services.gatewayVault },
  ).execute(profile.id, run.id);
  expect(summaryCalls).toBeGreaterThan(0);
  const finished = await services.runs.run(profile.id, run.id);
  expect(afterCheckpoint).toBe(true);
  expect(finished.status).toBe('completed');
  expect(finished.commentary ?? []).not.toContain(
    'Summarising what we said earlier so I can carry on.',
  );
  expect((await services.sessions.session(profile.id, session.id)).summary).toContain(
    'receipt-123',
  );
  expect(finished.usage?.inputTokens).toBe((step + 2) * 10);
});

it('reports a safe context-budget error when required prompt content cannot fit', async () => {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    ...input,
    instructions: 'x'.repeat(8000),
    // The smallest legal budget that cannot hold the tool definitions and the prompt.
    contextPolicy: { inputTokens: 16000, outputTokens: 15000 },
  });

  const session = await services.sessions.createSession(profile.id, { title: 'Budget' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hi',
    requestKey: 'too-large',
  });
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      return answer('Unexpected.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  expect(calls).toBe(0);
  expect(finished.status).toBe('failed');
  expect(finished.error).toContain('Context budget exceeded');
  expect(finished.error).toContain('Tool definitions cost');
  expect(finished.error).not.toContain('credential');
});

it('does not mark a local validation failure as an uncertain external effect', async () => {
  const { services, profile, run } = await fixture();
  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls++;

      if (calls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'bad-version',
              toolName: 'remember',
              input: JSON.stringify({ key: 'test', content: 'Dummy', expectedVersion: 99 }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('I will ask for the current version.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(calls).toBe(2);
});

it('preserves bounded, sanitized local tool error details', async () => {
  const { services, profile, run } = await fixture();
  const failure = Object.assign(
    new Error('Invalid schedule: Cookie: synthetic-cookie; other=second-cookie'),
    {
      origin: 'validation',
      code: 'invalid_format',
      format: 'cron',
      path: ['cron'],
      issues: [{ path: ['cron'], message: 'Five fields required', code: 'invalid_format' }],
      headers: { authorization: 'Bearer synthetic-header' },
      stack: 'synthetic-stack',
    },
  );
  services.memories.remember = async () => {
    throw failure;
  };
  let prompt = '';
  let calls = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      if (calls++ === 0) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'bad-schedule',
              toolName: 'remember',
              input: JSON.stringify({
                key: 'test',
                content: 'Check.',
                expectedVersion: 0,
              }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      prompt = JSON.stringify(options.prompt);
      return answer('The schedule was invalid.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const checkpoints = await services.lifecycle.checkpoints(profile.id, run.id);
  const durable = JSON.stringify(checkpoints);
  const failed = checkpoints
    .map((checkpoint) => checkpoint.data as { phase?: string; reason?: string })
    .find((data) => data.phase === 'tool-failed');
  const detail = JSON.parse(String(failed?.reason));
  expect(prompt).toContain('invalid_format');
  expect(prompt).toContain('Five fields required');
  expect(detail).toMatchObject({
    origin: 'validation',
    code: 'invalid_format',
    format: 'cron',
    path: ['cron'],
    issues: [{ path: ['cron'], message: 'Five fields required' }],
  });
  expect(`${prompt}${durable}`).not.toMatch(
    /synthetic-cookie|second-cookie|synthetic-header|synthetic-stack|authorization|headers/,
  );
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
});

it('stores a large tool output and sends only a bounded reference to the model', async () => {
  const { services, profile, run } = await fixture();

  for (let i = 0; i < 5; i++) {
    await services.memories.remember(profile.id, {
      key: `large-${i}`,
      content: `result-${i}:${'x'.repeat(3900)}`,
      expectedVersion: 0,
    });
  }

  let capturedOutput: unknown;
  let secondPrompt = '';
  let step = 0;

  const model = mockModel({
    doGenerate: async (options) => {
      step++;

      if (step === 1) {
        return {
          content: [
            { type: 'tool-call', toolCallId: 'large', toolName: 'read_memories', input: '{}' },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      secondPrompt = JSON.stringify(options.prompt);

      return answer('I found the artifact.');
    },
  });

  await new AgentRuntime(services, () => model, {
    storeArtifact: async (_run, _toolName, output) => {
      capturedOutput = output;

      return {
        artifactId: '00000000-0000-4000-8000-000000000001',
        bytes: JSON.stringify(output).length,
      };
    },
  }).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(JSON.stringify(capturedOutput)).toContain('result-0:');
  expect(secondPrompt).toContain('00000000-0000-4000-8000-000000000001');
  expect(secondPrompt).not.toContain('x'.repeat(3900));

  expect(JSON.stringify(await services.lifecycle.checkpoints(profile.id, run.id))).toContain(
    '00000000-0000-4000-8000-000000000001',
  );

  expect(JSON.stringify(await events(services.store, profile.id, 0))).not.toContain(
    'x'.repeat(3900),
  );
});

it('redacts an escaped host credential from tool prompts, artifacts, checkpoints and final output', async () => {
  const secret = 'quote"\\\nline';
  const escaped = JSON.stringify(secret).slice(1, -1);
  const previous = process.env.JIAN_PROVIDER_TEST;

  process.env.JIAN_PROVIDER_TEST = secret;

  try {
    const { services, profile, run } = await fixture();

    await services.memories.remember(profile.id, {
      key: 'hidden',
      content: `${secret}${'x'.repeat(3800)}`,
      expectedVersion: 0,
    });

    let prompt = '';
    let artifact: unknown;
    let step = 0;

    const model = mockModel({
      doGenerate: async (options) => {
        step++;

        if (step === 1) {
          return {
            content: [
              { type: 'tool-call', toolCallId: 'read', toolName: 'read_memories', input: '{}' },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage,
            warnings: [],
          };
        }

        prompt = JSON.stringify(options.prompt);

        return answer(`Echo: ${secret} | ${escaped}`);
      },
    });

    await new AgentRuntime(services, () => model, {
      storeArtifact: async (_run, _toolName, output) => {
        artifact = output;

        return {
          artifactId: '00000000-0000-4000-8000-000000000001',
          bytes: JSON.stringify(output).length,
        };
      },
    }).execute(profile.id, run.id);

    const result = await services.runs.run(profile.id, run.id);

    const durable = JSON.stringify({
      artifact,
      checkpoints: await services.lifecycle.checkpoints(profile.id, run.id),
      events: await events(services.store, profile.id, 0),
      output: result.output,
    });

    expect(result.status).toBe('completed');
    expect(prompt).not.toContain(escaped);
    expect(durable).not.toContain(escaped);
    expect(durable).toContain('[REDACTED]');
    expect(result.output).toBe('Echo: [REDACTED] | [REDACTED]');
  } finally {
    if (previous === undefined) {
      delete process.env.JIAN_PROVIDER_TEST;
    } else {
      process.env.JIAN_PROVIDER_TEST = previous;
    }
  }
});

it('creates a child profile without inheriting provider access', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ ...input, allowSelfManagement: true });
  const session = await services.sessions.createSession(profile.id, { title: 'Parent' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Create a child',
    requestKey: 'child',
  });

  let step = 0;

  const model = mockModel({
    doGenerate: async () => {
      step++;

      if (step === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'load',
              toolName: 'load_tools',
              input: JSON.stringify({ groups: ['self'] }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      if (step === 2) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'child',
              toolName: 'create_profile',
              input: JSON.stringify({ name: 'Child', instructions: 'Help.' }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('Created.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const child = (await services.profiles.profiles()).find(
    (candidate) => candidate.name === 'Child',
  );

  expect(child?.model.apiKeyEnv).toBeUndefined();
  expect(child?.model.providerId).toBeUndefined();
  expect(child?.allowSelfManagement).toBe(false);
});

it('answers with what it has when the agent exhausts its tool budget', async () => {
  const { services, profile, run } = await fixture({ maxSteps: 3 });
  let calls = 0;
  let closingTools: unknown;

  const model = mockModel({
    doGenerate: async (options) => {
      calls += 1;

      // The closing call carries no tools, so it cannot start another round.
      if (!options.tools?.length) {
        closingTools = options.tools;

        return {
          content: [{ type: 'text', text: 'I read three activities and ran out of steps.' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage,
          warnings: [],
        };
      }

      return {
        content: [
          { type: 'text', text: 'Still working.' },
          {
            type: 'tool-call',
            toolCallId: `call-${calls}`,
            toolName: 'list_activities',
            input: '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);

  // The tools were paid for; throwing the turn away would have wasted them and told the
  // person nothing.
  expect(finished.status).toBe('completed');
  expect(finished.output).toBe('I read three activities and ran out of steps.');
  expect(closingTools ?? []).toHaveLength(0);
});

it('writes its own skill through the loop without accepting new capability grants', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile(input);
  const session = await services.sessions.createSession(profile.id, { title: 'Skills' });

  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Save a release skill',
    requestKey: 'skill',
  });

  let calls = 0;

  const model = mockModel({
    doGenerate: async () => {
      calls += 1;

      if (calls === 1) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'load',
              toolName: 'load_tools',
              input: JSON.stringify({ groups: ['skills'] }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      if (calls === 2) {
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: 'skill',
              toolName: 'create_skill',
              input: JSON.stringify({
                name: 'release',
                description: 'Release checklist',
                instructions: 'Confirm tests before release.',
                // Not in the tool's input: a model cannot grant itself anything through it.
                model: { provider: 'openai', modelId: 'other' },
              }),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }

      return answer('Skill saved.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');

  const updated = await services.profiles.profile(profile.id);

  expect(updated.version).toBe(2);
  expect(updated.skills[0]).toMatchObject({ name: 'release', writtenBy: 'agent' });
  expect(updated.model).toEqual(profile.model);
  expect(updated.mcpServers).toEqual([]);
});

it('tells the owner what the provider answered instead of a generic failure', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Limite' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Oi',
    requestKey: 'rate-limited',
  });

  // What a subscription answers once its window is spent: a status, and a body that says
  // nothing. The status is the part worth repeating to the owner.
  const refused = Object.assign(new Error('Error'), { statusCode: 429, responseBody: '{}' });

  const runtime = new AgentRuntime(services, async () => {
    throw refused;
  });

  await runtime.execute(profile.id, run.id);

  const failed = await services.runs.run(profile.id, run.id);

  expect(failed.status).toBe('failed');
  expect(failed.error).toContain('rate limiting');
});

it('repeats what the provider said when the refusal carries a reason', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'anthropic' as const, modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_KEY' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Refused' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Oi',
    requestKey: 'refused',
  });

  // A refusal the owner can act on: the status alone would have sent them to the model
  // settings, and the account setting is what actually needs changing.
  const refused = Object.assign(new Error('Error'), {
    statusCode: 400,
    data: { error: { message: 'Third-party apps draw from your extra usage.' } },
  });

  await new AgentRuntime(services, async () => {
    throw new Error('stream failed', { cause: refused });
  }).execute(profile.id, run.id);

  const failed = await services.runs.run(profile.id, run.id);

  expect(failed.error).toBe(
    'The provider refused with 400: Third-party apps draw from your extra usage.',
  );
});

it('sends each paragraph as it is written and keeps the last as the answer', async () => {
  const { services, profile, run } = await fixture();

  const model = mockModel({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Opening the board.\n\nFound it.\n\nTwelve open.' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const said = (await services.sessions.messages(profile.id, run.sessionId))
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);

  // Three messages in the conversation, not one block cut up on the way out.
  expect(said).toEqual(['Opening the board.', 'Found it.', 'Twelve open.']);
  expect((await services.runs.run(profile.id, run.id)).output).toBe('Twelve open.');
});

it('lets the agent request compaction before reaching the automatic threshold', async () => {
  const { services, profile, run } = await fixture({ inputTokens: 200000, maxSteps: 8 });
  let step = 0;
  let summaries = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      if (!options.tools?.length) {
        summaries++;
        return answer('Checkpoint: deployment time requested. Finish the answer.');
      }
      if (step >= 3) return answer('Ready.');
      const toolName =
        ['load_tools', 'read_memories', 'compact_context'][step++] ?? 'compact_context';
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `call-${step}`,
            toolName,
            input: toolName === 'load_tools' ? JSON.stringify({ groups: ['tasks'] }) : '{}',
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });
  await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  expect(summaries).toBe(1);
  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
});
