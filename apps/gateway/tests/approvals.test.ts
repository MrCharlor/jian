import { parseApprovalReply } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { composeGuards, guardTools, mcpActionKind, policyGuard } from '../src/agent/guard.js';
import { Approvals, canonical, inputHash, levelOf } from '../src/approvals/service.js';
import { testServices } from './helpers/services.js';

const input = {
  name: 'Otto',
  instructions: 'Operate the board.',
  model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
};

const call = async (definition: unknown, input: unknown) =>
  (definition as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'call',
    messages: [],
  });

const askFirst = { machine: 2, service: 2, message: 2, tools: {} };

/** A profile that asks first, a conversation and one queued run: what a tool call happens inside of. */
async function fixture(policy: Record<string, unknown> = askFirst) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ ...input, actionPolicy: policy });
  const session = await services.sessions.createSession(profile.id, { title: 'Board' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Comment on the card.',
    requestKey: 'first',
  });

  return { services, profile, session, run };
}

describe('the owner reply', () => {
  it('reads an answer with a number, in either language, with or without a reason', () => {
    expect(parseApprovalReply('ok 3')).toEqual({ number: 3, approve: true });
    expect(parseApprovalReply('OK #12')).toEqual({ number: 12, approve: true });
    expect(parseApprovalReply('não 3: texto errado')).toEqual({
      number: 3,
      approve: false,
      reason: 'texto errado',
    });
    expect(parseApprovalReply('no 7 - later')).toEqual({
      number: 7,
      approve: false,
      reason: 'later',
    });
    expect(parseApprovalReply('ok')).toBeUndefined();
    expect(parseApprovalReply('ok 3 cards were moved yesterday')).toBeUndefined();
  });

  it('hashes the same call the same way whatever the order of its fields', () => {
    expect(canonical({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(inputHash({ text: 'a' })).not.toBe(inputHash({ text: 'b' }));
  });

  it('reads the level of the exact action before the level of its kind', () => {
    const policy = { machine: 2, service: 3, message: 1, tools: { 'vx.comment': 2 } } as const;

    expect(levelOf(policy, 'vx.comment', 'service')).toBe(2);
    expect(levelOf(policy, 'vx.move', 'service')).toBe(3);
    expect(levelOf(policy, 'send_file', 'message')).toBe(1);
  });
});

describe('the policy guard', () => {
  it('reads an unannotated server tool as a lookup by its name, and believes an annotation over it', () => {
    expect(mcpActionKind({}, 'vx_list_activities')).toBeUndefined();
    expect(mcpActionKind({}, 'get_activity')).toBeUndefined();
    expect(mcpActionKind({}, 'vx_comment')).toBe('service');
    expect(mcpActionKind({}, 'vx_getaway_move')).toBe('service');
    expect(
      mcpActionKind({ metadata: { annotations: { readOnlyHint: false } } }, 'list_things'),
    ).toBe('service');
    expect(mcpActionKind({ metadata: { annotations: { readOnlyHint: true } } }, 'erase')).toBe(
      undefined,
    );
  });

  it('holds a level-2 call with a numbered request, and lets it run once approved', async () => {
    const { services, profile, session, run } = await fixture();
    const ran: unknown[] = [];
    const tools: ToolSet = {
      comment: tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async (args) => {
          ran.push(args);
          return 'commented';
        },
      }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => `work.${name}`),
      () => 'service',
    );

    const held = await call(tools.comment, { text: 'Aprovado' });
    expect(held).toMatchObject({ held: expect.stringContaining('request #1') });
    expect(ran).toEqual([]);

    const [request] = await services.approvals.list(profile.id);
    expect(request).toMatchObject({
      number: 1,
      status: 'pending',
      tool: 'comment',
      action: 'work.comment',
      input: { text: 'Aprovado' },
      runId: run.id,
      sessionId: session.id,
    });

    // Asking again for the same call points at the same request instead of opening another.
    expect(await call(tools.comment, { text: 'Aprovado' })).toMatchObject({
      held: expect.stringContaining('request #1'),
    });
    expect((await services.approvals.list(profile.id)).length).toBe(1);

    await services.approvals.decide(profile.id, { number: 1 }, true, 'panel');

    expect(await call(tools.comment, { text: 'Aprovado' })).toBe('commented');
    expect(ran).toEqual([{ text: 'Aprovado' }]);

    // Spent: the same call asks again, under a new number.
    expect(await call(tools.comment, { text: 'Aprovado' })).toMatchObject({
      held: expect.stringContaining('request #2'),
    });
    expect((await services.approvals.list(profile.id)).map((item) => item.status)).toEqual([
      'pending',
      'used',
    ]);
  });

  it('does not let an approval run a different call', async () => {
    const { services, profile, run } = await fixture();
    const ran: unknown[] = [];
    const tools: ToolSet = {
      comment: tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async (args) => {
          ran.push(args);
          return 'commented';
        },
      }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => name),
      () => 'service',
    );

    await call(tools.comment, { text: 'one' });
    await services.approvals.decide(profile.id, { number: 1 }, true, 'api');

    expect(await call(tools.comment, { text: 'two' })).toMatchObject({
      held: expect.stringContaining('request #2'),
    });
    expect(ran).toEqual([]);
  });

  it('records a rejection with its reason and keeps the call from running', async () => {
    const { services, profile, run } = await fixture();
    const tools: ToolSet = {
      comment: tool({
        inputSchema: z.object({ text: z.string() }),
        execute: async () => 'commented',
      }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => name),
      () => 'service',
    );

    await call(tools.comment, { text: 'wrong' });
    const decided = await services.approvals.decide(
      profile.id,
      { number: 1 },
      false,
      'channel',
      'texto errado',
    );

    expect(decided).toMatchObject({
      status: 'rejected',
      reason: 'texto errado',
      decidedVia: 'channel',
    });
    expect(await call(tools.comment, { text: 'wrong' })).toMatchObject({
      held: expect.stringContaining('request #2'),
    });
    await expect(
      services.approvals.decide(profile.id, { number: 1 }, true, 'panel'),
    ).rejects.toThrow('already rejected');
  });

  it('only proposes at level 1, and passes to the judge at level 3', async () => {
    const { services, profile, run } = await fixture({
      machine: 3,
      service: 2,
      message: 2,
      tools: { 'work.comment': 1 },
    });
    const ran: string[] = [];
    const tools: ToolSet = {
      comment: tool({ inputSchema: z.object({}), execute: async () => 'commented' }),
      run_command: tool({
        inputSchema: z.object({}),
        execute: async () => {
          ran.push('run_command');
          return 'ran';
        },
      }),
    };
    const judged: string[] = [];

    guardTools(
      tools,
      composeGuards(
        policyGuard(profile.actionPolicy, services.approvals, run, (name) =>
          name === 'comment' ? 'work.comment' : name,
        ),
        async (name) => {
          judged.push(name);
          return undefined;
        },
      ),
      (name) => (name === 'comment' ? 'service' : 'machine'),
    );

    expect(await call(tools.comment, {})).toMatchObject({
      held: expect.stringContaining('level 1'),
    });
    expect(await services.approvals.list(profile.id)).toEqual([]);

    expect(await call(tools.run_command, {})).toBe('ran');
    expect(judged).toEqual(['run_command']);
    expect(ran).toEqual(['run_command']);
  });
});

