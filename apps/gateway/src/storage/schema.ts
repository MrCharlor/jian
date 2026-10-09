import type {
  ActionPolicy,
  AgentCallOrigin,
  ContextPolicy,
  GroupTurn,
  Identity,
  McpServer,
  ModelConfig,
  ModelSelection,
  Profile,
  ProviderCredential,
  ReasoningEffort,
  RunProgress,
  Skill,
  Subagent,
  Usage,
} from '@jian/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * A column holds what the gateway filters, sorts or constrains on. JSONB holds what it only
 * ever reads back whole — a frozen model choice, a protocol payload, a ciphertext envelope.
 * Everything here is scoped by profile, and every child cascades from its profile.
 */

const createdAt = timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  instructions: text('instructions').notNull(),
  // What other agents of the installation see; never the instructions.
  summary: text('summary').notNull().default(''),
  avatar: text('avatar'),
  model: jsonb('model').$type<ModelConfig>().notNull(),
  identity: jsonb('identity').$type<Identity>().notNull(),
  contextPolicy: jsonb('context_policy').$type<ContextPolicy>().notNull(),
  skills: jsonb('skills').$type<Skill[]>().notNull().default([]),
  disabledSkills: jsonb('disabled_skills').$type<string[]>().notNull().default([]),
  mcpServers: jsonb('mcp_servers').$type<McpServer[]>().notNull().default([]),
  allowSelfManagement: boolean('allow_self_management').notNull().default(false),
  allowShell: boolean('allow_shell').notNull().default(false),
  allowWebSearch: boolean('allow_web_search').notNull().default(false),
  learnFromWork: boolean('learn_from_work').notNull().default(true),
  useStickers: boolean('use_stickers').notNull().default(false),
  reachableByAgents: boolean('reachable_by_agents').notNull().default(true),
  actionPolicy: jsonb('action_policy')
    .$type<ActionPolicy>()
    .notNull()
    .default({ machine: 3, service: 3, message: 3, tools: {} }),
  version: integer('version').notNull(),
  createdAt,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per version. A run points at the version it froze instead of copying the profile. */
export const profileRevisions = pgTable(
  'profile_revisions',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    document: jsonb('document').$type<Profile>().notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.version] }),
    index('profile_revisions_recent').on(table.profileId, table.version.desc()),
  ],
);

export const providerKind = pgEnum('provider_kind', [
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'groq',
  'openai-compatible',
]);

/**
 * A vendor credential belongs to the installation, not to a profile. There is one owner, and
 * signing in to the same vendor once per agent is work nobody would do twice. Which model an
 * agent uses stays its own choice, in `model_defaults`.
 */
export const providers = pgTable(
  'providers',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    kind: providerKind('kind').notNull(),
    authMode: text('auth_mode').$type<'api' | 'codex'>(),
    // Which of Anthropic's two credentials this is. Null for every other vendor, and for a row
    // written before the panel asked, where the credential's own prefix answers instead.
    credential: text('credential').$type<ProviderCredential>(),
    apiKeyEnv: text('api_key_env'),
    // Where an OpenAI-compatible server's API is; null for every vendor with a fixed address.
    baseUrl: text('base_url'),
    createdAt,
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // One live provider per vendor: the rule the service enforced by scanning.
    uniqueIndex('providers_live_per_kind_auth')
      .on(table.kind, sql`coalesce(${table.authMode}, 'api')`)
      .where(sql`${table.revokedAt} is null`),
  ],
);

/**
 * Secrets the installation owns, kept apart from the per-profile ones so that deleting a
 * profile still takes its own secrets with it and leaves the shared credentials alone.
 */
