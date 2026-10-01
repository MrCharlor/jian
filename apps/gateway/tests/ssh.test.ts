import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('uses workspace SSH files even when Git SSH is explicitly selected', () => {
  const root = mkdtempSync(join(tmpdir(), 'jian-ssh-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    copyFileSync(fileURLToPath(new URL('../ssh.sh', import.meta.url)), join(bin, 'ssh'));
    chmodSync(join(bin, 'ssh'), 0o755);
    for (const name of ['first workspace', 'second']) {
      const home = join(root, name);
      mkdirSync(join(home, '.ssh'), { recursive: true });
      writeFileSync(join(home, '.ssh/custom'), 'synthetic');
      writeFileSync(join(home, '.ssh/config'), 'Host example.invalid\n  User workspace-user\n');
      const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
      const config = execFileSync(
        '/bin/sh',
        [
          '-c',
          'GIT_SSH_COMMAND=\'ssh -i .ssh/custom -o IdentitiesOnly=yes\'; eval "$GIT_SSH_COMMAND -G example.invalid"',
        ],
        { env, cwd: home, encoding: 'utf8' },
      );
      expect(config).toContain('user workspace-user\n');
      expect(config).toContain(`userknownhostsfile ${join(home, '.ssh/known_hosts')}\n`);
      expect(config).toContain(`identityfile ${join(home, '.ssh/id_ed25519')}\n`);
      expect(config).toContain('identityfile .ssh/custom\n');
      expect(config).toContain('identitiesonly yes\n');
      expect(config).toMatch(/stricthostkeychecking (ask|true|yes)\n/);
      rmSync(join(home, '.ssh/config'));
      const defaults = execFileSync('ssh', ['-G', 'example.invalid'], {
        env,
        encoding: 'utf8',
      });
      expect(defaults).toContain(`userknownhostsfile ${join(home, '.ssh/known_hosts')}\n`);
      expect(defaults).toContain(`identityfile ${join(home, '.ssh/id_ed25519')}\n`);
      expect(defaults).not.toContain('identityfile ~/.ssh/');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
