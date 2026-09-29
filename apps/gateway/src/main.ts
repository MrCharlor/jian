import { timeZoneSchema } from '@jian/contracts';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { McpLogins } from './agent/mcp-login.js';
import { AgentRuntime } from './agent/runtime.js';
import { createApp } from './app.js';
import { ApiChannel } from './channels/api.js';
import { ChannelRegistry } from './channels/registry.js';
import { Channels } from './channels/service.js';
import { TelegramChannel } from './channels/telegram.js';
import { WhatsAppChannel } from './channels/whatsapp/adapter.js';
import { WhatsAppConnections } from './channels/whatsapp/connections.js';
import { createWhatsAppDeviceFactory } from './channels/whatsapp/driver.js';
import { Coordination } from './coordination/service.js';
import { ModelCatalog } from './providers/catalog-source.js';
import { CodexLogin } from './providers/codex/login.js';
import { ProviderModels } from './providers/discovery.js';
import { ModelFallback } from './providers/fallback.js';
import { RunQueue } from './runs/queue.js';
import { SecretBox } from './security/crypto.js';
import { GatewayVault } from './security/gateway-vault.js';
import { createSafeFetch } from './security/outbound.js';
import { Vault } from './security/vault.js';
import { buildServices } from './services.js';
import { Skills } from './skills/service.js';
import { type StartupStage, startupFailure } from './startup.js';
import { PostgresStore } from './storage/postgres.js';

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    JIAN_ACTIVE_KEY_ID: z.string().min(1),
    JIAN_MASTER_KEYS: z.string().min(1),
    JIAN_ALLOW_PRIVATE_ORIGINS: z.string().default(''),
    JIAN_API_TOKEN: z.string().min(32),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4310),
    JIAN_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    JIAN_TIME_ZONE: z.union([timeZoneSchema, z.literal('')]).optional(),
    // Where a browser reaches this gateway. An MCP authorization server redirects the owner
    // back to it, so it has to be the public address rather than the listening one.
    JIAN_PUBLIC_URL: z.url().optional(),
  })
  .safeParse(process.env);

if (!config.success) {
  console.error(
    'Jian configuration is incomplete:',
    config.error.issues.map((i) => i.path.join('.')).join(', '),
  );

  process.exit(1);
}

const store = new PostgresStore(config.data.DATABASE_URL);
let box: SecretBox;

try {
  const keys = z
    .record(z.string(), z.string().regex(/^[A-Za-z0-9+/]{43}=$/))
    .parse(JSON.parse(config.data.JIAN_MASTER_KEYS));

  box = new SecretBox({
    activeKeyId: config.data.JIAN_ACTIVE_KEY_ID,
    keys: Object.fromEntries(
      Object.entries(keys).map(([id, key]) => [id, Buffer.from(key, 'base64')]),
    ),
  });
} catch {
  console.error('Invalid encryption keyring. Configure JIAN_MASTER_KEYS and JIAN_ACTIVE_KEY_ID.');
  process.exit(1);
}

const outbound = createSafeFetch({
  allowPrivateOrigins: config.data.JIAN_ALLOW_PRIVATE_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
});

// What each model can do is read from a catalog maintained outside this repository, so a model
// released today works today. It goes out through the same guarded client as every other
// provider call. Media routing loads it before deciding whether native vision is available.
const catalog = new ModelCatalog(outbound.fetch);

const vault = new Vault(store, box);
// Vendor credentials belong to the installation; everything else a profile types is its own.
const gatewayVault = new GatewayVault(store, box);
// The store rides along: several consumers read records no single area owns.
const services = {
  ...buildServices({
    store,
    vault,
    gatewayVault,
    catalog,
    fetcher: outbound.fetch,
    ...(config.data.JIAN_TIME_ZONE ? { timeZone: config.data.JIAN_TIME_ZONE } : {}),
  }),
  store,
};
const codexLogin = new CodexLogin(services, gatewayVault);
services.media.useCodexLogin(codexLogin);
services.subscriptionUsage.useCodexLogin(codexLogin);

const providerModels = new ProviderModels(
  { providers: services.providers, vault: gatewayVault },
  outbound.fetch,
  { catalog, codexLogin },
);