export const gatewaySecrets = pgTable('gateway_secrets', {
  name: text('name').primaryKey(),
  envelope: jsonb('envelope').notNull(),
  createdAt,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A role per row, so a role added later needs no column. */
export const modelDefaults = pgTable(
  'model_defaults',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    // Null on both means the role is configured as empty, which is not the same as unset.
    providerId: uuid('provider_id'),
    modelId: text('model_id'),
    reasoningEffort: text('reasoning_effort').$type<ReasoningEffort>(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.role] })],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    title: text('title'),
    channel: text('channel').notNull(),
    // Set on the session a pair of agents shares; the peer never reads it.
    peerProfileId: uuid('peer_profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    // On a channel conversation: 'direct' or 'group', kept here so it outlives its contact.
    scope: text('scope').$type<'direct' | 'group'>(),
    summary: text('summary'),
    summarizedUpTo: timestamp('summarized_up_to', { withTimezone: true }),
    summarizedThroughId: uuid('summarized_through_id'),
    model: jsonb('model').$type<ModelSelection>(),
    ponytailMode: text('ponytail_mode')
      .$type<'lite' | 'full' | 'ultra' | 'off'>()
      .notNull()
      .default('full'),
    cavemanMode: text('caveman_mode')
      .$type<'lite' | 'full' | 'ultra' | 'off'>()
      .notNull()
      .default('off'),
    createdAt,
  },
  (table) => [
    index('sessions_recent').on(table.profileId, table.createdAt.desc()),
    index('sessions_peer').on(table.profileId, table.peerProfileId),
    // One gateway conversation per profile, whatever races to open it.
    uniqueIndex('sessions_gateway').on(table.profileId).where(sql`${table.channel} = 'gateway'`),
    uniqueIndex('sessions_learning').on(table.profileId).where(sql`${table.channel} = 'learning'`),
  ],
);

export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id').references(() => workItems.id, { onDelete: 'set null' }),
    subagent: jsonb('subagent').$type<Subagent>(),
    subagentReportedAt: timestamp('subagent_reported_at', { withTimezone: true }),
    // The profile this run froze. The snapshot is read from the revision, never copied here.
    profileVersion: integer('profile_version').notNull(),
    requestKey: text('request_key').notNull(),
    input: text('input').notNull(),
    status: runStatus('status').notNull(),
    output: text('output'),
    error: text('error'),
    usage: jsonb('usage').$type<Usage>(),
    continuationOf: uuid('continuation_of'),
    model: jsonb('model').$type<ModelConfig>(),
    modelSelection: jsonb('model_selection').$type<ModelSelection>(),
    contextPolicy: jsonb('context_policy').$type<ContextPolicy>(),
    call: jsonb('call').$type<AgentCallOrigin>(),
    group: jsonb('group_turn').$type<GroupTurn>(),
    // Overwritten many times while a run is live and cleared when it ends; never history.
    progress: jsonb('progress').$type<RunProgress>(),
    commentary: jsonb('commentary').$type<string[]>(),
    // Set when the agent that asked stopped waiting: the answer is carried into that session
    // as a turn of its own instead of being lost with the caller's run.
    relayTo: uuid('relay_to').references(() => sessions.id, { onDelete: 'set null' }),
    // What started the run when nobody typed it: `schedule:<name>`. Absent for a person.
    origin: text('origin'),
    // What the person said while this run was already going. Read and cleared between steps.
    steer: text('steer'),
    leaseOwner: text('lease_owner'),
    leaseUntil: bigint('lease_until', { mode: 'number' }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Submitting the same request twice returns the first run instead of starting another.
    uniqueIndex('runs_request_key').on(table.profileId, table.sessionId, table.requestKey),
    index('runs_activity').on(table.profileId, table.status, table.createdAt.desc()),
    // Recovery sweeps every profile's running rows, so this one is not scoped by profile.
    index('runs_running').on(table.status).where(sql`${table.status} = 'running'`),
    index('runs_queued').on(table.status).where(sql`${table.status} = 'queued'`),
    index('runs_session').on(table.profileId, table.sessionId, table.createdAt.desc()),
    index('runs_origin')
      .on(table.profileId, table.origin, table.createdAt.desc())
      .where(sql`${table.origin} IS NOT NULL`),
    index('runs_work_item')
      .on(table.profileId, table.workItemId, table.createdAt)
      .where(sql`${table.workItemId} IS NOT NULL`),
    uniqueIndex('runs_subagent_spawn')
      .on(
        table.profileId,
        sql`(${table.subagent}->>'parentRunId')`,
        sql`(${table.subagent}->>'spawnKey')`,
      )
      .where(sql`${table.subagent} IS NOT NULL`),
    index('runs_unreported_subagent')
      .on(table.status)
      .where(sql`${table.subagent} IS NOT NULL AND ${table.subagentReportedAt} IS NULL`),
  ],
);

