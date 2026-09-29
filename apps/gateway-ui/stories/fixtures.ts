import type {
  ActivityDay,
  BuiltinSkill,
  Channel,
  Connection,
  Contact,
  Delivery,
  Group,
  Memory,
  ModelDefaults,
  Profile,
  Provider,
  ProviderModelList,
  Run,
  Schedule,
  Session,
  WorkHistory,
  WorkItem,
} from '../lib/api';

/**
 * One believable installation, synthetic from end to end: every story reads it, so a screen is
 * judged against the same agents, conversations and history wherever it appears.
 */

import {
  at,
  ids as chats,
  lastMessageOf,
  messages as scripted,
  people as scriptedPeople,
  runs as scriptedRuns,
  timelines as scriptedTimelines,
} from './conversations';
import { mediaId, portrait, media as scriptedMedia } from './media';

export const ids = {
  ...chats,
  ichigo: '39c2c2fd-6204-47d4-b3f3-e7ad41e4e25c',
  anthropic: '4219fb5c-a06b-4471-aa1b-d03505cf6ec9',
  openai: '6f3f5edf-4381-4f8a-9f6c-5ed51f97a0eb',
  telegram: 'db4710b8-8be4-48e3-8b89-bb7865f77ed5',
  whatsapp: '121600cb-13ac-4ed2-9284-3dff8d5e8779',
  mayaContact: '0f7c5a41-2a4e-4d59-9a3b-6f0f6f1d2c11',
  theoContact: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  designContact: '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e',
  launchContact: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  strangerContact: '3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f',
};

export const work = [
  {
    id: 'a1b2c3d4-1111-4111-8111-111111111111',
    profileId: ids.zero,
    sourceSessionId: ids.gatewayChat,
    title: 'Verify gateway release',
    description: 'Run checks and review the release before publishing.',
    mediaIds: [mediaId('whiteboard')],
    repositories: [],
    status: 'review',
    note: 'Gateway checks passed; review is pending.',
    version: 3,
    updatedBy: 'agent',
    createdAt: at(60 * 24 * 2),
    updatedAt: at(60 * 4),
  },
  {
    id: 'a1b2c3d4-2222-4222-8222-222222222222',
    profileId: ids.zero,
    sourceSessionId: null,
    title: 'Audit provider fallbacks',
    description: 'Check error handling when subscription usage is unavailable.',
    mediaIds: [],
    repositories: [],
    status: 'in_progress',
    note: 'Reviewing the fallback path.',
    version: 2,
    updatedBy: 'agent',
    createdAt: at(60 * 24),
    updatedAt: at(60),
  },
] satisfies [WorkItem, WorkItem];

export const workHistory: Record<string, WorkHistory> = {
  [work[0].id]: [
    { id: 1, type: 'work.created', status: 'todo', note: '', createdAt: work[0].createdAt },
    {
      type: 'work.updated',
      id: 2,
      status: 'in_progress',
      note: 'Starting checks.',
      createdAt: at(60 * 24),
    },
    {
      id: 3,
      type: 'work.updated',
      status: 'review',
      note: work[0].note,
      createdAt: work[0].updatedAt,
    },
  ],
  [work[1].id]: [
    { id: 4, type: 'work.created', status: 'todo', note: '', createdAt: work[1].createdAt },
    {
      type: 'work.updated',
      id: 5,
      status: 'in_progress',
      note: work[1].note,
      createdAt: work[1].updatedAt,
    },
  ],
};

const profileBase = {
  avatar: null,
  model: { provider: 'openai' as const, modelId: 'unconfigured' },
  contextPolicy: {
    inputTokens: 32000,
    outputTokens: 4096,
    memoryTokens: 1500,
    historyTokens: 6000,
    toolResultTokens: 1500,
    maxSteps: 200,
    maxRunTokens: 500000,
  },
  disabledSkills: [],
  allowSelfManagement: false,
  allowShell: false,
  allowWebSearch: false,
  learnFromWork: true,
  useStickers: true,
  reachableByAgents: true,
  version: 3,
  createdAt: at(60 * 24 * 30),
  updatedAt: at(60 * 3),
};

