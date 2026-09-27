import type { Message, Person, Run, Session, ToolStep } from '../lib/api';
import { type AssetKey, mediaId, portrait } from './media';

/**
 * The example conversations, one per situation the Sessions screen has to handle, written as
 * scripts: who said what, with which attachments, and which tools the agent used to answer.
 * Every name, number and company in them is invented.
 */

export const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 8, 24, 12) - minutesAgo * 60_000).toISOString();

const uuid = (prefix: string, index: number) =>
  `${prefix}-0000-4000-8000-${String(index).padStart(12, '0')}`;

type Author = { id: string; name?: string };
type Tool = {
  name: string;
  /** Seconds it took. */
  took: number;
  error?: string;
  status?: ToolStep['status'];
};
type Turn = {
  from: 'user' | 'agent';
  text?: string;
  media?: AssetKey[];
  author?: Author;
  tools?: Tool[];
  /** Minutes before the stories' "now". */
  ago: number;
};

const user = (ago: number, text: string, media?: AssetKey[], author?: Author): Turn => ({
  from: 'user',
  ago,
  text,
  ...(media ? { media } : {}),
  ...(author ? { author } : {}),
});
const agent = (ago: number, text: string, tools?: Tool[], media?: AssetKey[]): Turn => ({
  from: 'agent',
  ago,
  text,
  ...(tools ? { tools } : {}),
  ...(media ? { media } : {}),
});
const tool = (name: string, took: number, error?: string): Tool => ({
  name,
  took,
  ...(error ? { error, status: 'failed' as const } : {}),
});

let messageCount = 0;
let runCount = 0;

export const messages: Message[] = [];
export const timelines: Record<string, Array<{ runId: string; steps: ToolStep[] }>> = {};

/** Writes a script into messages and timelines, as the gateway would have stored them. */
function script(profileId: string, sessionId: string, turns: Turn[]) {
  for (const turn of turns) {
    const runId = turn.from === 'agent' ? uuid('66b4c0ba', ++runCount) : undefined;
    const content = [
      turn.author ? `${turn.author.name ?? turn.author.id}: ${turn.text ?? ''}` : turn.text,
      ...(turn.media ?? []).map((key) => `[Attached media: ${mediaId(key)}]`),
    ]
      .filter(Boolean)
      .join('\n');

    messages.push({
      id: uuid('a1000000', ++messageCount),
      profileId,
      sessionId,
      ...(runId ? { runId } : {}),
      role: turn.from === 'agent' ? 'assistant' : 'user',
      content,
      ...(turn.author ? { author: turn.author } : {}),
      createdAt: at(turn.ago),
    });

    if (runId && turn.tools?.length) {
      const total = turn.tools.reduce((sum, item) => sum + item.took + 0.4, 0);
      let clock = Date.parse(at(turn.ago)) - total * 1000;

      timelines[sessionId] = [
        ...(timelines[sessionId] ?? []),
        {
          runId,
          steps: turn.tools.map((item, index) => {
            const startedAt = new Date(clock).toISOString();

            clock += item.took * 1000;
            const step: ToolStep = {
              toolCallId: `${runId}-${index}`,
              toolName: item.name,
              status: item.status ?? 'done',
              startedAt,
              finishedAt: new Date(clock).toISOString(),
              ...(item.error ? { error: item.error } : {}),
            };

            clock += 400;
            return step;
          }),
        },
      ];
    }
  }
}

/** The list's last line for a session, as the gateway computes it. */
export const lastMessageOf = (sessionId: string): Session['lastMessage'] => {
  const last = messages.filter((message) => message.sessionId === sessionId).at(-1);

  return last
    ? {
        role: last.role,
        text: last.content
          .replace(/\[Attached media: [0-9a-f-]{36}\]/g, '📎')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 200),
        at: last.createdAt,
      }
    : undefined;
};

export const ids = {
  zero: '5c52c291-4620-4829-aa8b-6adf08d8c833',
  miku: '8f41c4e7-cb7e-49ae-a0f0-e75956d4975e',
  gatewayChat: '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a',
  mayaChat: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
  launchGroup: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c',
  theoChat: '8b9e13a2-fe34-49fe-9409-4c16e4fe1055',
  designGroup: 'a07e6f2a-b9ff-483e-ab3a-f7d05b1af092',
  peerChat: '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f',
  planningChat: '04a28114-545a-41b7-ba17-8673134b85d1',
  reportChat: '4e5f6a7b-8c9d-4e0f-9a1b-3c4d5e6f7a8b',
  emptyChat: '6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d',
  learning: '7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e',
  runLive: '66b4c0ba-1111-4a4a-8a8a-000000000002',
  runFailed: '66b4c0ba-1111-4a4a-8a8a-000000000003',
};