describe('the answer in a conversation', () => {
  it('decides from the owner and hands the agent the decision instead of the words', async () => {
    const { services, profile, session, run } = await fixture();
    const tools: ToolSet = {
      comment: tool({ inputSchema: z.object({}), execute: async () => 'commented' }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => name),
      () => 'service',
    );
    await call(tools.comment, {});
    // The agent ended its turn; the answer opens a new one instead of steering the old.
    await services.runs.cancel(profile.id, run.id);

    const next = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'ok 1', requestKey: 'answer' },
      { ownerMessage: true },
    );

    expect(next.input).toContain('[Request #1 approved by the owner]');
    expect((await services.approvals.list(profile.id))[0]?.status).toBe('approved');
  });

  it('leaves the words alone when they are not the owner’s, or name no request', async () => {
    const { services, profile, session, run } = await fixture();
    const tools: ToolSet = {
      comment: tool({ inputSchema: z.object({}), execute: async () => 'commented' }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => name),
      () => 'service',
    );
    await call(tools.comment, {});
    await services.runs.cancel(profile.id, run.id);

    const stranger = await services.runs.submit(profile.id, session.id, {
      text: 'ok 1',
      requestKey: 'stranger',
    });
    expect(stranger.input).toBe('ok 1');
    expect((await services.approvals.list(profile.id))[0]?.status).toBe('pending');
    await services.runs.cancel(profile.id, stranger.id);

    const unknown = await services.runs.submit(
      profile.id,
      session.id,
      { text: 'ok 9', requestKey: 'unknown' },
      { ownerMessage: true },
    );
    expect(unknown.input).toBe('ok 9');
  });

  it('answers the owner by id from the panel too', async () => {
    const { services, profile, run } = await fixture();
    const tools: ToolSet = {
      comment: tool({ inputSchema: z.object({}), execute: async () => 'commented' }),
    };

    guardTools(
      tools,
      policyGuard(profile.actionPolicy, services.approvals, run, (name) => name),
      () => 'service',
    );
    await call(tools.comment, {});
    const [request] = await services.approvals.list(profile.id);

    const decided = await services.approvals.approve(profile.id, request?.id ?? '', {}, 'panel');

    expect(decided).toMatchObject({ status: 'approved', decidedVia: 'panel' });
    expect(Approvals.notice(decided)).toContain('call comment again with the same input');
  });
});