export const profiles: Profile[] = [
  {
    ...profileBase,
    id: ids.zero,
    name: 'Zero Two',
    summary: 'The owner’s main assistant: schedules, messages and the day’s loose ends.',
    instructions: 'You are Zero Two, the owner’s assistant. Be direct and warm.',
    identity: {
      role: 'Personal assistant',
      tone: 'Direct, warm, a little teasing',
      goals: ['Keep the day moving', 'Close loops without being asked twice'],
      boundaries: ['Never send money', 'Ask before writing to someone new'],
    },
    skills: [
      {
        name: 'concise',
        description: 'Answer in the first sentence; every word earns its place.',
        instructions: 'Lead with the answer.',
        origin: { url: 'https://github.com/example/skills', importedAt: at(60 * 24 * 7) },
      },
    ],
    mcpServers: [
      {
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        auth: 'headers',
        headers: [{ name: 'Authorization' }],
        args: [],
        env: [],
        disabledTools: ['create_issue'],
      },
    ],
    allowSelfManagement: true,
    allowWebSearch: true,
    learnFromWork: true,
    useStickers: true,
    reachableByAgents: true,
  },
  {
    ...profileBase,
    id: ids.miku,
    name: 'Miku',
    summary: 'Code review and pull requests across the Northwind repositories.',
    instructions: 'You are Miku. Review code with precision.',
    identity: { role: 'Code reviewer', tone: 'Precise', goals: [], boundaries: [] },
    skills: [],
    // Miku has servers Zero Two does not, to import; and one it has too, to see refused.
    mcpServers: [
      {
        name: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        auth: 'oauth',
        headers: [],
        args: [],
        env: [],
        disabledTools: [],
      },
      {
        name: 'sentry',
        transport: 'http',
        url: 'https://mcp.sentry.dev/mcp',
        auth: 'headers',
        headers: [{ name: 'Authorization' }],
        args: [],
        env: [],
        disabledTools: [],
      },
      {
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        auth: 'headers',
        headers: [{ name: 'Authorization' }],
        args: [],
        env: [],
        disabledTools: [],
      },
    ],
    allowShell: true,
  },
  {
    ...profileBase,
    id: ids.ichigo,
    name: 'Ichigo',
    summary: '',
    instructions: 'You are Ichigo.',
    identity: { role: '', tone: '', goals: [], boundaries: [] },
    skills: [],
    mcpServers: [],
  },
];

const session = (
  id: string,
  channel: string,
  title: string | null,
  createdAgo: number,
  extra: Partial<Session> = {},
): Session => {
  const lastMessage = lastMessageOf(id);

  return {
    id,
    profileId: ids.zero,
    title,
    channel,
    ...(lastMessage ? { lastMessage } : {}),
    createdAt: at(createdAgo),
    ...extra,
  };
};

/** One conversation per situation the Sessions screen handles; see `conversations.ts`. */
export const sessions: Session[] = [
  session(ids.gatewayChat, 'gateway', 'Gateway', 60 * 24 * 30),
  session(ids.mayaChat, 'whatsapp', 'WhatsApp · Maya Chen', 60 * 24 * 12),
  session(ids.launchGroup, 'whatsapp', 'WhatsApp · Northwind Launch', 60 * 24 * 6),
  session(ids.theoChat, 'telegram', 'Telegram · Theo Park', 60 * 24 * 9),
  session(ids.designGroup, 'telegram', 'Telegram · Design Team', 60 * 24 * 4),
  session(ids.peerChat, 'agent', 'Agent · Miku', 60 * 24 * 2, { peerProfileId: ids.miku }),
  session(ids.learning, 'learning', 'Learning', 60 * 24 * 3),
  session(ids.reportChat, 'api', 'Nightly report', 60 * 24 * 20),
  session(ids.planningChat, 'api', 'Planning the week', 60 * 5, {
    summary: 'The owner asked for the week in review; the provider key was missing.',
  }),
  session(ids.emptyChat, 'api', null, 60 * 20),
];