const zero = ids.zero;

/* The owner and Zero Two, in the one conversation the panel writes in. */
script(zero, ids.gatewayChat, [
  user(60 * 26, 'Morning! What is on my plate today?'),
  agent(
    60 * 26 - 1,
    'Three things: the Northwind beta review at 10:00, the venue deposit due by 18:00, and Maya is waiting on the launch plan. Want me to start with the deposit?',
    [tool('read_memories', 0.4), tool('list_contacts', 0.6)],
  ),
  user(60 * 25, 'Yes. Here is the contract they sent.', ['contract']),
  agent(
    60 * 25 - 2,
    'Read it. The deposit is 30% on signature and cancelling needs 21 days of notice. Nothing unusual. I saved both terms so we can hold them to it.',
    [tool('analyze_media', 4.2), tool('remember', 0.3)],
  ),
  user(60 * 6, '', ['ownerVoice']),
  agent(
    60 * 6 - 1,
    'Got your voice note: move the beta review to Thursday and tell Maya. Done both. She already confirmed on WhatsApp.',
    [tool('analyze_media', 3.1), tool('message_contact', 1.2)],
  ),
  user(60 * 3, 'Compare these two and tell me which one reads better on a phone.', [
    'storefront',
    'dashboard',
    'notes',
  ]),
  agent(
    60 * 3 - 2,
    'The storefront mockup reads better: bigger type and one clear action. The dark dashboard packs four charts into the first screen and the labels drop below 12px. The release notes match the storefront copy, except "Sessions as a messenger", which the page calls "Inbox".',
    [
      tool('analyze_media', 3.4),
      tool('analyze_media', 3.9),
      tool('search_files', 0.8, 'site/: no such directory'),
      tool('read_file', 0.3),
    ],
  ),
  user(60 * 2, 'The payment webhook is failing again, log attached.', ['pasted']),
  agent(
    60 * 2 - 3,
    'Seven timeouts in an hour, all on worker-0, each exactly 30s. That is the provider hanging, not our code: the same worker processes every other job fine. I opened a ticket with them and added a retry with a 10s timeout on our side so the queue stops backing up.\n\nWhat changed:\n- Webhook timeout 30s → 10s\n- Up to 3 retries, 2s apart\n- An alert when more than 5 fail in an hour',
    [
      tool('read_file', 0.2),
      tool('search_files', 0.5),
      tool('web_search', 2.6),
      tool('fetch_url', 1.4),
      tool('edit_file', 0.4),
      tool('run_command', 9.2),
    ],
  ),
  user(
    60 * 4,
    '[Scheduled: Morning summary] Send me a summary of yesterday and what is due today.',
  ),
  agent(
    60 * 4 - 1,
    'Good morning. Yesterday: the venue contract is read and saved, and Maya confirmed Thursday. Today: the deposit is due by 18:00 and the payment review is still open.',
    [tool('search_history', 1.1), tool('read_memories', 0.4)],
  ),
  user(62, 'Can you send me a summary as audio? I am driving.'),
  agent(
    61,
    'Here it is, under a minute.',
    [tool('list_speech_voices', 0.3), tool('generate_speech', 5.8)],
    ['agentVoice'],
  ),
  user(30, 'Venue options from the scout, pick the best for 120 people.', [
    'venue1',
    'venue2',
    'venue3',
    'venue4',
    'venue5',
    'venue6',
  ]),
  agent(
    28,
    'The hall (first photo). It seats 120 with room for the stage, the lobby works for registration, and it is the only one with parking on site. The patio is lovely but fits 60.',
    [tool('analyze_media', 2.1), tool('analyze_media', 1.9), tool('read_file', 0.2)],
  ),
]);

/* WhatsApp, one person: voice notes both ways, a photo and a document from her. */
script(zero, ids.mayaChat, [
  user(60 * 30, 'Hi! Is the launch still October 16?'),
  agent(60 * 30 - 1, 'Still October 16. The beta opens on the 2nd.'),
  user(60 * 29, 'Great. Sending the updated plan.', ['launchPlan']),
  agent(
    60 * 29 - 1,
    'Thanks, Maya. I read it: the only new risk is the payment review. I will keep an eye on it.',
    [tool('analyze_media', 5.2)],
  ),
  user(60 * 7, '', ['mayaVoice']),
  agent(60 * 7 - 1, 'Heard you. I will send the receipt to finance today.'),
  user(60 * 7 - 3, 'Here it is', ['receipt']),
  agent(60 * 6 - 5, 'The beta review moved to Thursday, same time.', undefined, ['agentVoice']),
  user(60 * 6 - 8, 'Perfect, thanks 🙏'),
]);

