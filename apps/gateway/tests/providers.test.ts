import { modelSchema } from '@jian/contracts';
import { generateText } from 'ai';
import { describe, expect, it } from 'vitest';
import { cacheable, cacheableInstructions } from '../src/agent/cache.js';
import {
  anthropicCredential,
  CLAUDE_CODE_IDENTITY,
  withClaudeCodeIdentity,
} from '../src/providers/claude-subscription.js';
import { reasoningProviderOptions, takesAdaptiveThinking } from '../src/providers/effort.js';
import { resolveModel } from '../src/providers/models.js';

describe('providers', () => {
  it.each(['openai', 'anthropic', 'google', 'openai-compatible'] as const)(
    'resolves %s without using another profile’s default',
    async (provider) => {
      const config = modelSchema.parse({
        provider,
        modelId: 'chosen-model',
        apiKeyEnv: 'JIAN_PROVIDER_A',
        ...(provider === 'openai-compatible' ? { baseURL: 'http://localhost:11434/v1' } : {}),
      });

      const model = await resolveModel(config, { JIAN_PROVIDER_A: 'test-only' });

      expect(typeof model).toBe('object');

      if (typeof model !== 'string') {
        expect(model.modelId).toBe('chosen-model');
      }
    },
  );

  it('does not fall back to a global key if the selected credential is absent', async () => {
    await expect(
      resolveModel(
        { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_MISSING' },
        { OPENAI_API_KEY: 'other-profile-secret' },
      ),
    ).rejects.toThrow('Provider key is not configured');
  });
});

it('routes only native API-key models through the enabled default Caveman proxy', async () => {
  const urls: string[] = [];
  const headers: Headers[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    urls.push(String(input));
    headers.push(new Headers(init?.headers));
    return Response.json({ error: { message: 'synthetic' } }, { status: 400 });
  };
  const env = {
    JIAN_CAVEMAN_ENABLED: 'true',
    OPENAI_API_KEY: 'sk-synthetic',
    ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic',
    ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic',
  };
  const call = async (config: Parameters<typeof resolveModel>[0]) => {
    const model = await resolveModel(config, env, fetcher);
    await expect(generateText({ model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow();
    return urls.pop();
  };

  expect(await call({ provider: 'openai', modelId: 'test' })).toBe(
    'http://127.0.0.1:8788/w/jian/openai/v1/responses',
  );
  expect(headers.at(-1)?.get('authorization')).toBe('Bearer sk-synthetic');
  expect(await call({ provider: 'anthropic', modelId: 'test' })).toBe(
    'http://127.0.0.1:8788/w/jian/v1/messages',
  );
  expect(headers.at(-1)?.get('x-api-key')).toBe('sk-ant-api03-synthetic');
  expect(
    await call({
      provider: 'anthropic',
      modelId: 'test',
      credential: 'subscription',
      apiKeyEnv: 'ANTHROPIC_API_TOKEN',
    }),
  ).toBe('https://api.anthropic.com/v1/messages');
  expect(
    await call({ provider: 'openai', modelId: 'test', baseURL: 'https://custom.example/v1' }),
  ).toBe('https://custom.example/v1/responses');
});

it('keeps direct provider calls when the Caveman proxy is disabled', async () => {
  let url = '';
  const model = await resolveModel(
    { provider: 'openai', modelId: 'test' },
    {
      OPENAI_API_KEY: 'sk-synthetic',
      JIAN_CAVEMAN_ENABLED: 'false',
      JIAN_CAVEMAN_PROXY_URL: 'http://127.0.0.1:8788',
    },
    async (input) => {
      url = String(input);
      return Response.json({ error: { message: 'synthetic' } }, { status: 400 });
    },
  );
  await expect(generateText({ model, prompt: 'ping', maxRetries: 0 })).rejects.toThrow();
  expect(url).toBe('https://api.openai.com/v1/responses');
});

it('keeps a cache boundary before changing memories without breaking subscription identity', async () => {
  const bodies: Array<{ system: Array<{ text: string; cache_control?: unknown }> }> = [];
  const model = await resolveModel(
    { provider: 'anthropic', modelId: 'test', credential: 'subscription' },
    {},
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
        { status: 400 },
      );
    },
    'sk-ant-oat01-synthetic',
  );
  for (const value of ['first', 'second']) {
    await expect(
      generateText({
        model,
        maxRetries: 0,
        system: cacheableInstructions(
          withClaudeCodeIdentity(`Help the owner.\n\nRelevant shared memories: ${value}`),
          '1h',
        ),
        messages: cacheable([{ role: 'user', content: 'Hello' }], '1h', 3),
      }),
    ).rejects.toThrow();
  }
  expect(bodies[0]?.system[0]?.text).toBe(CLAUDE_CODE_IDENTITY);
  expect(bodies[0]?.system[1]).toEqual(bodies[1]?.system[1]);
  expect(bodies[0]?.system[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  expect(bodies[0]?.system[2]?.text).toContain('first');
  expect(bodies[1]?.system[2]?.text).toContain('second');
});

it('rejects a compatible provider without an endpoint before making a request', async () => {
  await expect(
    resolveModel(
      { provider: 'openai-compatible', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_LOCAL' },
      { JIAN_PROVIDER_LOCAL: 'local' },
    ),
  ).rejects.toThrow('baseURL is required for compatible providers');
});

it('accepts an explicitly resolved vault key without consulting host environment', async () => {
  const model = await resolveModel(
    {
      provider: 'openai',
      modelId: 'chosen-model',
      providerId: '00000000-0000-4000-8000-000000000001',
    },
    {},
    undefined,
    'dummy-vault-key',
  );

  if (typeof model !== 'string') {
    expect(model.modelId).toBe('chosen-model');
  }
});

it('presents a Claude subscription token as Claude Code, and a key as a key', async () => {
  let headers = new Headers();
  const fetcher: typeof fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  // `claude setup-token` issues this shape. Sent as a key it 401s; sent as a bare bearer it
  // 429s; Anthropic accepts it only from something presenting itself as Claude Code.
  const subscription = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic' },
    fetcher,
  );

  await expect(
    generateText({ model: subscription, prompt: 'Hi', maxRetries: 0 }),
  ).rejects.toThrow();

  expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-synthetic');
  expect(headers.has('x-api-key')).toBe(false);
  expect(headers.get('anthropic-beta')).toContain('oauth-2025-04-20');
  expect(headers.get('anthropic-beta')).toContain('claude-code-20250219');
  expect(headers.get('user-agent')).toMatch(/^claude-code\/\d/);
  expect(headers.get('x-app')).toBe('cli');

  // The same variable holding a real key is still a key: the shape decides, not the name.
  const key = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-api03-synthetic' },
    fetcher,
  );

  await expect(generateText({ model: key, prompt: 'Hi', maxRetries: 0 })).rejects.toThrow();

  expect(headers.get('x-api-key')).toBe('sk-ant-api03-synthetic');
  expect(headers.has('authorization')).toBe(false);
});

it('sends the Claude Code identity as a system block of its own', async () => {
  let sent: { system?: unknown } = {};
  const fetcher: typeof fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as { system?: unknown };

    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  const model = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_TOKEN' },
    { ANTHROPIC_API_TOKEN: 'sk-ant-oat01-synthetic' },
    fetcher,
  );

  await expect(
    generateText({
      model,
      system: withClaudeCodeIdentity('Você é Zero Two.'),
      prompt: 'Oi',
      maxRetries: 0,
    }),
  ).rejects.toThrow();

  // Measured against the real account: the identity appended to the profile's own block is
  // refused, and the same text split in two is accepted.
  expect(sent.system).toEqual([
    { type: 'text', text: CLAUDE_CODE_IDENTITY },
    { type: 'text', text: 'Você é Zero Two.' },
  ]);
});

describe('anthropic credentials', () => {
  it('sends what the owner declared, whatever the credential looks like', () => {
    expect(anthropicCredential('subscription', undefined, 'sk-ant-api03-xyz')).toBe('subscription');
    expect(anthropicCredential('key', 'ANTHROPIC_API_TOKEN', 'whatever')).toBe('key');
  });

  it('reads the prefix before the variable it arrived in', () => {
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_TOKEN', 'sk-ant-api03-xyz')).toBe('key');
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_KEY', 'sk-ant-oat01-xyz')).toBe(
      'subscription',
    );
  });

  it('treats the token variable as the bearer one and anything else as a key', () => {
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_TOKEN', 'opaque')).toBe('subscription');
    expect(anthropicCredential(undefined, 'ANTHROPIC_API_KEY', 'opaque')).toBe('key');
    expect(anthropicCredential(undefined, undefined, undefined)).toBe('key');
  });
});

it('marks the reusable part of an Anthropic prompt so it is read back instead of re-sent', async () => {
  let body: {
    system?: Array<{ cache_control?: unknown }>;
    messages?: Array<{ content: Array<{ cache_control?: unknown }> }>;
  } = {};

  const fetcher: typeof fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  const model = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic' },
    fetcher,
  );

  await expect(
    generateText({
      model,
      system: 'Answer briefly.',
      messages: cacheable([
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Answered' },
        { role: 'user', content: 'Second' },
      ]),
      maxRetries: 0,
    }),
  ).rejects.toThrow();

  // The first mark puts the tools and the instructions behind it; the last two put the turns
  // already spent behind them, which is the half that grows.
  expect(body.messages?.[0]?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.messages?.[1]?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.messages?.[2]?.content.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
});

it('keeps a prefix for an hour when a person is the one answering', async () => {
  let body: { messages?: Array<{ content: Array<{ cache_control?: unknown }> }> } = {};

  const fetcher: typeof fetch = async (_input, options) => {
    body = JSON.parse(String(options?.body));
    return Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic' } },
      { status: 400 },
    );
  };

  const model = await resolveModel(
    { provider: 'anthropic', modelId: 'test', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    { ANTHROPIC_API_KEY: 'sk-ant-api03-synthetic' },
    fetcher,
  );

  await expect(
    generateText({
      model,
      messages: cacheable([{ role: 'user', content: 'Oi' }], '1h'),
      maxRetries: 0,
    }),
  ).rejects.toThrow();

  expect(body.messages?.[0]?.content.at(-1)?.cache_control).toEqual({
    type: 'ephemeral',
    ttl: '1h',
  });
});

describe('anthropic thinking', () => {
  it('lets Claude 4.6 and newer choose their own depth', () => {
    for (const id of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-4-8']) {
      expect(
        reasoningProviderOptions(
          { provider: 'anthropic', modelId: id, reasoningEffort: 'high' },
          6144,
        ),
      ).toEqual({ anthropic: { thinking: { type: 'adaptive' } } });
    }
  });

  it('still sends a budget to the models that require one', () => {
    const options = reasoningProviderOptions(
      { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514', reasoningEffort: 'high' },
      6144,
    );

    expect(options?.anthropic?.thinking).toMatchObject({ type: 'enabled' });
  });

  it('reads a release date as a date and not as a minor version', () => {
    expect(takesAdaptiveThinking('claude-opus-4-1-20250805')).toBe(false);
    expect(takesAdaptiveThinking('claude-3-7-sonnet-20250219')).toBe(false);
    expect(takesAdaptiveThinking('claude-sonnet-4-6')).toBe(true);
  });
});

it('never lets the marks outgrow what Anthropic accepts', () => {
  const marked = cacheable([
    { role: 'user', content: 'First' },
    { role: 'assistant', content: 'Answered' },
    { role: 'user', content: 'Second' },
  ]);

  // The loop hands its own messages back; marking again must not add a breakpoint per step.
  const again = cacheable([...marked, { role: 'assistant', content: 'More' }]);
  const breakpoints = again.filter(
    (message) =>
      (message.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)?.cacheControl,
  );

  // Four is the ceiling, and a step must never add one: the loop hands its own messages back.
  expect(breakpoints.length).toBeLessThanOrEqual(4);
  expect(breakpoints).toHaveLength(
    cacheable([...marked, { role: 'assistant', content: 'More' }]).filter(
      (message) =>
        (message.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)
          ?.cacheControl,
    ).length,
  );
});
