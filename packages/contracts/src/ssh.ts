import { z } from 'zod';

export const sshKeyCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
});

export const sshKeySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  publicKey: z.string(),
  fingerprint: z.string(),
  createdAt: z.iso.datetime(),
});

export type SshKey = z.infer<typeof sshKeySchema>;
export type SshKeyCreate = z.infer<typeof sshKeyCreateSchema>;
