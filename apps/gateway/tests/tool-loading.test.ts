import { type Profile, profileSchema, type Run } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { deferTools, profileTools, TOOL_GROUPS } from '../src/agent/tools.js';

const base = profileSchema.parse({
  name: 'Miku',
  instructions: 'Answer briefly.',
  summary: 'Assistant',
  allowShell: true,
});

const profile: Profile = {
  ...base,
  id: '11111111-1111-4111-8111-111111111111',
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const run: Run = {
  id: '22222222-2222-4222-8222-222222222222',
  profileId: profile.id,
  sessionId: '33333333-3333-4333-8333-333333333333',
  requestKey: 'k',
  input: 'Oi',
  status: 'running',
  profile,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/** Nothing here reaches a service: only which tools are offered is under test. */
const services = new Proxy(
  {},
  { get: () => new Proxy({}, { get: () => async () => [] }) },
) as never;

describe('tool loading', () => {
  it('keeps memory, skills and other agents reachable without a round trip', () => {
    const tools = profileTools(services, run);
    const { gated } = deferTools(tools, new Set());

    for (const name of ['remember', 'read_memories', 'load_skill', 'list_agents', 'ask_agent']) {
      expect(gated.has(name)).toBe(false);
    }
  });

  it('holds back the machine and bookkeeping tools until they are asked for', () => {
    const tools = profileTools(services, run);
    const { gated } = deferTools(tools, new Set());

    for (const name of [
      ...TOOL_GROUPS.shell.tools,
      ...TOOL_GROUPS.files.tools,
      ...TOOL_GROUPS.activity.tools,
    ]) {
      expect(gated.has(name)).toBe(true);
    }
  });

  it('offers only groups this profile actually has', async () => {
    const tools = profileTools(services, { ...run, profile: { ...profile, allowShell: false } });

    deferTools(tools, new Set());

    expect(tools.load_tools?.description).not.toContain('shell:');
    expect(tools.load_tools?.description).toContain('contacts:');
  });

  it('adds a group to the run once it is loaded', async () => {
    const tools = profileTools(services, run);
    const loaded = new Set<string>();

    deferTools(tools, loaded);
    const load = tools.load_tools?.execute as (input: unknown, options: unknown) => Promise<void>;

    await load({ groups: ['shell'] }, { toolCallId: 'c', messages: [] });

    expect(loaded.has('run_command')).toBe(true);
    expect(loaded.has('read_file')).toBe(false);
  });
});
