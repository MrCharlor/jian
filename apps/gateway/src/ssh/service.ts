import { createHash, generateKeyPairSync, type KeyObject, randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshKey, SshKeyCreate } from '@jian/contracts';
import { workspaceOf } from '../agent/workspace.js';
import { assertFound } from '../core/errors.js';
import type { Profiles } from '../profiles/service.js';

const directory = (home: string) => join(home, '.ssh', 'jian');
const metadata = (home: string, id: string) => join(directory(home), id, 'metadata.json');
const publicFile = (home: string, id: string) => join(directory(home), id, 'id_ed25519.pub');

const uint32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

function publicKey(key: KeyObject, name: string) {
  const raw = key.export({ type: 'spki', format: 'der' }).subarray(-32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([uint32(type.length), type, uint32(raw.length), raw]);
  const value = `ssh-ed25519 ${blob.toString('base64')} jian-${name.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const fingerprint = `SHA256/${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { value, fingerprint };
}

export class SshKeys {
  constructor(private readonly profiles: Profiles) {}

  private async home(profileId: string) {
    await this.profiles.profile(profileId);
    const home = await workspaceOf(profileId);
    await mkdir(directory(home), { recursive: true, mode: 0o700 });
    await chmod(directory(home), 0o700);
    return home;
  }

  async list(profileId: string): Promise<SshKey[]> {
    const home = await this.home(profileId);
    const entries = await readdir(directory(home), { withFileTypes: true });
    const keys: SshKey[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const item = JSON.parse(await readFile(metadata(home, entry.name), 'utf8')) as SshKey;
        const publicValue = await readFile(publicFile(home, entry.name), 'utf8');
        keys.push({ ...item, publicKey: publicValue.trim() });
      } catch {
        // Ignore incomplete entries left by an interrupted generation.
      }
    }
    return keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async create(profileId: string, input: SshKeyCreate): Promise<SshKey> {
    const home = await this.home(profileId);
    const id = randomUUID();
    const target = join(directory(home), id);
    await mkdir(target, { mode: 0o700 });
    try {
      const pair = generateKeyPairSync('ed25519') as {
        publicKey: KeyObject;
        privateKey: KeyObject;
      };
      const createdAt = new Date().toISOString();
      const key = publicKey(pair.publicKey, input.name);
      const result: SshKey = {
        id,
        name: input.name,
        publicKey: key.value,
        fingerprint: key.fingerprint,
        createdAt,
      };
      await writeFile(
        join(target, 'id_ed25519'),
        pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
        { mode: 0o600 },
      );
      await writeFile(join(target, 'id_ed25519.pub'), `${key.value}\n`, { mode: 0o644 });
      await writeFile(join(target, 'metadata.json'), JSON.stringify(result), { mode: 0o600 });
      return result;
    } catch (error) {
      await rm(target, { recursive: true, force: true });
      throw error;
    }
  }

  async remove(profileId: string, id: string): Promise<{ id: string }> {
    const home = await this.home(profileId);
    await assertFound(
      (await this.list(profileId)).find((key) => key.id === id),
      'SSH key',
    );
    await rm(join(directory(home), id), { recursive: true, force: true });
    return { id };
  }
}
