import { Applications } from './applications/service.js';
import { Approvals } from './approvals/service.js';
import { Contexts } from './context/service.js';
import type { Clock } from './core/clock.js';
import { Decisions } from './decisions/service.js';
import { boardRooms, Drawings } from './drawings/service.js';
import { Epics } from './epics/service.js';
import { SIGMA_EPICS, SIGMA_VALIDATION } from './epics/target.js';
import { Errands } from './errands/service.js';
import { Flow } from './flow/service.js';
import { Learning } from './learning/service.js';
import { Media } from './media/service.js';
import { Memories } from './memories/service.js';
import { Pautas } from './pautas/service.js';
import { Peers } from './peers/service.js';
import { Priorities } from './priorities/service.js';
import { workBoardOpener, workClientOpener } from './priorities/work-board.js';
import { Profiles } from './profiles/service.js';
import { Prototypes } from './prototypes/service.js';
import type { ModelCatalog } from './providers/catalog-source.js';
import { Providers } from './providers/service.js';
import { SubscriptionUsageReader } from './providers/subscription-usage.js';
import { Quality } from './quality/service.js';
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
import { Validations } from './validations/service.js';
import { WebSearch } from './web/service.js';

export type Services = {
  profiles: Profiles;
  approvals: Approvals;
  applications: Applications;
  prototypes: Prototypes;
  pautas: Pautas;
  priorities: Priorities;
  flow: Flow;
  drawings: Drawings;
  epics: Epics;
  validations: Validations;
  quality: Quality;
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
  drawBoard,
}: {
  /** The drawing board beside the gateway: its public address, and where the gateway reaches it. */
  drawBoard?: { publicUrl: string; internalUrl: string; token: string };
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
  const quality = new Quality(store, profiles, clock);
  const approvals = new Approvals(store, profiles, clock, quality);
  const runs = new Runs(store, profiles, sessions, providers, clock, approvals, quality);
  approvals.useRuns(runs);
  const applications = new Applications(store, clock);
  const prototypes = new Prototypes(store, applications, quality);
  prototypes.useNotifier((profileId, sessionId, text, requestKey) =>
    runs.submit(profileId, sessionId, { text, requestKey }),
  );
  const pautas = new Pautas(store, clock);
  pautas.useAgents({
    remember: (profileId, key, content) =>
      memories.remember(profileId, { key, content, expectedVersion: 0 }),
    notify: (profileId, sessionId, text, requestKey) =>
      runs.submit(profileId, sessionId, { text, requestKey }),
  });
  runs.useDecisions(pautas);
  const workClients = workClientOpener(profiles, vault, fetcher ?? createSafeFetch().fetch);
  const priorities = new Priorities(store, workBoardOpener(workClients), quality, clock);
  const epics = new Epics(
    store,
    workClients,
    async () =>
      (await profiles.profiles()).find((profile) =>
        profile.mcpServers.some((server) => server.url?.includes('/v1/mcp')),
      )?.id,
    SIGMA_EPICS,
    fetcher ?? createSafeFetch().fetch,
    quality,
    clock,
  );
  const workProfile = async () =>
    (await profiles.profiles()).find((profile) =>
      profile.mcpServers.some((server) => server.url?.includes('/v1/mcp')),
    )?.id;
  const validations = new Validations(
    store,
    workClients,
    workProfile,
    SIGMA_VALIDATION,
    quality,
    clock,
  );
  validations.useOwner(async (text) => {
    const profileId = await workProfile();
    if (!profileId) return;
    const owner = (await sessions.sessions(profileId)).find(
      (session) => session.channel === 'gateway',
    );
    if (owner)
      await runs.submit(profileId, owner.id, { text, requestKey: `validation:${Date.now()}` });
  });
  runs.useValidations(validations);
  epics.useAgents({
    remember: (profileId, key, content) =>
      memories.remember(profileId, { key, content, expectedVersion: 0 }),
  });
  priorities.useAgents({
    remember: (profileId, key, content) =>
      memories.remember(profileId, { key, content, expectedVersion: 0 }),
    notify: (profileId, sessionId, text, requestKey) =>
      runs.submit(profileId, sessionId, { text, requestKey }),
  });
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
    applications,
    prototypes,
    pautas,
    priorities,
    flow: new Flow(workClients, clock),
    epics,
    validations,
    drawings: new Drawings(
      store,
      drawBoard
        ? {
            publicUrl: drawBoard.publicUrl,
            rooms: boardRooms(drawBoard.internalUrl, drawBoard.token, clock),
          }
        : undefined,
      clock,
    ),
    quality,
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