export const messageRole = pgEnum('message_role', ['user', 'assistant']);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    // Null on what the agent read in a group without being called.
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    role: messageRole('role').notNull(),
    content: text('content').notNull(),
    // Set in a group: who wrote it, by their id on the channel and the name they showed.
    authorId: text('author_id'),
    authorName: text('author_name'),
    call: jsonb('call').$type<{ profileId: string; sessionId: string; runId: string }>(),
    createdAt,
  },
  (table) => [
    index('messages_session').on(table.sessionId, table.createdAt.desc()),
    index('messages_profile').on(table.profileId, table.createdAt.desc()),
    index('messages_search').using('gin', sql`to_tsvector('simple', ${table.content})`),
  ],
);

export const memories = pgTable(
  'memories',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // One memory per key: the uniqueness the service used to enforce by reading first.
    key: text('key').notNull(),
    content: text('content').notNull(),
    version: integer('version').notNull(),
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.key] }),
    index('memories_recent').on(table.profileId, table.updatedAt.desc()),
    index('memories_search').using(
      'gin',
      sql`to_tsvector('simple', ${table.key} || ' ' || ${table.content})`,
    ),
  ],
);

/** Durable work belongs to one profile; a run ending never changes its task status. */
export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    description: text('description').notNull(),
    mediaIds: jsonb('media_ids').$type<string[]>().notNull().default([]),
    repositories: jsonb('repositories').$type<string[]>().notNull().default([]),
    status: text('status')
      .$type<'todo' | 'in_progress' | 'review' | 'blocked' | 'done'>()
      .notNull()
      .default('todo'),
    note: text('note').notNull().default(''),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').$type<'agent' | 'owner'>().notNull(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('work_items_profile_status').on(table.profileId, table.status, table.updatedAt.desc()),
    check(
      'work_items_status',
      sql`${table.status} IN ('todo','in_progress','review','blocked','done')`,
    ),
    check('work_items_version', sql`${table.version} > 0`),
    check('work_items_updated_by', sql`${table.updatedBy} IN ('agent','owner')`),
  ],
);

/**
 * Something the agent does at a time: once (`at`) or on a repetition (`cron`), in a time zone,
 * in one conversation. `next_run_at` is what the scheduler looks at; it is absent once a
 * single time has passed or while the schedule is switched off.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    instruction: text('instruction').notNull(),
    at: timestamp('at', { withTimezone: true }),
    cron: text('cron'),
    timeZone: text('time_zone').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunId: uuid('last_run_id'),
    lastError: text('last_error'),
    createdBy: text('created_by').$type<'owner' | 'agent'>().notNull(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('schedules_profile').on(table.profileId, table.createdAt),
    index('schedules_due').on(table.nextRunAt).where(sql`${table.enabled}`),
    check('schedules_timing', sql`(${table.at} IS NULL) <> (${table.cron} IS NULL)`),
  ],
);

/** One time a schedule started, or tried to: kept for thirty days as its history. */
export const scheduleRuns = pgTable(
  'schedule_runs',
  {
    id: uuid('id').primaryKey(),
    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedules.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    manual: boolean('manual').notNull().default(false),
    runId: uuid('run_id'),
    error: text('error'),
    createdAt,
  },
  (table) => [index('schedule_runs_schedule').on(table.scheduleId, table.createdAt.desc())],
);

/** Settings of the whole installation, one row per setting. */
export const gatewaySettings = pgTable('gateway_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * What the installation spent on the decisions service, per UTC day and use. It holds counts
 * only — never what was asked — for usage reporting.
 */
export const decisionUsage = pgTable(
  'decision_usage',
  {
    day: text('day').notNull(),
    use: text('use').notNull(),
    requests: integer('requests').notNull().default(0),
    cached: integer('cached').notNull().default(0),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.day, table.use] })],
);

/**
 * Two memories recalled together. A link has no direction, so it is stored once, the smaller
 * key first, and goes when either memory does.
 */
export const memoryLinks = pgTable(
  'memory_links',
  {
    profileId: uuid('profile_id').notNull(),
    aKey: text('a_key').notNull(),
    bKey: text('b_key').notNull(),
    createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.profileId, table.aKey, table.bKey] }),
    index('memory_links_b').on(table.profileId, table.bKey),
    check('memory_links_order', sql`${table.aKey} < ${table.bKey}`),
    foreignKey({
      columns: [table.profileId, table.aKey],
      foreignColumns: [memories.profileId, memories.key],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.profileId, table.bKey],
      foreignColumns: [memories.profileId, memories.key],
    }).onDelete('cascade'),
  ],
);

