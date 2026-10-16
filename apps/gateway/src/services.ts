import { Applications } from './applications/service.js';
import { Approvals } from './approvals/service.js';
import { Contexts } from './context/service.js';
import { type Clock, nowIso } from './core/clock.js';
import { Decisions } from './decisions/service.js';
import { boardRooms, Drawings } from './drawings/service.js';
import { EntrySync } from './entry/service.js';
import { Epics } from './epics/service.js';
import {
  SIGMA_ENTRY,
  SIGMA_EPICS,
  SIGMA_MENTIONS,
  SIGMA_REQUEST,
  SIGMA_VALIDATION,
} from './epics/target.js';
import { Errands } from './errands/service.js';
import { Flow } from './flow/service.js';
import { Inbox } from './inbox/service.js';
import { inboxSources } from './inbox/sources.js';
import { Knowledge } from './knowledge/service.js';
import { Learning } from './learning/service.js';
import { Media } from './media/service.js';
import { Memories } from './memories/service.js';
import { Mentions } from './mentions/service.js';
import { Pautas } from './pautas/service.js';
import { Peers } from './peers/service.js';
import { PipelineChain } from './pipeline/service.js';
import { Plans } from './plans/service.js';
import { Priorities } from './priorities/service.js';
import { workBoardOpener, workClientOpener } from './priorities/work-board.js';
import { Profiles } from './profiles/service.js';
import { PrintsRepository } from './prototypes/prints-repo.js';
import { Prototypes } from './prototypes/service.js';
import type { ModelCatalog } from './providers/catalog-source.js';
import { readModelDefaults } from './providers/repository.js';
import { Providers } from './providers/service.js';
import { SubscriptionUsageReader } from './providers/subscription-usage.js';
import { Quality } from './quality/service.js';
import { RepositoryStars } from './releases/repository.js';
import { ReleaseNotes } from './releases/service.js';
import { Roadmap } from './roadmap/service.js';
import { RunLifecycle } from './runs/lifecycle.js';
import { Runs } from './runs/service.js';
import { Schedules } from './schedules/service.js';
import { Screens } from './screens/service.js';
import type { GatewayVault } from './security/gateway-vault.js';
import { createSafeFetch } from './security/outbound.js';
import type { Vault } from './security/vault.js';
import { Sessions } from './sessions/service.js';
import { OwnerNotices } from './settings/owner-notices.js';
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
  prints: PrintsRepository;
  pautas: Pautas;
  priorities: Priorities;
  flow: Flow;
  drawings: Drawings;
  epics: Epics;
  validations: Validations;
  mentions: Mentions;
  inbox: Inbox;
  pipeline: PipelineChain;
  roadmap: Roadmap;
  screens: Screens;
  plans: Plans;
  knowledge: Knowledge;
  entrySync: EntrySync;
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
  ownerNotices: OwnerNotices;
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
  const prints = new PrintsRepository(store, gatewayVault, fetcher ?? createSafeFetch().fetch);
  prototypes.usePrints(prints);
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
  const settings = new Settings(store, timeZone);
  // The owner hears from the gateway in the panel conversation of the profile that has the Work,
  // and, unless the setting says otherwise, from that profile's owner contacts on its channels.
  const ownerNotices = new OwnerNotices(settings, workProfile, async (profileId, text, key) => {
    const owner = (await sessions.sessions(profileId)).find(
      (session) => session.channel === 'gateway',
    );
    if (owner) await runs.submit(profileId, owner.id, { text, requestKey: key });
  });
  validations.useOwner((text, short) => ownerNotices.tell(text, 'validation', short));
  runs.useValidations(validations);
  // Prototypes and prioritizations plan first once a Reviewer is set (B18); the author and the
  // Reviewer are told in their own conversations, and the owner in the one the validations use.
  const plans = new Plans(store, profiles, sessions, quality, clock);
  plans.useAgents((profileId, sessionId, text, requestKey, model) =>
    runs.submit(profileId, sessionId, { text, requestKey, ...(model ? { model } : {}) }),
  );
  plans.useOwner((text, short) => ownerNotices.tell(text, 'plan', short));
  // The base every agent reads before asking (B19); the Curator learns from the owner's answers.
  // Its proposals reach the owner the way plans do: the panel and, by the setting, the channels.
  const knowledge = new Knowledge(store, profiles, sessions, clock);
  knowledge.useAgents((profileId, sessionId, text, requestKey) =>
    runs.submit(profileId, sessionId, { text, requestKey }),
  );
  knowledge.useOwner((text) => ownerNotices.tell(text, 'knowledge'));
  plans.useKnowledge(knowledge);
  runs.useKnowledge(knowledge);
  pautas.useLearner((lesson) => knowledge.learn(lesson));
  validations.useLearner((lesson) => knowledge.learn(lesson));
  plans.usePrototypes(prototypes);
  prototypes.usePlanner(plans);
  plans.usePriorities(priorities);
  priorities.usePlanner(plans);
  // The Entrada follows the epics (B20): a read of the boards is always a plan.
  const entrySync = new EntrySync(store, workClients, workProfile, SIGMA_ENTRY, clock);
  entrySync.usePlanner(plans);
  plans.useEntrySync(entrySync);
  runs.usePlans(plans);
  // Comments on the tracker answered for the owner (B22): the agent with the tracker triages and
  // answers in conversations of its own; the high-impact ones reach the owner as plans do.
  const mentions = new Mentions(store, workClients, workProfile, SIGMA_MENTIONS, quality, clock);
  mentions.useAgents({
    submit: (profileId, sessionId, text, requestKey, model) =>
      runs.submit(profileId, sessionId, { text, requestKey, ...(model ? { model } : {}) }),
    session: async (profileId, title) =>
      (await sessions.sessions(profileId)).find(
        (session) => session.channel === 'mentions' && session.title === title,
      ) ?? sessions.createSession(profileId, { title, channel: 'mentions' }),
    conversationModel: async (profileId) =>
      (await readModelDefaults(store.db, profileId, nowIso(clock))).conversation ?? undefined,
  });
  mentions.useOwner((text, short) => ownerNotices.tell(text, 'mention', short));
  mentions.useLearner((lesson) => knowledge.learn(lesson));
  runs.useMentions(mentions);
  // The products' roadmap (B24): the Estrategista proposes in conversations of its own, the
  // owner hears of the proposals as of the plans, and refusals reach the Curator.
  const roadmap = new Roadmap(
    store,
    profiles,
    applications,
    workClients,
    workProfile,
    SIGMA_ENTRY,
    quality,
    clock,
  );
  roadmap.useAgents({
    submit: (profileId, sessionId, text, requestKey) =>
      runs.submit(profileId, sessionId, { text, requestKey }),
    session: async (profileId, title) =>
      (await sessions.sessions(profileId)).find(
        (session) => session.channel === 'roadmap' && session.title === title,
      ) ?? sessions.createSession(profileId, { title, channel: 'roadmap' }),
    remember: (profileId, key, content) =>
      memories.remember(profileId, { key, content, expectedVersion: 0 }),
  });
  roadmap.useOwner((text, short) => ownerNotices.tell(text, 'roadmap', short));
  roadmap.useLearner((lesson) => knowledge.learn(lesson));
  runs.useRoadmap(roadmap);
  // A request in Priorizado walks to an epic by itself (B23); the owner answers at the gates.
  const pipeline = new PipelineChain(
    store,
    workClients,
    workProfile,
    SIGMA_ENTRY,
    profiles,
    pautas,
    prototypes,
    epics,
    SIGMA_REQUEST,
    clock,
  );
  pipeline.useAgents({
    submit: (profileId, sessionId, text, requestKey) =>
      runs.submit(profileId, sessionId, { text, requestKey }),
    session: async (profileId, title) =>
      (await sessions.sessions(profileId)).find(
        (session) => session.channel === 'pipeline' && session.title === title,
      ) ?? sessions.createSession(profileId, { title, channel: 'pipeline' }),
  });
  pipeline.useOwner((text, short) => ownerNotices.tell(text, 'pipeline', short));
  // The owner's inbox (B26): every queue under one number, answered with the same commands.
  const inbox = new Inbox(store, clock);
  for (const source of inboxSources({
    prototypes,
    epics,
    pipeline,
    profiles,
    approvals,
    plans,
    knowledge,
    pautas,
    validations,
    mentions,
    roadmap,
    priorities,
  })) {
    inbox.use(source);
  }
  ownerNotices.useInbox(inbox);
  approvals.useNumbering((refId) => inbox.numberFor('aprovacao', refId));
  runs.useInbox(inbox);
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
    prints,
    pautas,
    priorities,
    flow: new Flow(workClients, clock),
    epics,
    validations,
    mentions,
    inbox,
    pipeline,
    roadmap,
    screens: new Screens(store, applications, clock),
    plans,
    knowledge,
    entrySync,
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
    ownerNotices,
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
