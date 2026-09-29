import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Run } from '@jian/contracts';
import { afterAll, expect, it } from 'vitest';
import { fileTools } from '../src/agent/files.js';
import { shellTools } from '../src/agent/shell.js';
import { prepareWorkerWorkspace, removeWorkerWorkspace } from '../src/agent/worker-workspace.js';
import { sandboxAbi, workspaceOf } from '../src/agent/workspace.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'jian-worker-')));
const previous = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;
const profileId = '11111111-1111-4111-8111-111111111111';
const git = (cwd: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const worker = (id: string, repositories: string[], owner = profileId) =>
  ({ id, profileId: owner, subagent: { repositories } }) as Run;
const call = (tool: unknown, input: unknown) =>
  (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });

afterAll(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  rmSync(root, { recursive: true, force: true });
});

it('gives two workers separate committed trees and preserves a worker tree on retry', async () => {
  const home = await workspaceOf(profileId);
  const source = join(home, 'project');
  mkdirSync(source);
  git(source, 'init', '-q');
  writeFileSync(join(source, 'file.txt'), 'committed');
  git(source, 'add', 'file.txt');
  git(
    source,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'start',
  );

  const firstId = '22222222-2222-4222-8222-222222222222';
  const secondId = '33333333-3333-4333-8333-333333333333';
  const first = worker(firstId, [source]);
  const second = worker(secondId, [source]);
  const gitAccess = await prepareWorkerWorkspace(first);
  expect(gitAccess.readOnly).toHaveLength(1);
  expect(gitAccess.writable).toHaveLength(2);
  await prepareWorkerWorkspace(second);
  const firstTree = join(await workspaceOf(profileId, firstId), 'repos/1/project');
  const secondTree = join(await workspaceOf(profileId, secondId), 'repos/1/project');
  expect(readFileSync(join(firstTree, 'file.txt'), 'utf8')).toBe('committed');
  expect(readFileSync(join(secondTree, 'file.txt'), 'utf8')).toBe('committed');

  const firstTools = fileTools(profileId, firstId);
  await call(firstTools.read_file, { path: join(firstTree, 'file.txt'), offset: 1, limit: 10 });
  await call(firstTools.write_file, { path: join(firstTree, 'file.txt'), content: 'worker edit' });
  expect(readFileSync(join(secondTree, 'file.txt'), 'utf8')).toBe('committed');
  expect(readFileSync(join(source, 'file.txt'), 'utf8')).toBe('committed');
  await expect(
    call(firstTools.write_file, { path: join(secondTree, 'file.txt'), content: 'escape' }),
  ).rejects.toThrow('belongs to another task worker');
  await expect(
    call(firstTools.write_file, { path: join(source, 'file.txt'), content: 'escape' }),
  ).rejects.toThrow('outside your workspace');
  await prepareWorkerWorkspace(first);
  expect(readFileSync(join(firstTree, 'file.txt'), 'utf8')).toBe('worker edit');

  const shell = shellTools(profileId, firstId, gitAccess).run_command;
  expect(await call(shell, { command: 'pwd', timeoutMs: 10_000 })).toMatchObject({
    exitCode: 0,
    stdout: `${await workspaceOf(profileId, firstId)}\n`,
  });
  expect(
    await call(shell, { command: `git -C '${firstTree}' status --porcelain`, timeoutMs: 10_000 }),
  ).toMatchObject({ exitCode: 0, stdout: ' M file.txt\n' });
  expect(
    await call(shell, {
      command: `git -C '${firstTree}' add file.txt && git -C '${firstTree}' -c user.name=Test -c user.email=test@example.invalid commit -qm worker`,
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ exitCode: 0 });
  expect(git(source, 'log', '-1', '--format=%s')).toBe('start');
  expect(git(firstTree, 'log', '-1', '--format=%s')).toBe('worker');
  if ((await sandboxAbi()) > 0) {
    expect(
      await call(shell, {
        command: `git -C '${firstTree}' config --local worker.escape true`,
        timeoutMs: 10_000,
      }),
    ).not.toMatchObject({ exitCode: 0 });
    expect(
      await call(shell, { command: `cat '${join(source, 'file.txt')}'`, timeoutMs: 10_000 }),
    ).not.toMatchObject({ exitCode: 0 });
    expect(
      await call(shell, {
        command: `echo escape > '${join(secondTree, 'planted.txt')}'`,
        timeoutMs: 10_000,
      }),
    ).not.toMatchObject({ exitCode: 0 });
  }

  writeFileSync(join(source, 'dirty.txt'), 'uncommitted');
  await expect(
    prepareWorkerWorkspace(worker('44444444-4444-4444-8444-444444444444', [source])),
  ).rejects.toThrow('uncommitted changes');
  rmSync(join(source, 'dirty.txt'));
  await expect(
    prepareWorkerWorkspace(worker('55555555-5555-4555-8555-555555555555', [root])),
  ).rejects.toThrow('inside this agent');

  const linked = join(home, 'linked');
  symlinkSync(root, linked);
  await expect(
    prepareWorkerWorkspace(worker('66666666-6666-4666-8666-666666666666', [linked])),
  ).rejects.toThrow('inside this agent');

  const linkedTargetId = '77777777-7777-4777-8777-777777777777';
  const linkedTargetHome = await workspaceOf(profileId, linkedTargetId);
  mkdirSync(join(linkedTargetHome, 'repos/1'), { recursive: true });
  symlinkSync(source, join(linkedTargetHome, 'repos/1/project'));
  await expect(prepareWorkerWorkspace(worker(linkedTargetId, [source]))).rejects.toThrow(
    'not its expected worktree',
  );

  writeFileSync(join(firstTree, 'uncommitted.txt'), 'worker scratch');
  await removeWorkerWorkspace(profileId, firstId, [source]);
  expect(existsSync(firstTree)).toBe(false);
  expect(existsSync(secondTree)).toBe(true);
  expect(git(source, 'worktree', 'list', '--porcelain')).not.toContain(firstTree);
  await removeWorkerWorkspace(profileId, firstId, [source]);
  await removeWorkerWorkspace(profileId, secondId, [source]);
  expect(existsSync(secondTree)).toBe(false);
});

it('lets Git SSH use the profile key read-only without copying it into the worker home', async () => {
  const owner = '88888888-8888-4888-8888-888888888888';
  const home = await workspaceOf(owner);
  const ssh = join(home, '.ssh');
  mkdirSync(ssh, { mode: 0o700 });
  writeFileSync(join(ssh, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n');
  writeFileSync(join(ssh, 'config'), 'Host bitbucket.org\n  User git\n');
  writeFileSync(join(ssh, 'known_hosts'), 'bitbucket.org synthetic-host-key\n');
  const runId = '99999999-9999-4999-8999-999999999999';
  const access = await prepareWorkerWorkspace(worker(runId, [], owner));
  const workerHome = await workspaceOf(owner, runId);
  expect(access.readOnly).toContain(ssh);
  expect(existsSync(join(workerHome, '.ssh/id_ed25519'))).toBe(false);
  expect(readFileSync(join(workerHome, '.ssh/known_hosts'), 'utf8')).toContain('bitbucket.org');
  const shell = shellTools(owner, runId, access).run_command;
  const config = (await call(shell, {
    command: 'eval "$GIT_SSH_COMMAND -G bitbucket.org"',
    timeoutMs: 10_000,
  })) as { exitCode: number; stdout: string };
  expect(config.exitCode).toBe(0);
  expect(config.stdout).toContain(`identityfile ${join(ssh, 'id_ed25519')}`);
  expect(config.stdout).toContain('user git');
  expect(
    await call(shell, {
      command: 'git ls-remote --get-url https://bitbucket.org/vxcaselabs/vx-erp.git',
      timeoutMs: 10_000,
    }),
  ).toMatchObject({ exitCode: 0, stdout: 'git@bitbucket.org:vxcaselabs/vx-erp.git\n' });
  if ((await sandboxAbi()) > 0) {
    expect(
      await call(shell, {
        command: `printf corrupted > '${join(ssh, 'id_ed25519')}'`,
        timeoutMs: 10_000,
      }),
    ).not.toMatchObject({ exitCode: 0 });
  }
  expect(readFileSync(join(ssh, 'id_ed25519'), 'utf8')).toContain('synthetic');
  await removeWorkerWorkspace(owner, runId, []);
  expect(existsSync(workerHome)).toBe(false);
  expect(existsSync(join(ssh, 'id_ed25519'))).toBe(true);
});