export const checkpoints = pgTable(
  'checkpoints',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull(),
    createdAt,
  },
  (table) => [index('checkpoints_run').on(table.runId, table.createdAt.desc())],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    toolName: text('tool_name').notNull(),
    content: text('content').notNull(),
    bytes: integer('bytes').notNull(),
    createdAt,
  },
  (table) => [index('artifacts_run').on(table.runId, table.createdAt.desc())],
);

/** A fenced lock a run holds on a named resource; the fence rises on every acquisition. */
export const leases = pgTable(
  'leases',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    resource: text('resource').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    fence: bigserial('fence', { mode: 'number' }).notNull(),
    expiresAt: bigint('expires_at', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.resource] })],
);

export const mail = pgTable(
  'mail',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    fromSessionId: uuid('from_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    toSessionId: uuid('to_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    requestKey: text('request_key').notNull(),
    createdAt,
  },
  (table) => [
    uniqueIndex('mail_request_key').on(table.profileId, table.fromSessionId, table.requestKey),
    index('mail_inbox').on(table.toSessionId, table.createdAt.desc()),
  ],
);

/**
 * Every secret the installation holds, addressed by what owns it — `provider:<id>`,
 * `channel:<id>`, `mcp:<name>`. The address is also the associated data of the envelope, so a
 * ciphertext moved to another owner fails to decrypt.
 */
export const secrets = pgTable(
  'secrets',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    envelope: jsonb('envelope').notNull(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.profileId, table.name] })],
);

/**
 * How far the owner has read the release notes: the version they were last shown. One row, since
 * an installation has one owner; `scope` separates release eras without deleting the old read mark.
 */
export const releaseReads = pgTable('release_reads', {
  scope: text('scope').primaryKey(),
  version: text('version').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const channelType = pgEnum('channel_type', ['api', 'telegram', 'whatsapp']);

export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    type: channelType('type').notNull(),
    // How this connection is addressed on its protocol; how an agent recognises a colleague.
    address: text('address'),
    // The name people type to mention it, where that differs from the address: a Telegram
    // `@username` names the bot without carrying its id.
    handle: text('handle'),
    // The profile picture last put on the account, as `<address>:<hash>` or `<address>:none`.
    pictureSynced: text('picture_synced'),
    webhookTokenHash: text('webhook_token_hash').notNull(),
    createdAt,
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // One live channel per type: the rule the screen now shows as connected or not.
    uniqueIndex('channels_live_per_type')
      .on(table.profileId, table.type)
      .where(sql`${table.revokedAt} is null`),
    uniqueIndex('channels_webhook_token').on(table.webhookTokenHash),
  ],
);

export const contactScope = pgEnum('contact_scope', ['direct', 'group']);
export const contactStatus = pgEnum('contact_status', ['pending', 'approved', 'blocked']);

export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    scope: contactScope('scope').notNull(),
    // The chat this contact speaks in; for a group, the room itself.
    chatId: text('chat_id').notNull(),
    actorId: text('actor_id').notNull(),
    title: text('title'),
    status: contactStatus('status').notNull(),
    // Speaks for the owner: their reply in the chat decides what the agent waits on.
    owner: boolean('owner').notNull().default(false),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    // The first message, kept until approval releases it exactly once.
    heldMessage: jsonb('held_message'),
    heldMessageId: text('held_message_id'),
    agentTurns: integer('agent_turns').notNull().default(0),
    seen: jsonb('seen').$type<string[]>().notNull().default([]),
    // The channel's own picture of this contact, small, and when it was last asked for: a
    // contact with none is asked again later, not on every message.
    avatar: text('avatar'),
    avatarCheckedAt: timestamp('avatar_checked_at', { withTimezone: true }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('contacts_identity').on(table.channelId, table.chatId, table.actorId),
    index('contacts_pending').on(table.profileId, table.status),
  ],
);

/**
 * Someone who wrote in a group through a channel. They are not contacts: the group is the
 * contact the owner approved, and its members come and go without asking. This keeps only what
 * the panel shows beside their messages — the name they last used and their picture.
 */