export const messages = scripted;
export const media = scriptedMedia;
export const timelines = scriptedTimelines;
export const people = scriptedPeople;
export const runs: Run[] = scriptedRuns;

const schedule = (
  id: number,
  fields: Pick<Schedule, 'name' | 'instruction' | 'sessionId'> & Partial<Schedule>,
): Schedule => ({
  id: `5c4ed01e-0000-4000-8000-${String(id).padStart(12, '0')}`,
  profileId: ids.zero,
  timeZone: 'America/Sao_Paulo',
  enabled: true,
  createdBy: 'owner',
  createdAt: at(60 * 24 * 7),
  updatedAt: at(60 * 4),
  ...fields,
});

/** Routines the owner set and ones the agent set when asked, including a paused and a failed one. */
export const schedules: Schedule[] = [
  schedule(1, {
    name: 'Morning summary',
    instruction: 'Send me a summary of yesterday and what is due today.',
    sessionId: ids.gatewayChat,
    cron: '0 8 * * *',
    nextRunAt: '2026-09-25T11:00:00.000Z',
    lastRunAt: at(60 * 4),
  }),
  schedule(2, {
    name: 'Weekly update to Maya',
    instruction:
      'Write Maya a short update on the Northwind launch: what moved this week and what is at risk.',
    sessionId: ids.mayaChat,
    cron: '0 17 * * 5',
    nextRunAt: '2026-09-25T20:00:00.000Z',
    createdBy: 'agent',
  }),
  schedule(3, {
    name: 'Call the dentist',
    instruction: 'Remind me to call the dentist to move the appointment.',
    sessionId: ids.gatewayChat,
    at: '2026-09-24T18:00:00.000Z',
    nextRunAt: '2026-09-24T18:00:00.000Z',
    createdBy: 'agent',
  }),
  schedule(6, {
    name: 'Send Maya the contract',
    instruction: 'Remind me to send Maya the signed venue contract.',
    sessionId: ids.gatewayChat,
    at: '2026-09-22T13:00:00.000Z',
    enabled: false,
    lastRunAt: '2026-09-22T13:00:04.000Z',
  }),
  schedule(4, {
    name: 'Stand-up nudge',
    instruction: 'Remind the team that stand-up starts in 5 minutes.',
    sessionId: ids.designGroup,
    cron: '55 9 * * 1-5',
    enabled: false,
  }),
  schedule(5, {
    name: 'Nightly backup check',
    instruction: 'Check that last night’s backup finished and tell me only if it did not.',
    sessionId: ids.reportChat,
    cron: '0 6 * * *',
    nextRunAt: '2026-09-25T09:00:00.000Z',
    lastRunAt: at(60 * 6),
    lastError: 'The provider key is not configured. Add one under Providers.',
  }),
];

export const channels: Channel[] = [
  { id: ids.telegram, profileId: ids.zero, type: 'telegram', createdAt: at(60 * 24 * 10) },
  { id: ids.whatsapp, profileId: ids.zero, type: 'whatsapp', createdAt: at(60 * 24 * 10) },
];

export const connection: Connection = {
  channelId: ids.whatsapp,
  status: 'connected',
  accountId: '5571900000000@c.us',
  sessionSavedAt: at(10),
  updatedAt: at(10),
};

const contact = (
  id: string,
  channel: 'telegram' | 'whatsapp',
  scope: 'direct' | 'group',
  actorId: string,
  status: Contact['status'],
  ago: number,
  extra: Partial<Contact> = {},
): Contact => ({
  id,
  profileId: ids.zero,
  channelId: channel === 'telegram' ? ids.telegram : ids.whatsapp,
  type: channel,
  scope,
  actorId,
  chatId: actorId,
  status,
  createdAt: at(ago),
  updatedAt: at(ago),
  ...extra,
});

