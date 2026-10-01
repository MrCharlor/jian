import type { Skill } from '@jian/contracts';

export const sshKeys: Skill = {
  name: 'ssh-keys',
  description: 'Manage this profile’s SSH keys through Jian tools.',
  instructions: `# SSH keys

Use the SSH key tools whenever you need to inspect, create or remove a key for this profile.

- Use \`list_ssh_keys\` to see the public keys and fingerprints.
- Use \`create_ssh_key\` to create an Ed25519 key.
- Use \`delete_ssh_key\` only after identifying the exact key id.
- Never run \`ssh-keygen\`, write private key files, or manage SSH keys through \`run_command\`.
- Never print or request a private key. The gateway keeps it in this profile’s workspace.
`,
};