export const people = pgTable(
  'people',
  {
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    actorId: text('actor_id').notNull(),
    displayName: text('display_name'),
    avatar: text('avatar'),
    avatarCheckedAt: timestamp('avatar_checked_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.actorId] })],
);

export const deliveryStatus = pgEnum('delivery_status', [
  'pending',
  'sending',
  'sent',
  'failed',
  'unknown',
]);

export const errandStatus = pgEnum('errand_status', ['waiting', 'answered', 'expired']);

/**
 * A question the agent put to one of its contacts on behalf of a conversation. The contact
 * answers on their own time, in their own chat; this row is what carries their reply back to
 * the conversation that asked, instead of leaving it where nobody was waiting for it.
 */
export const errands = pgTable(
  'errands',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    // Where the answer goes. A session that is gone leaves nothing to deliver to.
    fromSessionId: uuid('from_session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    status: errandStatus('status').notNull(),
    answer: text('answer'),
    answerRequestKey: text('answer_request_key'),
    // After this, a message from that contact is a new conversation, not a late reply.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One open question per contact: two at once, and their replies cannot be told apart.
    uniqueIndex('errands_open_per_contact')
      .on(table.contactId)
      .where(sql`${table.status} = 'waiting'`),
    index('errands_waiting').on(table.profileId, table.status),
  ],
);

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    // A notice to a stranger has no run behind it.
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    chatId: text('chat_id').notNull(),
    // Gateway-authored text sent without a run, such as the approval notice.
    notice: text('notice'),
    mediaId: uuid('media_id'),
    status: deliveryStatus('status').notNull(),
    error: text('error'),
    // What the protocol called the message it accepted, for a later receipt to match.
    remoteMessageIds: jsonb('remote_message_ids')
      .$type<Array<string | number>>()
      .notNull()
      .default([]),
    // How much of the run's commentary this chat already received, so a second worker or a
    // second tick never repeats a message that is on the screen.
    saidCount: integer('said_count').notNull().default(0),
    // Which device generation sent it: a receipt from an older pairing is not this one's.
    connectionGeneration: integer('connection_generation'),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deliveries_recent').on(table.profileId, table.createdAt.desc()),
    index('deliveries_phase').on(table.channelId, table.status, table.createdAt),
  ],
);

export const connectionStatus = pgEnum('connection_status', [
  'disconnected',
  'connecting',
  'qr',
  'connected',
  'error',
]);