export const contacts: Contact[] = [
  contact(ids.mayaContact, 'whatsapp', 'direct', '4915550100001@c.us', 'approved', 60 * 24 * 12, {
    displayName: 'Maya Chen',
    sessionId: ids.mayaChat,
    avatar: portrait('#e6f4ea', '#2f7a52'),
  }),
  contact(
    ids.launchContact,
    'whatsapp',
    'group',
    '120363000000000001@g.us',
    'approved',
    60 * 24 * 6,
    {
      displayName: 'Northwind Launch',
      sessionId: ids.launchGroup,
      avatar: portrait('#ffe9d6', '#c2571a'),
    },
  ),
  contact(ids.theoContact, 'telegram', 'direct', '7004410021', 'approved', 60 * 24 * 9, {
    displayName: 'Theo Park',
    sessionId: ids.theoChat,
    avatar: portrait('#dbe7ff', '#3b5b9a'),
  }),
  contact(ids.designContact, 'telegram', 'group', '-1002000000000', 'approved', 60 * 24 * 4, {
    displayName: 'Design Team',
    sessionId: ids.designGroup,
    avatar: portrait('#fde2e8', '#b51e49'),
  }),
  contact(
    '5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b',
    'telegram',
    'direct',
    '7001234567',
    'blocked',
    60 * 24 * 4,
    {
      displayName: 'Rowan Hale',
    },
  ),
  contact(
    '6f7a8b9c-0d1e-4f6a-9b7c-8d9e0f1a2b3c',
    'telegram',
    'group',
    '-1003000000000',
    'pending',
    12,
    {
      displayName: 'Northwind Clients',
    },
  ),
  contact(ids.strangerContact, 'whatsapp', 'direct', '4915550100009@c.us', 'pending', 30, {
    message: 'Hi, who is this? Omar gave me this number.',
    avatar: portrait('#fff4d6', '#9a6b1d'),
  }),
];

export const groups: Group[] = [
  {
    type: 'telegram',
    chatId: '-1002000000000',
    name: 'Design Team',
    profiles: [
      { profileId: ids.zero, name: 'Zero Two', contactId: ids.designContact, status: 'approved' },
      {
        profileId: ids.miku,
        name: 'Miku',
        contactId: '4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a',
        status: 'pending',
      },
    ],
  },
];

export const deliveries: Delivery[] = [
  {
    id: ids.runLive,
    profileId: ids.zero,
    channelId: ids.telegram,
    runId: ids.runLive,
    chatId: '7004410021',
    status: 'sent',
    createdAt: at(42),
    updatedAt: at(41),
    remoteMessageIds: [101],
    saidCount: 0,
  },
];

const memory = (
  key: string,
  content: string,
  version: number,
  ago: number,
  links: string[],
  fromConversation = true,
): Memory => ({
  id: `m-${key}`,
  profileId: ids.zero,
  key,
  content,
  version,
  links,
  ...(fromConversation ? { sourceSessionId: ids.gatewayChat } : {}),
  updatedAt: at(ago),
});

/** A profile's notebook with two topics linked inside, and one entry on its own. */
export const memories: Memory[] = [
  memory(
    'owner-preferences',
    'The owner prefers short answers on the phone and the details only when asked. Since March 2026 they want summaries as bullet points.',
    3,
    60 * 24,
    ['owner-schedule'],
  ),
  memory(
    'owner-schedule',
    'Deep work until 11:00; no calls before then. Fridays are for reviews.',
    1,
    60 * 30,
    ['owner-preferences'],
  ),
  memory(
    'project-northwind-launch',
    'Northwind launch: beta opens October 2, public launch October 16. The payment provider review is the open risk.',
    4,
    60 * 5,
    ['team-maya-chen', 'venue-contract'],
  ),
  memory(
    'team-maya-chen',
    'Maya Chen runs the Northwind launch; reach her on WhatsApp. She prefers updates on Fridays.',
    2,
    60 * 26,
    ['project-northwind-launch'],
  ),
  memory(
    'venue-contract',
    'Venue deposit is 30% on signature; cancelling needs 21 days of notice.',
    2,
    60 * 25,
    ['project-northwind-launch'],
    false,
  ),
  memory(
    'webhook-timeouts',
    'Payment webhooks time out on the provider side. We retry 3 times with a 10s timeout and alert past 5 failures an hour.',
    1,
    60 * 2,
    [],
  ),
];

