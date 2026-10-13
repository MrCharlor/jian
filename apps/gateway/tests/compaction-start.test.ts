import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { checkpoints } from '../src/storage/schema.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};

const answer = (text: string, finish: 'stop' | 'length' = 'stop') => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: finish, raw: finish },
  usage,
  warnings: [],
});

const BULKY = 'bulky-result ';

/**
 * A conversation like the Gateway one in production: few messages, but each earlier run left
 * tool results in its checkpoints, and replaying them puts the next run over the trigger before
 * its first step.
 */
async function heavyConversation(
  model: Record<string, string> = {
    provider: 'openai',
    modelId: 'test',
    apiKeyEnv: 'JIAN_PROVIDER_TEST',
  },
) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Otto',
    instructions: 'Help.',
    model,
    contextPolicy: { inputTokens: 64000, outputTokens: 4096, maxSteps: 6 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Gateway' });

  for (const [index, label] of ['daily-check', 'agenda-status', 'priorities'].entries()) {
    const run = await services.runs.submit(profile.id, session.id, {
      text: `[Scheduled: ${label}] run the ${label}`,
      requestKey: `earlier-${index}`,
    });
    const owner = randomUUID();
    expect(await services.lifecycle.claim(run.id, profile.id, owner)).not.toBeNull();
    await services.lifecycle.checkpoint(profile.id, run.id, owner, {
      phase: 'step-completed',
      tools: [
        {
          toolName: 'read_board',
          toolCallId: `call-${index}`,
          result: { board: label, cards: BULKY.repeat(1500) },
        },
      ],
    });
    await services.lifecycle.finish(profile.id, run.id, owner, 'completed', `${label} done.`);
  }

  const run = await services.runs.submit(profile.id, session.id, {
    text: '[Scheduled: plan-warnings] send the plan warnings',
    requestKey: 'current',
  });

  return { services, profile, session, run };
}

async function phases(services: Awaited<ReturnType<typeof testServices>>, runId: string) {
  const rows = await services.store.db
    .select({ data: checkpoints.data })
    .from(checkpoints)
    .where(eq(checkpoints.runId, runId))
    .orderBy(asc(checkpoints.createdAt));
  return rows.map((row) => row.data as { phase: string; reason?: string; summary?: string });
}

it('compacts a replayed history that passes the trigger before the first step', async () => {
  const { services, profile, session, run } = await heavyConversation();
  const prompts: string[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt);
      if (!options.tools?.length) {
        expect(prompt).toContain('agenda-status');
        return answer('Checkpoint: daily-check, agenda-status and priorities ran.');
      }
      prompts.push(prompt);
      return answer('Plan warnings sent.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.status).toBe('completed');
  expect(prompts[0]).toContain('Conversation checkpoint');
  expect(prompts[0]).not.toContain(BULKY.repeat(20));
  expect(prompts[0]).toContain('send the plan warnings');
  expect((await phases(services, run.id)).map((data) => data.phase)).toContain('context-compacted');
  expect((await services.sessions.session(profile.id, session.id)).summary).toContain(
    'agenda-status',
  );
});

it('records a failed compaction and drops the oldest turns instead of failing the run', async () => {
  const { services, profile, run } = await heavyConversation();
  const prompts: string[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      // The summary runs out of output, as a thinking model does with a 2048-token ceiling.
      if (!options.tools?.length) return answer('## Open request\nSend the', 'length');
      prompts.push(JSON.stringify(options.prompt));
      return answer('Plan warnings sent.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  const finished = await services.runs.run(profile.id, run.id);
  expect(finished.error).toBeUndefined();
  expect(finished.status).toBe('completed');
  const recorded = await phases(services, run.id);
  const failed = recorded.find((data) => data.phase === 'compaction-failed');
  expect(failed?.reason).toBeTruthy();
  expect(recorded.map((data) => data.phase)).toContain('context-trimmed');
  // The current request survives; the oldest run's replay is what goes.
  expect(prompts[0]).toContain('send the plan warnings');
  expect(prompts[0]).not.toContain('"board":"daily-check"');
});

it('leaves a small conversation alone', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Otto',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64000, outputTokens: 4096, maxSteps: 6 },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Gateway' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Hello there',
    requestKey: 'small',
  });
  let summaries = 0;
  const model = mockModel({
    doGenerate: async (options) => {
      if (!options.tools?.length) summaries++;
      return answer('Hi.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(summaries).toBe(0);
  const recorded = (await phases(services, run.id)).map((data) => data.phase);
  expect(recorded).not.toContain('context-compacted');
  expect(recorded).not.toContain('compaction-failed');
  expect(recorded).not.toContain('context-trimmed');
});

it('writes the summary without thinking, so a thinking Claude does not spend its 2048 tokens', async () => {
  const { services, profile, run } = await heavyConversation({
    provider: 'anthropic',
    modelId: 'claude-opus-5-5',
    apiKeyEnv: 'JIAN_PROVIDER_TEST',
    reasoningEffort: 'high',
  });
  const thinking: unknown[] = [];
  const model = mockModel({
    doGenerate: async (options) => {
      if (!options.tools?.length) {
        thinking.push(options.providerOptions?.anthropic?.thinking);
        return answer('Checkpoint: daily-check, agenda-status and priorities ran.');
      }
      return answer('Plan warnings sent.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, run.id);

  expect((await services.runs.run(profile.id, run.id)).status).toBe('completed');
  expect(thinking).toEqual([{ type: 'disabled' }]);
});
