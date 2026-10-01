import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { workspaceOf } from '../src/agent/workspace.js';
import { testServices } from './helpers/services.js';

const root = realpathSync(mkdtempSync(join('/tmp', 'jian-ssh-')));
const previous = process.env.JIAN_WORKSPACES;
process.env.JIAN_WORKSPACES = root;

afterAll(() => {
  if (previous === undefined) delete process.env.JIAN_WORKSPACES;
  else process.env.JIAN_WORKSPACES = previous;
  rmSync(root, { recursive: true, force: true });
});

it('creates, lists and removes a profile SSH key without returning the private key', async () => {
  const services = await testServices();
  const profile = await services.profiles.createProfile({ name: 'Atlas', instructions: 'Help.' });

  const created = await services.sshKeys.create(profile.id, { name: 'GitHub' });
  expect(created.name).toBe('GitHub');
  expect(created.publicKey).toMatch(/^ssh-ed25519 /);
  expect(created.fingerprint).toMatch(/^SHA256\//);
  expect(JSON.stringify(created)).not.toContain('PRIVATE KEY');

  const home = await workspaceOf(profile.id);
  const privateKey = join(home, '.ssh', 'jian', created.id, 'id_ed25519');
  expect(existsSync(privateKey)).toBe(true);
  expect(readFileSync(privateKey, 'utf8')).toContain('PRIVATE KEY');
  expect(await services.sshKeys.list(profile.id)).toEqual([created]);

  await expect(services.sshKeys.remove(profile.id, created.id)).resolves.toEqual({
    id: created.id,
  });
  expect(existsSync(join(home, '.ssh', 'jian', created.id))).toBe(false);
  await expect(services.sshKeys.remove(profile.id, created.id)).rejects.toMatchObject({
    statusCode: 404,
  });
});