export const providers: Provider[] = [
  {
    id: ids.anthropic,
    name: 'Anthropic',
    kind: 'anthropic',
    credential: 'key',
    authMode: 'api',
    createdAt: at(60 * 24 * 20),
  },
  {
    id: ids.openai,
    name: 'OpenAI',
    kind: 'openai',
    authMode: 'codex',
    createdAt: at(60 * 24 * 3),
  },
];

const model = (id: string, extra: Partial<ProviderModelList['models'][number]> = {}) => ({
  id,
  contextWindow: 400000,
  maxOutputTokens: 64000,
  reasoningEfforts: ['low' as const, 'medium' as const, 'high' as const],
  inputModalities: ['text' as const, 'image' as const],
  known: true,
  ...extra,
});

export const providerModels: Record<string, ProviderModelList> = {
  [ids.anthropic]: {
    providerId: ids.anthropic,
    models: [
      model('claude-sonnet-5', { displayName: 'Claude Sonnet 5' }),
      model('claude-opus-5-5'),
    ],
    fetchedAt: at(60),
    stale: false,
  },
  [ids.openai]: {
    providerId: ids.openai,
    models: [model('gpt-5.6-sol'), model('gpt-5.6-luna', { known: false })],
    fetchedAt: at(60),
    stale: false,
  },
};

export const modelDefaults: ModelDefaults = {
  id: ids.zero,
  profileId: ids.zero,
  updatedAt: at(60 * 24),
  conversation: {
    providerId: ids.anthropic,
    modelId: 'claude-sonnet-5',
    reasoningEffort: 'medium',
  },
  channel: { providerId: ids.anthropic, modelId: 'claude-sonnet-5', reasoningEffort: 'medium' },
  compaction: { providerId: ids.openai, modelId: 'gpt-5.6-luna', reasoningEffort: 'low' },
  image: 'disabled',
  vision: 'disabled',
  audio: 'disabled',
  speech: 'disabled',
  transcription: null,
  sticker: 'disabled',
};

const builtin = (name: string, description: string, enabled = true): BuiltinSkill => ({
  name,
  description,
  instructions: `# ${name}\n\nThe full text ships with the gateway.`,
  enabled,
});

export const builtinSkills: BuiltinSkill[] = [
  {
    name: 'channel-replies',
    description:
      'Use before answering on WhatsApp, Telegram or in a group: plain text only, and short.',
    instructions:
      '# Writing for the channel you are in\n\nA chat app is not a document. Write the way a person texts:\n\n- One idea per message, short\n- **No Markdown**: WhatsApp and Telegram show the asterisks\n- Links on their own line\n\n## In a group\n\n1. Answer only when called by name or mention\n2. Say who you are answering when several people asked\n\n> When in doubt, shorter.\n\n```\nGood: Done, the invoice is in your email.\nBad: **Summary:** I have completed the following steps…\n```',
    enabled: true,
  },
  builtin(
    'about-jian',
    'Use when asked what you are, what Jian is, who made it, where to get it, or why something of yours is not working.',
  ),
  builtin(
    'schedules',
    'Use when asked to remind someone, do something later or at a time, or repeat something.',
  ),
  builtin(
    'media',
    'Use when someone sends an image, voice note, PDF or file, or asks for an image or a voice reply.',
  ),
  builtin(
    'coding-work',
    'Use when asked to read, fix, change or review code, run tests, or work with Git or GitHub.',
  ),
  {
    name: 'machine-tools',
    description:
      'Use before running commands or installing anything: what the machine has and how to install more.',
    instructions:
      '# The machine you run commands on\n\nCommands run in a container with Node, Python and git. Install more for this user only:\n\n```\nnpm install -g <package>\nuv tool install <package>\n```\n\nThere is no `sudo`, and nothing outside `/home/node` survives a restart.',
    enabled: true,
  },
  builtin(
    'discernment-nudge',
    'Use after advice, a draft or an analysis the owner may act on: append two or three specific checks.',
    false,
  ),
];