/** The desired and observed state of one linked device, plus the lease its worker holds. */
export const channelConnections = pgTable('channel_connections', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  desired: boolean('desired').notNull(),
  generation: integer('generation').notNull(),
  fence: integer('fence'),
  status: connectionStatus('status').notNull(),
  owner: text('owner'),
  leaseUntil: bigint('lease_until', { mode: 'number' }),
  retryAt: bigint('retry_at', { mode: 'number' }),
  accountId: text('account_id'),
  sessionSavedAt: timestamp('session_saved_at', { withTimezone: true }),
  error: text('error'),
  qr: jsonb('qr'),
  qrExpiresAt: bigint('qr_expires_at', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** The linked device's own credentials, encrypted in chunks the gateway never reads. */
export const channelAuth = pgTable('channel_auth', {
  channelId: uuid('channel_id')
    .primaryKey()
    .references(() => channels.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  chunks: jsonb('chunks').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const inboxStatus = pgEnum('inbox_status', ['pending', 'submitted', 'discarded']);

/** What a device received before the gateway could turn it into a run. */
export const channelInbox = pgTable(
  'channel_inbox',
  {
    id: text('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    message: jsonb('message').notNull(),
    status: inboxStatus('status').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('channel_inbox_pending').on(table.channelId, table.status, table.receivedAt)],
);

/** The durable feed the panel follows, ordered by a single sequence. */
export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id'),
    type: text('type').notNull(),
    data: jsonb('data'),
    createdAt,
  },
  (table) => [index('events_cursor').on(table.profileId, table.id)],
);

export const mediaAssets = pgTable(
  'media_assets',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    sourceKey: text('source_key').notNull(),
    mimeType: text('mime_type').notNull(),
    data: text('data').notNull(),
    bytes: integer('bytes').notNull(),
    voice: boolean('voice').notNull().default(false),
    sticker: boolean('sticker').notNull().default(false),
    name: text('name'),
    analysis: text('analysis'),
    held: boolean('held').notNull().default(false),
    createdAt,
  },
  (table) => [
    uniqueIndex('media_source').on(table.profileId, table.sourceKey),
    index('media_session').on(table.profileId, table.sessionId),
  ],
);

/** The stickers an agent has seen, one row per image, whatever chat it came from. */
export const stickers = pgTable(
  'stickers',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull(),
    data: text('data').notNull(),
    description: text('description'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    uses: integer('uses').notNull().default(0),
    seen: integer('seen').notNull().default(1),
    declined: boolean('declined').notNull().default(false),
    createdAt,
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('stickers_hash').on(table.profileId, table.hash)],
);

export const approvalStatus = pgEnum('approval_status', [
  'pending',
  'approved',
  'rejected',
  'used',
  'expired',
]);

/**
 * An action the agent prepared and the owner has to decide on. `number` is what the owner
 * answers to in a chat, so it is short and counts up per profile; `inputHash` is how the
 * same call is recognised when the agent repeats it after approval.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    tool: text('tool').notNull(),
    action: text('action').notNull(),
    input: jsonb('input'),
    inputHash: text('input_hash').notNull(),
    summary: text('summary').notNull().default(''),
    status: approvalStatus('status').notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedVia: text('decided_via').$type<'panel' | 'channel' | 'api'>(),
    reason: text('reason'),
    createdAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex('approvals_number').on(table.profileId, table.number),
    index('approvals_pending').on(table.profileId, table.status, table.createdAt.desc()),
    index('approvals_session').on(table.profileId, table.sessionId, table.createdAt.desc()),
  ],
);

export const correctionKind = pgEnum('correction_kind', ['rejected', 'edited', 'redone']);

/**
 * What the owner changed in an agent's work. `automation` is fixed when the row is written —
 * the schedule that started the run, or the exact action — so the measure does not move when
 * a schedule is renamed or a run is pruned.
 */
export const corrections = pgTable(
  'corrections',
  {
    id: uuid('id').primaryKey(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    automation: text('automation').notNull(),
    kind: correctionKind('kind').notNull(),
    original: jsonb('original'),
    corrected: jsonb('corrected'),
    note: text('note'),
    via: text('via').$type<'panel' | 'channel' | 'api'>().notNull(),
    createdAt,
  },
  (table) => [
    index('corrections_automation').on(table.profileId, table.automation, table.createdAt.desc()),
    index('corrections_recent').on(table.profileId, table.createdAt.desc()),
  ],
);

/**
 * A product the owner designs for, with its design system kept as files. It belongs to the
 * installation, like a provider: every agent reads it, only the owner changes it.
 */
export const applications = pgTable('applications', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  url: text('url'),
  audience: text('audience'),
  platform: text('platform').notNull().default('web'),
  source: text('source'),
  version: integer('version').notNull().default(0),
  createdAt,
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One file of an application's design system. Text is kept as written, the rest as base64. */
export const applicationFiles = pgTable(
  'application_files',
  {
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    contentType: text('content_type').notNull(),
    encoding: text('encoding').$type<'utf8' | 'base64'>().notNull(),
    content: text('content').notNull(),
    bytes: integer('bytes').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.applicationId, table.path] })],
);

/** A screen drawn for an application from a request; its versions are below. */
export const prototypes = pgTable(
  'prototypes',
  {
    id: uuid('id').primaryKey(),
    applicationId: uuid('application_id')
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    requestUrl: text('request_url'),
    brief: text('brief').notNull(),
    createdBy: text('created_by').notNull(),
    // Whose quality the rounds count in, and, for an agent, where it is told the screen is ready.
    profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'set null' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    approvedVersion: integer('approved_version'),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('prototypes_application').on(table.applicationId, table.updatedAt.desc())],
);

export const prototypeVersions = pgTable(
  'prototype_versions',
  {
    prototypeId: uuid('prototype_id')
      .notNull()
      .references(() => prototypes.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    status: text('status').notNull(),
    comments: text('comments'),
    html: text('html'),
    error: text('error'),
    durationMs: integer('duration_ms'),
    createdAt,
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.prototypeId, table.number] }),
    index('prototype_versions_waiting').on(table.status, table.createdAt),
  ],
);

export const prototypePrints = pgTable(
  'prototype_prints',
  {
    prototypeId: uuid('prototype_id')
      .notNull()
      .references(() => prototypes.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contentType: text('content_type').notNull(),
    content: text('content').notNull(),
  },
  (table) => [primaryKey({ columns: [table.prototypeId, table.name] })],
);