// A profile answers as soon as a provider exists: with no model chosen, one is taken from what
// the provider reports and written as the profile's default.
services.runs.useFallback(new ModelFallback(services.providers, providerModels, catalog));

// Skill import reaches GitHub through the same guarded client, and only for the owner.
const skills = new Skills(services.profiles, outbound.fetch);

// An MCP server that wants OAuth sends the owner's browser back here, so a gateway with no
// public address configured cannot offer that sign-in at all.
const mcpLogins = config.data.JIAN_PUBLIC_URL
  ? new McpLogins(vault, config.data.JIAN_PUBLIC_URL, outbound.fetch)
  : undefined;

const coordination = new Coordination(services);
const whatsapp = new WhatsAppConnections(store, box, createWhatsAppDeviceFactory());
const channelRegistry = new ChannelRegistry([
  new ApiChannel(),
  new TelegramChannel(),
  new WhatsAppChannel(whatsapp),
]);
const channels = new Channels(services, outbound.fetch, channelRegistry);

channels.usePublicUrl(config.data.JIAN_PUBLIC_URL);

// A colleague's late answer has no incoming message to hang a delivery on; channels give it one.
services.peers.useDeliveries(channels);
// Nor has a run a schedule starts in a chat: its answer goes out the same way.
services.schedules.useDeliveries(channels);

/**
 * How often due schedules are looked for, in milliseconds. A schedule set for 08:00 starts
 * within this much of it; every worker looks, and a schedule starts once however many do.
 */
const SCHEDULE_TICK_MS = 15_000;
let scheduleTimer: ReturnType<typeof setInterval> | undefined;

// Deleting a profile disconnects its channels first, inside the same transaction: a WhatsApp
// socket a worker still holds open has to be told, not just left to find out from a missing row.
services.profiles.useBeforeDelete((profileId, tx) => channels.revokeAll(profileId, tx));

const runtime = new AgentRuntime(services, undefined, {
  vault,
  gatewayVault,
  ...(mcpLogins ? { mcpOAuth: mcpLogins.provider } : {}),
  codexLogin,
  outbound,
  storeArtifact: (run, toolName, output) => coordination.storeArtifact(run, toolName, output),
});

const queue =
  config.data.JIAN_ROLE !== 'api'
    ? new RunQueue(new PgBoss(config.data.DATABASE_URL), services, runtime)
    : undefined;

const app =
  config.data.JIAN_ROLE !== 'worker'
    ? createApp({
        ...services,
        codexLogin,
        providerModels,
        skills,
        channels,
        whatsapp,
        ...(mcpLogins ? { mcpLogins } : {}),
        fetcher: outbound.fetch,
        token: config.data.JIAN_API_TOKEN,
        onCancel: (id) => runtime.cancel(id),
      })
    : undefined;

let stopping = false;

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;
  codexLogin.stop();
  clearInterval(scheduleTimer);
  // End long-lived event streams before waiting for HTTP shutdown.
  app?.server.closeAllConnections();
  await app?.close();
  await queue?.stop();
  await channels.stop();
  await whatsapp.stop();
  await outbound.close();
  await store.close();
}

process.once('SIGINT', () => {
  void shutdown();
});

process.once('SIGTERM', () => {
  void shutdown();
});

let startupStage: StartupStage = 'database';

try {
  await store.migrate();
  startupStage = 'queue';
  await queue?.start();

  if (config.data.JIAN_ROLE !== 'api') {
    whatsapp.start((id, input, generation) => channels.receiveLinked(id, input, generation));
    channels.start();
    scheduleTimer = setInterval(() => {
      void services.schedules
        .fireDue()
        .catch(() => console.error('jian: schedules could not be started; will retry'));
    }, SCHEDULE_TICK_MS);
    scheduleTimer.unref();
  }

  if (app) {
    startupStage = 'http';
    await app.listen({ host: config.data.HOST, port: config.data.PORT });
  } else {
    console.info('Jian worker started');
  }
} catch (error) {
  console.error(startupFailure(startupStage, error));
  await shutdown().catch(() => {});
  process.exitCode = 1;
}