/** A year of work with a rhythm to it: busy weekdays, quiet weekends, a gap in the middle. */
export const activityCalendar: ActivityDay[] = Array.from({ length: 365 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 8, 24) - index * 86_400_000);
  const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
  const runs = index > 150 && index < 170 ? 0 : weekend ? index % 3 : (index * 7) % 13;

  return { day: day.toISOString().slice(0, 10), runs, tokens: runs * 14_000 };
});

const latestRelease = {
  version: '0.1.0',
  date: '2026-09-29',
  body: 'Welcome to Jian.',
  prerelease: false,
};

/** The relaunched gateway has only its welcome note. */
export const releases = {
  version: '0.1.0',
  notes: [latestRelease],
  unseen: [latestRelease],
};

/** Three stickers the agent kept from its chats, as small WebP images. */
const stickerImages = {
  laugh:
    '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',
  thumbs:
    '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',
  facepalm:
    'UklGRnAIAABXRUJQVlA4WAoAAAAQAAAAfwAAfwAAQUxQSFMDAAABoERb22E5e6vdPYudjGzbtm3byW/ObNu2Geci1txObt9291pduVXv6Kv66vve59coIiaA/p9Z2HX2gx/tPXO1pJq5uuTqmb0fPTC7awEIp+Pmby94rNW78M2mDtI1WvP5TY745merG4qVP/lLl43M/LWkSKK+b5aywaVv9JZm0E9sfGyyJKOSbOXJ2Y4QA0+ytcf7S1D3BY8t9j9sYJuzJMWWl2zNsqpVnAU81NKiyWkWsWyWLTmPeiyk/0KeFS2OsKDJ5ha0v8yiXutsXJ8UC1sy0LBRlSxu9QSjFtxhgd15Bk28wyK7E4zpW8VC1ww0pGOaxS5ub0TLKyz45eYG5CZY9CN50T3Hwj8Z2URfOn9qRC2KWfySVpFkxRngASeKtQxxRQT1UhiK6+t7l0G+rm2gj8Lrr8k5yTCPaprMQMfpiSNJaBnJUIfq2IvlTw19GWzvcG+ieS1UQSmakvwwcxnuzDA/4/k+REMXj1s/2BoGvDrY54i+CeTcRFSeG6QTQ+4XZDOmXUG+xfRtkIuYzgUo9DB5BaquDLqTag6qmaqHUN2v+gjVB6p9qHarzqI6pbqK6rKqDFWJqgZVtSqDKvP3oQZVtaoMVYnqKqrLqjOoTqr2oPpT9RGqD1QPorpPNRvVDFUXVB1VhR4mr0BFFzGdo4DfYPo2yGZMO4J0xNQniHMDUXluEPoM0dcUeDWilcEaunhq6wejn/B8RyHn4JkRpqAUTUl+GHoDzasUujeanuFoN5bfSeNwLIN1UAxJnLRORDJGj3McR5I09/ZQeH110dsoXiXtdVMYiuvpo9UYllGEWYcQ7HOioOYp+dItKdoJvnT+FIr6aekeo8hzYrIlc6Oj5pclu9iUTGx9S65UOzKzT6VU1QPI1FG1MrnjyNx5rkTuXDJ5VIU8VePJ7N63pUkPINPbX5LlYlsyv3lCklhTsjHnUU8K/4VcsnTUTRlSE8jeFgck2NeMbHaW3LItvTWLLK/zQsYm/8P6JGDfo/Yke5OQg3bbEZvskJyDfjIvNoqE7f16iUnpV3uSwPmTv6w1I/PXkiKSuv7qb8qjKvt6VT2SPbf/zu/OeXoy577d0S+HMOZ3nnX/+7tPXympYK4ouXxq9/v3z+yUT//PBABWUDgg9gQAALAfAJ0BKoAAgAA+bS6URaQiohh9bIhABsSxBDgAwhQNYB5k/pvsl6Ezojw3zTd4+Rn9APcz5gH6a9M3zAecJ/oPWH6AHSl+gB4Kvwk/uxlHflH+3fiB29fqAujrqGsB0KcNJ8MOYX/VfUp/Wf9592PsI+nPYC/lX9I6lP7gewT+ySMkMZh1AiVmNWKMwF5H8t+jRT/J3hlRya/wrYc8O7ijnLU0z9e2Uj74ASurN/Yb0sHZwDObmv5mi2SdO/OnH+ybNU53mWD7/hQcTtglAsDqvmDUcbQd23en4tc1TGXXvXOWTKY/et2z4tFxVpIX/2JJ2cym0X6KuE5ymg2RQ2Tu1QphtoAA/tXKBfvIxfZP99adTjoRw1FzV3HsR8HYDxUSOTm5gmMlfFuiVGeODH3aGhlYpcOfmsPlsPoZxCr23dczr23eyK8H8TL+wbp6BdeOIhz/9dbwtX0UVxLbHngceS3IpRQqyoPXlpU3xu2ve8UvsySx0I4aoV6P4Isjbw+Uv0ZpuxMX0UAHMOPM1B8Ir/xcXelTR7uFtjPT6a36jkHSwTuGLgohs+p41fS3zDi7HZvKNUu9WeGTXRtBPIe3cMuOJY0wTgga/bMrgNDGOh8NIF84C0d548/CUNer4/rgzZIplCRDeyzGUodWAJXhXpT1+fNWdt698aWQ8WiX6cPbaBlazLpopERY7GyNUpF2kfGFBfFInntOPzj2EMmpB9fjDGdW3JXhmIyJJTx3lzrIlAzWo8K3DF+jMr1/77iHLt4Wi+79JaDsmiyVwtt7nMzF5Bd2Q8pYUCyX8BU33VpDgirtD1vomnm1jiCqY8+diEt8CO173HYkwlVTu1RV0Dsl9LN/COpXkJj+WWJOySXGLHUnPgwH8wxxDj/7Ou4Mv1ReTvKDf6ovJ3k8APPSsxQZro/wt7lDXx7u8IjV75eVkB24PVf1wPgdJHePT1Bv/4xfmrBdlgrv/G7cSjgLPBjLedX6un+Kf9Sifcq8U/6lE+4m4CySjUAnMCa5gMaiBrSnNDgRJJizBzhmecGI1RyrZDAU3k0TvQTyhX3XwRVOdClAswFjHbHO4mQrH/fbS/CqHu5opC43mltB2MbTGywOsQbPdoTMV/aglrb3YRxficE05ttk/QvwAzCFbXdVCwZoVQDKMYP7iMuIYpnD9Fd5zj/tHuAvzMcDqHM6CegT48nsiFPHqfcM8q0mWBpW296YXvCI4dGzSQQUlolsoHqy7+bUr34fB0W8k2x/YRoBwisRlja09UvxfBsWLy9TusNGmbF9GquzfyeQAyPTyQ/+EtGjXLxRzwks/jq9CiaIxqdsUB6nMiGX2x6HA3v+oKlyDUTrUUOzaWBYkyp5CmQrrtmGJUkOUBfOL3iK9BPQaO8W4D6kRa3+xNGC/0neOF70h+liUzzfoNcYLuyHXKy7p/UsmjFzo0JnN8KhKeiZPZsKf5mCOU8Z+clhqZrmFyhUBgscSClDjk310ywP01MGarUU+dLZP2rUR0sYiXB9RBTTw6h9TtnbG3coRzxygg4aaYkR4JLEcfmuwPSHRh3H7/XhTGpUn3PkH8T/P/E0A9J9eEkz1tLElC0qYfv6nHUwGHa4y8533P0bfX4+Dm56H/UrvKH4wXJFjlTb1fPeZVgzO9FE5o2gGCLaYpPUprypoSb64kPn9mk83UANAkAAAAA=',
};

