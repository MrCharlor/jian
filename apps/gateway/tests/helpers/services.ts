import { randomBytes } from 'node:crypto';
import type { ModelCatalog } from '../../src/providers/catalog-source.js';
import { SecretBox } from '../../src/security/crypto.js';
import { GatewayVault } from '../../src/security/gateway-vault.js';
import { Vault } from '../../src/security/vault.js';
import { buildServices, type Services } from '../../src/services.js';
import { TestStore } from './database.js';

/** A synthetic keyring per call: tests exercise the real encryption path, never a stub. */
export async function testServices(
  clock?: () => number,
  catalog?: ModelCatalog,
  timeZone?: string,
): Promise<Services & { store: TestStore }> {
  const store = await TestStore.create();
  const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });

  return {
    ...buildServices({
      store,
      vault: new Vault(store, box, clock),
      gatewayVault: new GatewayVault(store, box, clock),
      clock,
      catalog,
      ...(timeZone ? { timeZone } : {}),
    }),
    store,
  };
}