/* WhatsApp group: people with and without names or pictures, and the agent called in. */
const launch = {
  maya: { id: '4915550100001@c.us', name: 'Maya Chen' },
  omar: { id: '4915550100002@c.us', name: 'Omar Haddad' },
  unnamed: { id: '4915550100003@c.us' },
  hidden: { id: '208871365117952@lid' },
};

script(zero, ids.launchGroup, [
  user(60 * 5, 'Poster v2 is up, thoughts?', ['poster'], launch.omar),
  user(60 * 5 - 1, 'Love the colours', undefined, launch.maya),
  user(60 * 5 - 2, 'The date is too small on mobile', undefined, launch.maya),
  user(60 * 5 - 4, 'Agree with Maya', undefined, launch.unnamed),
  user(60 * 4, '@Zero Two can you check the print budget against this?', undefined, launch.omar),
  agent(
    60 * 4 - 1,
    'Printing is budgeted at 320. Poster v2 at A2 for 40 copies comes to about 290, so it fits with a little room.',
    [tool('read_file', 0.2), tool('web_search', 2.2)],
  ),
  user(60 * 4 - 3, '', ['memberVoice'], launch.hidden),
  user(
    60 * 4 - 5,
    '[Reacted 😂 to your message: "Printing is budgeted at 320. Poster v2 at A2 for 40 copies comes to about 290, so it fits with a little room."]',
    undefined,
    launch.maya,
  ),
  user(
    60 * 4 - 5.5,
    `I thought it was a tech ant\n[File not opened, it was not sent to you: image/png, media ID ${mediaId('poster')}. Open it with analyze_media if it matters.]`,
    undefined,
    launch.maya,
  ),
  user(
    60 * 4 - 6,
    '[Replying to your message: "Printing is budgeted at 320. Poster v2 at A2 for 40 copies comes to about 290, so it fits with a little room."]\nAnd at A1?',
    undefined,
    launch.omar,
  ),
]);

/* Telegram, one person, with the agent working right now. */
script(zero, ids.theoChat, [
  user(60 * 50, 'Can you remind me what we decided about the pricing page?'),
  agent(60 * 50 - 1, 'Two tiers instead of three, and the annual discount goes from 15% to 20%.', [
    tool('search_history', 0.9),
  ]),
  user(3, 'Look up what the competitors charge for the team tier'),
]);

/* Telegram group with a long back-and-forth. */
const design = {
  iris: { id: '5001', name: 'Iris Vale' },
  jonah: { id: '5002', name: 'Jonah Reyes' },
  guest: { id: '5003' },
};

script(zero, ids.designGroup, [
  user(60 * 20, 'Does anyone know if the release ships today?', undefined, design.iris),
  user(60 * 20 - 1, 'I need to tell the client', undefined, design.iris),
  user(60 * 19, 'I think so, QA is the only thing left', undefined, design.jonah),
  user(60 * 18, 'I can test now if that helps', undefined, design.guest),
  user(60 * 17, '@ZeroTwoBot does the release ship today?', undefined, design.iris),
  agent(60 * 17 - 1, 'Tonight, Iris. QA wraps at 18:00 and I will post here when it is out.', [
    tool('list_activities', 0.4),
    tool('read_memories', 0.3),
  ]),
  user(60 * 16, 'Here is the final dashboard', ['dashboard', 'storefront'], design.jonah),
  user(60 * 15, 'haha nice', undefined, design.iris),
]);

/* Another agent of this installation, asking for a hand. */
script(zero, ids.peerChat, [
  user(60 * 31, 'Could you review PR #325 when you have a moment? It touches the webhook retries.'),
  agent(
    60 * 30,
    'Reviewed. Two notes: the retry loop ignores the abort signal, and the new timeout is not in the config docs. Otherwise good to merge.',
    [tool('ask_agent', 6.4), tool('read_file', 0.3)],
  ),
]);

/*
 * Then Zero Two carried a question to Miku: here Zero Two only asks, and Miku is the one who
 * works, with tools kept in Miku's own profile and session.
 */
const mikuThread = '3d4e5f6a-7b8c-4d9e-8f0a-2b3c4d5e6f7a';
const mikuRun = uuid('66b4c0ba', 900);
const call = { profileId: ids.miku, sessionId: mikuThread, runId: mikuRun };