export const stickers = [
  {
    key: 'laugh',
    description: 'A face laughing so hard it cries',
    tags: ['laughing', 'funny', 'crying'],
    uses: 7,
    seen: 12,
  },
  {
    key: 'thumbs',
    description: 'A thumbs up',
    tags: ['approval', 'ok', 'agree'],
    uses: 3,
    seen: 4,
  },
  {
    key: 'facepalm',
    description: 'Someone facepalming at a mistake',
    tags: ['facepalm', 'mistake', 'embarrassed'],
    uses: 0,
    seen: 1,
  },
].map((item, index) => ({
  id: `5a1c0000-0000-4000-8000-00000000000${index + 1}`,
  profileId: ids.zero,
  description: item.description,
  tags: item.tags,
  uses: item.uses,
  seen: item.seen,
  createdAt: at(60 * 24 * (index + 1)),
  data: stickerImages[item.key as keyof typeof stickerImages],
}));

/** A month of a busy profile, scaled to the period the Overview asks for. */
export const statsFor = (days: number) => {
  const shown = Math.min(days, 90);
  const scale = Math.min(days, 90) / 30;
  const daily = Array.from({ length: shown }, (_, index) => {
    const date = new Date();

    date.setDate(date.getDate() - (shown - 1 - index));

    return {
      day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      tokens: index % 7 === 5 ? 0 : Math.round(180_000 + ((index * 7919) % 11) * 95_000),
    };
  }).filter((item) => item.tokens > 0);

  return {
    since: at(60 * 24 * 41),
    subscriptions: [
      {
        provider: 'codex' as const,
        status: 'available' as const,
        fiveHour: null,
        weekly: { usedPercent: 32, resetsAt: null },
      },
      {
        provider: 'claude' as const,
        status: 'unavailable' as const,
        fiveHour: null,
        weekly: null,
      },
    ],
    totals: {
      turns: 1583,
      workedMs: 139_800_000,
      conversations: 10,
      skillsWritten: 3,
      memories: 6,
    },
    period: {
      days,
      from: at(60 * 24 * days),
      turns: Math.round(412 * scale),
      tokens: {
        input: Math.round(9_400_000 * scale),
        cached: Math.round(21_700_000 * scale),
        output: Math.round(1_180_000 * scale),
      },
      cost: Math.round(48.37 * scale * 100) / 100,
      unpricedTokens: Math.round(6_200_000 * scale),
      activeDays: daily.length,
      daily,
    },
    models: [
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        billing: 'metered',
        turns: Math.round(318 * scale),
        tokens: {
          input: Math.round(7_900_000 * scale),
          cached: Math.round(18_300_000 * scale),
          output: Math.round(930_000 * scale),
        },
        cost: Math.round(48.37 * scale * 100) / 100,
      },
      {
        provider: 'openai-codex',
        modelId: 'gpt-5-codex',
        billing: 'subscription',
        turns: Math.round(94 * scale),
        tokens: {
          input: Math.round(1_500_000 * scale),
          cached: Math.round(3_400_000 * scale),
          output: Math.round(250_000 * scale),
        },
        cost: null,
      },
    ],
    channels: [
      {
        channel: 'whatsapp',
        conversations: 4,
        turns: Math.round(201 * scale),
        tokens: Math.round(15_800_000 * scale),
      },
      {
        channel: 'gateway',
        conversations: 1,
        turns: Math.round(96 * scale),
        tokens: Math.round(9_900_000 * scale),
      },
      {
        channel: 'telegram',
        conversations: 2,
        turns: Math.round(71 * scale),
        tokens: Math.round(4_300_000 * scale),
      },
      {
        channel: 'agent',
        conversations: 1,
        turns: Math.round(29 * scale),
        tokens: Math.round(1_900_000 * scale),
      },
      {
        channel: 'learning',
        conversations: 1,
        turns: Math.round(15 * scale),
        tokens: Math.round(380_000 * scale),
      },
    ],
    tools: [
      { name: 'web_search', calls: Math.round(212 * scale), failed: 3 },
      { name: 'read_memories', calls: Math.round(187 * scale), failed: 0 },
      { name: 'run_command', calls: Math.round(143 * scale), failed: 9 },
      { name: 'send_session_message', calls: Math.round(64 * scale), failed: 1 },
      { name: 'fetch_url', calls: Math.round(58 * scale), failed: 4 },
      { name: 'remember', calls: Math.round(41 * scale), failed: 0 },
      { name: 'create_schedule', calls: Math.round(12 * scale), failed: 0 },
      { name: 'send_sticker', calls: Math.round(9 * scale), failed: 0 },
    ],
  };
};
