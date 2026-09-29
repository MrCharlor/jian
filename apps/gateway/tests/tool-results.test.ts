import { expect, it } from 'vitest';
import { boundToolResult } from '../src/agent/results.js';
import { profileTools } from '../src/agent/tools.js';
import { tokenCounter } from '../src/context/budget.js';
import { Coordination } from '../src/coordination/service.js';
import { testServices } from './helpers/services.js';

async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Reader',
    instructions: 'Help.',
    contextPolicy: { toolResultTokens: 2560 },
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Results' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Read',
    requestKey: 'read',
  });
  return { services, profile, run };
}

it('keeps structured MCP data readable without encoding JSON inside JSON', async () => {
  const { run } = await fixture();
  const data = { items: [{ id: 'receipt-123', title: 'Entrega', state: 'OPEN' }] };
  const result = await boundToolResult(
    {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: true,
    },
    'mcp__test_search',
    run,
    new Set(),
    {},
  );
  expect(result).toEqual({ data, isError: true });
});

it('reads full pages within the token limit without skipping Unicode or JSON escapes', async () => {
  const { services, run } = await fixture();
  const coordination = new Coordination(services);
  const original = { value: 'Entrega São Paulo "pronto"\n'.repeat(160) };
  const artifact = await coordination.storeArtifact(run, 'read', original);
  const read = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<{ content: string; nextOffset: number | null }>;
  let offset: number | null = 0;
  let content = '';
  const count = tokenCounter(run.profile.model.provider, run.profile.model.modelId);
  let pages = 0;
  while (offset !== null) {
    const page = await read(
      { artifactId: artifact.artifactId, offset, limit: 4000 },
      { messages: [], toolCallId: 'read' },
    );
    expect(count(JSON.stringify(page))).toBeLessThanOrEqual(2560);
    if (pages === 0) expect(page.content.length).toBeGreaterThan(1200);
    content += page.content;
    offset = page.nextOffset;
    expect(++pages).toBeLessThan(10);
  }
  expect(JSON.parse(content)).toEqual(original);
});

it('keeps full local output in an artifact and shows both ends in Caveman mode', async () => {
  const { run } = await fixture();
  const stdout = `START\n${'ordinary output\n'.repeat(1200)}END`;
  const saved: unknown[] = [];
  const output = { exitCode: 0, stdout, stderr: '' };
  const result = await boundToolResult(
    output,
    'run_command',
    run,
    new Set(),
    {
      storeArtifact: async (_run, _name, value) => {
        saved.push(value);
        return { artifactId: 'saved-output', bytes: Buffer.byteLength(JSON.stringify(value)) };
      },
    },
    true,
  );
  expect(saved).toEqual([output]);
  expect(result).toMatchObject({ truncated: true, artifactId: 'saved-output' });
  const preview = (result as { preview: string }).preview;
  expect(preview).toContain('START');
  expect(preview).toContain('END');
  expect(preview).toContain('read artifact for full output');
  expect(tokenCounter('openai', 'test')(JSON.stringify(result))).toBeLessThanOrEqual(2560);
});

it('prioritizes shell failure details and leaves MCP errors unchanged', async () => {
  const { run } = await fixture();
  const failure = {
    exitCode: 2,
    stdout: 'ordinary output\n'.repeat(1200),
    stderr: 'VALIDATION FAILED: missing field',
  };
  const options = {
    storeArtifact: async () => ({ artifactId: 'failure-output', bytes: 30000 }),
  };
  const result = await boundToolResult(failure, 'run_command', run, new Set(), options, true);
  expect((result as { preview: string }).preview).toContain('VALIDATION FAILED: missing field');
  expect((result as { preview: string }).preview).toContain('"exitCode":2');

  const mcp = { content: [{ type: 'text', text: 'Remote operation refused' }], isError: true };
  expect(await boundToolResult(mcp, 'mcp__remote_write', run, new Set(), options, true)).toEqual(
    mcp,
  );
});

it('keeps file location and both ends of a long read in its preview', async () => {
  const { run } = await fixture();
  const output = {
    path: '/workspace/report.txt',
    totalLines: 1202,
    content: `1\tFIRST\n${'middle\n'.repeat(1200)}1202\tLAST`,
  };
  const result = await boundToolResult(
    output,
    'read_file',
    run,
    new Set(),
    { storeArtifact: async () => ({ artifactId: 'file-output', bytes: 10000 }) },
    true,
  );
  const preview = (result as { preview: string }).preview;
  expect(preview).toContain('/workspace/report.txt');
  expect(preview).toContain('1202');
  expect(preview).toContain('FIRST');
  expect(preview).toContain('LAST');
});