messages.push(
  {
    id: uuid('a1000000', 900),
    profileId: zero,
    sessionId: ids.peerChat,
    runId: uuid('66b4c0ba', 901),
    role: 'assistant',
    content:
      'Hi Miku, Zero Two here. Rowan asks for a memory clean-up now that memories can be deleted: drop duplicates and stale status, and link what belongs together. No need to report back.',
    call,
    createdAt: at(12),
  },
  {
    id: uuid('a1000000', 901),
    profileId: zero,
    sessionId: ids.peerChat,
    runId: uuid('66b4c0ba', 901),
    role: 'user',
    content: 'Done, Zero Two. **9 duplicates** removed and 4 memories linked.',
    call,
    createdAt: at(10),
  },
);
timelines[mikuThread] = [
  {
    runId: mikuRun,
    steps: ['read_memories', 'forget_memory', 'forget_memory', 'link_memories'].map(
      (toolName, index) => ({
        toolCallId: `${mikuRun}-${index}`,
        toolName,
        status: 'done' as const,
        startedAt: at(12 - index * 0.3),
        finishedAt: at(12 - index * 0.3 - 0.2),
      }),
    ),
  },
];

/* Where Zero Two looks back on its work: one look that kept a skill, one that kept nothing. */
script(zero, ids.learning, [
  user(
    60 * 25,
    '[Learning] Looking back at a turn with 33 tool calls: "Nightly report for 2026-09-23."\nThis is your own review, not a message from anyone.',
  ),
  agent(
    60 * 25 - 1,
    'Kept **nightly-report** as a skill: the checks in the order that found the queue peak, and the format Rowan asked for last week.',
    [tool('create_skill', 0.4)],
  ),
  user(
    60 * 3,
    '[Learning] Looking back at the last 15 turns: "Could you review PR #325?"\nThis is your own review, not a message from anyone.',
  ),
  agent(60 * 3 - 1, 'Nothing to keep.'),
]);

/* API Server: a scripted report in Markdown behind many tools, and a request that failed. */
script(zero, ids.reportChat, [
  user(60 * 26 + 5, 'Nightly report for 2026-09-23.', ['config', 'statusPage', 'retryJob']),
  agent(
    60 * 26,
    [
      '## Nightly report',
      'No alerts. The canary held at **5%** with no errors, and backups finished in 4 minutes.',
      '| Region | Replicas | p95 |\n|---|---|---|\n| eu-west | 3 healthy | 182 ms |\n| us-east | 2 healthy | 211 ms |',
      'Two things to watch:\n- the `orders` queue peaked at 1,204 jobs at 02:10\n- disk on `db-2` is at *81%*, see https://status.example.com/db-2',
      '```\ndf -h /var/lib/postgresql\n```',
    ].join('\n\n'),
    [
      ...Array.from({ length: 12 }, (_, index) => tool('run_command', 0.6 + (index % 4) * 0.5)),
      ...Array.from({ length: 8 }, () => tool('fetch_url', 1.1)),
      ...Array.from({ length: 12 }, (_, index) => tool('read_file', 0.2 + (index % 3) * 0.1)),
      tool('send_session_message', 0.4, 'The session is busy; the message waits in its inbox.'),
    ],
  ),
]);

script(zero, ids.planningChat, [
  user(60 * 4 + 2, 'Summarise the week for the Monday update.', ['budget']),
]);

/** Who wrote in each group, with the pictures their channel shows. */
export const people: Record<string, Person[]> = {
  [ids.launchGroup]: [
    { ...launch.maya, avatar: portrait('#e6f4ea', '#2f7a52') },
    { ...launch.omar, avatar: portrait('#fff1d6', '#a86b12') },
    launch.unnamed,
    launch.hidden,
  ],
  [ids.designGroup]: [
    { ...design.iris, avatar: portrait('#fde2e8', '#b51e49') },
    { ...design.jonah, avatar: portrait('#dbe7ff', '#3b5b9a') },
    design.guest,
  ],
};

/* The turn Theo is waiting on: one tool done, the web search still going. */
timelines[ids.theoChat] = [
  ...(timelines[ids.theoChat] ?? []),
  {
    runId: ids.runLive,
    steps: [
      {
        toolCallId: 'live-0',
        toolName: 'search_history',
        status: 'done',
        startedAt: at(2.5),
        finishedAt: at(2.4),
      },
      {
        toolCallId: 'live-1',
        toolName: 'web_search',
        status: 'running',
        startedAt: at(1),
      },
    ],
  },
];

/** Runs whose state the conversations show: one working now, one that failed. */
export const runs: Run[] = [
  {
    id: ids.runLive,
    profileId: zero,
    sessionId: ids.theoChat,
    requestKey: 'live',
    input: 'Look up what the competitors charge for the team tier',
    status: 'running',
    createdAt: at(3),
    updatedAt: at(1),
    progress: { phase: 'tool', tool: 'web_search', text: '', steps: 2, updatedAt: at(1) },
  },
  {
    id: ids.runFailed,
    profileId: zero,
    sessionId: ids.planningChat,
    requestKey: 'failed',
    input: 'Summarise the week for the Monday update.',
    status: 'failed',
    error: 'The provider key is not configured. Add one under Providers.',
    createdAt: at(60 * 4),
    updatedAt: at(60 * 4),
  },
];
