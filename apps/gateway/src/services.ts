import { Approvals } from './approvals/service.js';
import { Contexts } from './context/service.js';
import type { Clock } from './core/clock.js';
import { Decisions } from './decisions/service.js';
import { Errands } from './errands/service.js';
import { Learning } from './learning/service.js';
import { Media } from './media/service.js';
import { Memories } from './memories/service.js';
import { Peers } from './peers/service.js';
import { Profiles } from './profiles/service.js';
import type { ModelCatalog } from './providers/catalog-source.js';
import { Providers } from './providers/service.js';
import { SubscriptionUsageReader } from './providers/subscription-usage.js';
import { RepositoryStars } from './releases/repository.js';
import { ReleaseNotes } from './releases/service.js';
import { RunLifecycle } from './runs/lifecycle.js';
import { Runs } from './runs/service.js';
import { Schedules } from './schedules/service.js';
import type { GatewayVault } from './security/gateway-vault.js';
import { createSafeFetch } from './security/outbound.js';
import type { Vault } from './security/vault.js';
import { Sessions } from './sessions/service.js';
import { Settings } from './settings/service.js';
import { SshKeys } from './ssh/service.js';
import { Stats } from './stats/service.js';
import { Stickers } from './stickers/service.js';
import type { Store } from './storage/database.js';
import { Work } from './tasks/service.js';
import { WebSearch } from './web/service.js';

export type Services = {
  profiles: Profiles;
  approvals: Approvals;
  providers: Providers;
  sessions: Sessions;
  memories: Memories;
  media: Media;
  web: WebSearch;
  releases: ReleaseNotes;
  repository: RepositoryStars;
  decisions: Decisions;
  runs: Runs;
  peers: Peers;
  learning: Learning;
  stickers: Stickers;
  stats: Stats;
  subscriptionUsage: SubscriptionUsageReader;
  schedules: Schedules;
  settings: Settings;
  lifecycle: RunLifecycle;
  contexts: Contexts;
  errands: Errands;
  work: Work;
  vault: Vault;
  gatewayVault: GatewayVault;
  sshKeys: SshKeys;
};

/** One wiring point: every area gets the same store, vault and clock. */
export function buildServices({
  store,
  vault,
  gatewayVault,
  clock = Date.now,
  catalog,
  fetcher,
  timeZone,
}: {
  store: Store;
  vault: Vault;
  gatewayVault: GatewayVault;
  clock?: Clock;
  catalog?: ModelCatalog;
  fetcher?: typeof fetch;
  timeZone?: string;
}): Services {
  const profiles = new Profiles(store, vault, clock);
  const providers = new Providers(store, profiles, gatewayVault, clock, catalog);
  const sessions = new Sessions(store, profiles, clock);
  const memories = new Memories(store, profiles, sessions, clock);
  const approvals = new Approvals(store, profiles, clock);
  const runs = new Runs(store, profiles, sessions, providers, clock, approvals);
  const settings = new Settings(store, timeZone);
  const decisions = new Decisions(
    store,
    gatewayVault,
    fetcher ?? createSafeFetch().fetch,
    undefined,
    clock,
  );
  const media = new Media(store, providers, gatewayVault, fetcher ?? createSafeFetch().fetch);
  const subscriptionUsage = new SubscriptionUsageReader(
    providers,
    gatewayVault,
    fetcher ?? createSafeFetch().fetch,
    clock,
  );

  const services = {
    profiles,
    approvals,
    providers,
    sessions,
    memories,
    media,
    web: new WebSearch(store, gatewayVault, fetcher ?? createSafeFetch().fetch),
    // Stamped into the image at build time; a gateway run from source has none.
    releases: new ReleaseNotes(
      store,
      process.env.JIAN_VERSION,
      undefined,
      fetcher ?? createSafeFetch().fetch,
    ),
    repository: new RepositoryStars(fetcher ?? createSafeFetch().fetch),
    decisions,
    runs,
    peers: new Peers({ profiles, sessions, runs, store }, clock),
    learning: new Learning({ store, profiles, sessions, runs, judge: decisions.judge }, clock),
    stickers: new Stickers(store, media, providers),
    // Without a catalog nothing has a list price, and every model counts as unknown.
    stats: new Stats(
      store,
      profiles,
      settings,
      catalog ?? { prime: async () => {}, lookup: () => undefined },
      clock,
      subscriptionUsage,
    ),
    subscriptionUsage,
    schedules: new Schedules(store, profiles, sessions, runs, clock),
    settings,
    lifecycle: new RunLifecycle(store, runs, clock),
    contexts: new Contexts(store, runs, sessions, settings, decisions.judge),
    errands: new Errands(store, clock),
    work: new Work(store, profiles, sessions, runs, clock),
    vault,
    gatewayVault,
    sshKeys: new SshKeys(profiles),
  };

  return services;
}
