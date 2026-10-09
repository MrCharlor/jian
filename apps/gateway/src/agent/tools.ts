import {
  agentCallSchema,
  decisionUseSchema,
  memoryKeySchema,
  memorySchema,
  type Run,
  spawnSubagentSchema,
  workInputSchema,
  workPatchSchema,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Applications } from '../applications/service.js';
import { Coordination } from '../coordination/service.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Decisions, Question } from '../decisions/service.js';
import type { Outreach } from '../errands/port.js';
import { sameSubject } from '../memories/duplicates.js';
import type { MemoryWriter } from '../memories/port.js';
import type { PeerAgents } from '../peers/port.js';
import type { ProfileAdmin } from '../profiles/port.js';
import type { Prototypes } from '../prototypes/service.js';
import type { RunExecution, RunReader } from '../runs/port.js';
import type { Schedules } from '../schedules/service.js';
import type { SessionNamer, SessionReader, SessionSummarizer } from '../sessions/port.js';
import { findSkill } from '../skills/builtin/index.js';
import { skillTools } from '../skills/tools.js';
import type { SshKeys } from '../ssh/service.js';
import type { Stats } from '../stats/service.js';
import type { Store } from '../storage/database.js';
import { artifacts, checkpoints } from '../storage/schema.js';
import type { Work } from '../tasks/service.js';
import { artifactPage } from './results.js';
import { shellTools } from './shell.js';

/** What the tool set reaches for on the profile's behalf during a run. */
const jevQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z.object({ yes: z.string().min(1).max(600), no: z.string().min(1).max(600) }),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z
      .object({})
      .catchall(z.string().max(600).nullable())
      .refine(
        (criteria) =>
          Object.keys(criteria).length >= 2 &&
          Object.keys(criteria).length <= 20 &&
          Object.keys(criteria).every((key) => key.length >= 1 && key.length <= 100),
        'choice needs between two and twenty alternatives with keys of at most 100 characters',
      ),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z.array(z.string().min(1).max(600)).min(2).max(20),
  }),
]);

const jevInputSchema = z.object({
  use: decisionUseSchema,
  state: z
    .object({})
    .catchall(z.unknown())
    .refine(
      (state) =>
        Object.keys(state).every((key) => key.length <= 100) &&
        JSON.stringify(state).length <= 24_000,
      'state keys must be at most 100 characters and the state must fit within 24000 characters',
    ),
  question: jevQuestionSchema,
});

export type ToolServices = {
  profiles: ProfileAdmin;
  memories: MemoryWriter;
  sessions: SessionReader & SessionNamer & SessionSummarizer;
  runs: RunReader;
  peers: PeerAgents;
  lifecycle: RunExecution;
  errands: Outreach;
  store: Store;
  decisions?: Pick<Decisions, 'ask' | 'judge'>;
  schedules?: Pick<Schedules, 'list' | 'create' | 'update' | 'remove'>;
  settings?: { timeZone(): Promise<string> };
  stats?: Pick<Stats, 'stats' | 'usageRuns'>;
  work?: Pick<Work, 'list' | 'createWithExecutor' | 'update' | 'spawn' | 'executions'>;
  sshKeys: Pick<SshKeys, 'list' | 'create' | 'remove'>;
  applications?: Pick<Applications, 'list' | 'brief' | 'readForAgent'>;
  prototypes?: Pick<Prototypes, 'create' | 'get' | 'redo'>;
};

export function profileTools(
  services: ToolServices,
  run: Run,
  gitAccess: { readOnly: string[]; writable: string[] } = { readOnly: [], writable: [] },
): ToolSet {
  const coordination = new Coordination(services);
  const rechecked = new Set<string>();

  const tools: ToolSet = {
    list_ssh_keys: tool({
      description:
        'List this profile’s SSH keys. Returns names, public keys and fingerprints only; private keys never leave the workspace.',
      inputSchema: z.object({}),
      execute: async () => services.sshKeys.list(run.profileId),
    }),

    create_ssh_key: tool({
      description:
        'Create an Ed25519 SSH key for this profile through Jian. Never use ssh-keygen or create SSH keys through the shell.',
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
      execute: async ({ name }) => services.sshKeys.create(run.profileId, { name }),
    }),

    delete_ssh_key: tool({
      description:
        'Delete one of this profile’s SSH keys. List the keys first and use the returned id.',
      inputSchema: z.object({ id: z.uuid() }),
      execute: async ({ id }) => services.sshKeys.remove(run.profileId, id),
    }),

    list_activities: tool({
      description: 'Read the actual queued/running tasks across this profile’s sessions.',
      inputSchema: z.object({}),
      execute: async () =>
        (await services.runs.activities(run.profileId)).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status,
          input: r.input.slice(0, 500),
          updatedAt: r.updatedAt,
        })),
    }),

    ...(services.work
      ? {
          list_tasks: tool({
            description:
              'Read your durable work board across conversations. These are commitments you maintain, not live runs or timed schedules.',
            inputSchema: z.object({}),
            execute: async () => {
              const items = await services.work?.list(run.profileId);
              return run.subagent ? items?.filter((item) => item.id === run.workItemId) : items;
            },
          }),
          ...(!run.subagent
            ? {
                create_task: tool({
                  description:
                    'Create a durable task and start its executor. First check for an existing task. Include the objective, source links/IDs, known state, acceptance criteria, and exact remaining actions in the description. For code work, list absolute Git repository roots in repositories; each worker gets its own detached worktree from committed HEAD. Do not repeat the executor’s work yourself.',
                  inputSchema: workInputSchema,
                  execute: async (input, options) =>
                    services.work?.createWithExecutor(run, input, options.toolCallId),
                }),
              }
            : {}),
          update_task: tool({
            description:
              'Move a task or leave a progress/handoff note. Use the version from list_tasks; stale updates conflict. Commit and push code before marking done: worker workspaces are removed after all workers finish. Move to review only when independent review is needed; otherwise mark verified work done before your final report.',
            inputSchema: z.object({ id: z.uuid(), ...workPatchSchema.shape }),
            execute: async ({ id, ...patch }) =>
              services.work?.update(run.profileId, id, patch, run),
          }),
          ...(!run.subagent
            ? {
                spawn_subagent: tool({
                  description:
                    'Start an anonymous, isolated task worker with its own identity and brief. It is a queued run, not an agent profile. An executor moves to review when independent review is needed, or marks verified work done directly. This returns immediately; inspect task workers later.',
                  inputSchema: spawnSubagentSchema,
                  execute: async (input, options) =>
                    services.work?.spawn(run, input, options.toolCallId),
                }),
                list_task_subagents: tool({
                  description: 'Read the runs and outcomes of workers assigned to a task.',
                  inputSchema: z.object({ taskId: z.uuid() }),
                  execute: async ({ taskId }) => services.work?.executions(run.profileId, taskId),
                }),
              }
            : {}),
        }
      : {}),

    ...(services.stats
      ? {
          read_activity_stats: tool({
            description:
              'Read your own complete activity and token usage for a period: totals, estimated cost, models, channels and tools. Includes the shared Codex/Claude subscription windows when available; unavailable is not zero remaining. Subscription tokens are not money spent.',
            inputSchema: z.object({ days: z.number().int().min(1).max(3660).default(30) }),
            execute: async ({ days }) => services.stats?.stats(run.profileId, { days }, true),
          }),
          read_usage_runs: tool({
            description:
              'Page through your own individual runs, with model, channel, duration, fresh/cached/output tokens and estimated metered cost in USD. No message text or secrets are returned.',
            inputSchema: z.object({
              days: z.number().int().min(1).max(3660).default(30),
              limit: z.number().int().min(1).max(50).default(25),
              offset: z.number().int().min(0).default(0),
            }),
            execute: async ({ days, limit, offset }) =>
              services.stats?.usageRuns(run.profileId, days, limit, offset),
          }),
        }
      : {}),

    read_memories: tool({
      description:
        'Find shared memories, with their versions and what each is linked to. Give a few words of the subject to search; with none, the most recent. Search before remember, and update the memory you find instead of writing a near-duplicate.',
      inputSchema: z.object({ query: z.string().max(200).optional() }),
      execute: async ({ query }) => services.memories.search(run.profileId, query ?? ''),
    }),

    remember: tool({
      description:
        'Save a fact or decision shared by all sessions of this profile. Use expectedVersion=0 for a new key, or the current version for an update.',
      inputSchema: memorySchema,
      execute: async (input) => {
        // Checked once per key and turn: an agent told of a near-duplicate that saves again
        // under the same key has read the other memory and decided they differ.
        if (input.expectedVersion === 0 && services.decisions && !rechecked.has(input.key)) {
          rechecked.add(input.key);

          const existing = await sameSubject(
            services.decisions.judge,
            services.memories,
            run.profileId,
            input,
          );

          if (existing) {
            return {
              held: `Not saved: the memory ${JSON.stringify(existing.key)} (version ${existing.version}) looks like the same subject. Update it with that key and version instead. If the two are truly different, call remember again with the same key to save this one.`,
              existing: { key: existing.key, version: existing.version, content: existing.content },
            };
          }
        }

        return services.memories.remember(run.profileId, input, run.sessionId);
      },
    }),

    ...(services.applications ? designTools(services.applications) : {}),
    ...(services.prototypes ? prototypeTools(services.prototypes, run) : {}),

    ...(services.schedules
      ? scheduleTools(services.schedules, run, () =>
          services.settings ? services.settings.timeZone() : Promise.resolve(gatewayTimeZone()),
        )
      : {}),

    forget_memory: tool({
      description:
        'Delete one of your memories, and its links, when it is wrong, superseded, or merged into another. It cannot be undone.',
      inputSchema: z.object({ key: memoryKeySchema }),
      execute: async ({ key }) => services.memories.forget(run.profileId, key),
    }),

    link_memories: tool({
      description:
        'Link two memories about the same subject, or worth recalling together: whenever one is relevant to a request, the other is recalled with it. Links go both ways.',
      inputSchema: z.object({ key: memoryKeySchema, with: memoryKeySchema }),
      execute: async (input) => services.memories.link(run.profileId, input.key, input.with),
    }),

    unlink_memories: tool({
      description: 'Undo a link between two memories that no longer belong together.',
      inputSchema: z.object({ key: memoryKeySchema, from: memoryKeySchema }),
      execute: async (input) => services.memories.unlink(run.profileId, input.key, input.from),
    }),

    list_sessions: tool({
      description: 'Find other conversations belonging to this profile.',
      inputSchema: z.object({}),
      execute: async () => services.sessions.sessions(run.profileId),
    }),

    read_session: tool({
      description: 'Read recent messages in one of this profile’s sessions.',
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      execute: async ({ sessionId }) =>
        (await services.sessions.messages(run.profileId, sessionId, 20)).map((m) => ({
          role: m.role,
          content: m.content.slice(0, 2000),
          createdAt: m.createdAt,
        })),
    }),

    load_skill: tool({
      description: 'Load instructions for a skill enabled on this profile.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = findSkill(run.profile, name);

        if (!skill) {
          throw new GatewayError(404, 'Skill not found');
        }

        return skill;
      },
    }),

    ask_jev: tool({
      description:
        'Ask Jev for one narrow semantic judgment. It returns a probability, choice or score as a second opinion; unavailable means use the fixed rule.',
      inputSchema: jevInputSchema,
      execute: async ({ use, state, question }) => {
        if (!services.decisions) {
          return { available: false, reason: 'Jev is not configured in this gateway.' };
        }

        const normalized: Question =
          question.type === 'noul'
            ? {
                ...question,
                criteria: { true: question.criteria.yes, false: question.criteria.no },
              }
            : question;
        const answers = await services.decisions.judge(state, { judgment: normalized }, { use });
        const answer = answers?.judgment;

        return answer ? { available: true, answer } : { available: false };
      },
    }),

    search_history: tool({
      description: 'Search paginated conversation history for this profile.',
      inputSchema: z.object({
        sessionId: z.string().uuid().optional(),
        before: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(20).default(10),
        q: z.string().trim().min(1).max(200).optional(),
      }),
      execute: async ({ sessionId, ...query }) => {
        const page = await coordination.history(run.profileId, sessionId, query);

        // Where another agent answered is the panel's to show; to this agent it is the other
        // side of the wall, so its ids never reach the model.
        return { ...page, items: page.items.map(({ call: _call, ...message }) => message) };
      },
    }),

    read_artifact: tool({
      description: 'Read a bounded page of a stored tool result by artifact id.',
      inputSchema: z.object({
        artifactId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(16000).default(16000),
      }),
      execute: async ({ artifactId, offset, limit }) => {
        // The profile in the where clause is the owner check: another profile's artifact is
        // not found rather than read, whatever id the model guesses.
        const [record] = await services.store.db
          .select({ content: artifacts.content })
          .from(artifacts)
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.profileId, run.profileId)))
          .limit(1);

        const { content } = assertFound(record, 'Artifact');
        return artifactPage(content, offset, limit, run);
      },
    }),

    read_run_checkpoints: tool({
      description:
        'Inspect saved results before continuing a run; unknown external effects require reconciliation.',
      inputSchema: z.object({ runId: z.string().uuid() }),
      execute: async ({ runId }) => {
        // Reading the run first is the owner check: a run of another profile is not found, so
        // its checkpoints are never selected.
        await services.runs.run(run.profileId, runId);

        const saved = await services.store.db
          .select({
            id: checkpoints.id,
            data: checkpoints.data,
            createdAt: checkpoints.createdAt,
          })
          .from(checkpoints)
          .where(and(eq(checkpoints.profileId, run.profileId), eq(checkpoints.runId, runId)))
          .orderBy(desc(checkpoints.createdAt))
          .limit(100);

        return saved.map((checkpoint) => {
          const data =
            checkpoint.data && typeof checkpoint.data === 'object'
              ? (checkpoint.data as Record<string, unknown>)
              : {};

          return {
            id: checkpoint.id,
            createdAt: checkpoint.createdAt.toISOString(),
            phase: data.phase,
            toolName: data.toolName,
            toolCallId: data.toolCallId,
            finishReason: data.finishReason,
            usage: data.usage,
            tools: Array.isArray(data.tools)
              ? data.tools.map((item: unknown) => {
                  const tool = item as Record<string, unknown>;

                  return {
                    toolName: tool.toolName,
                    toolCallId: tool.toolCallId,
                    artifactId: tool.artifactId,
                    bytes: tool.bytes,
                    result: tool.result,
                  };
                })
              : undefined,
          };
        });
      },
    }),

    send_session_message: tool({
      description:
        'Write text into another of your conversations. A WhatsApp or Telegram conversation — a person or an approved group — receives it on that channel, as a message from you; any other session gets it in its inbox. Text only: to send a file, a sticker, an image or a voice note there, use send_file, send_sticker, generate_image or generate_speech with its sessionId. Idempotent by requestKey.',
      inputSchema: z.object({
        toSessionId: z.string().uuid(),
        text: z.string().trim().min(1).max(4000),
        requestKey: z.string().min(1).max(120),
      }),
      execute: async (input) => {
        // A channel conversation is a person on a phone: an inbox there is read by nobody, and
        // reporting it as sent is how an agent came to promise messages that never left.
        const sent = await services.errands.write(
          run.profileId,
          input.toSessionId,
          run.id,
          input.text,
          input.requestKey,
        );

        if (sent) {
          return { delivered: 'queued on the channel', ...sent };
        }

        return {
          delivered: 'inbox only — this session has no channel',
          ...(await coordination.send(run.profileId, { ...input, fromSessionId: run.sessionId })),
        };
      },
    }),

    list_contacts: tool({
      description:
        'The people this profile may write to on its channels: their id, name and where they are reached. Approved by the owner, never by you.',
      inputSchema: z.object({}),
      execute: async () => services.errands.reachable(run.profileId),
    }),

    message_contact: tool({
      description:
        'Write to one of this profile’s approved contacts on their own channel. With expectReply, their answer comes back to this conversation instead of theirs — say so to whoever asked, because it will not arrive in this turn.',
      inputSchema: z.object({
        contactId: z.string().uuid(),
        text: z.string().trim().min(1),
        expectReply: z.boolean().default(false),
      }),
      execute: async ({ contactId, text, expectReply }) =>
        services.errands.ask(run.profileId, contactId, run.sessionId, run.id, text, expectReply),
    }),

    read_inbox: tool({
      description: 'Read messages sent to this session.',
      inputSchema: z.object({}),
      execute: async () => coordination.inbox(run.profileId, run.sessionId),
    }),

    acquire_resource: tool({
      description:
        'Acquire or renew a profile resource lease before exclusive work. Keep its fence.',
      inputSchema: z.object({
        resource: z.string().regex(/^[a-zA-Z0-9_./:-]{1,200}$/),
        ttlSeconds: z.number().int().min(5).max(300).default(60),
      }),
      execute: async (input) =>
        coordination.acquire(run.profileId, { ...input, sessionId: run.sessionId }),
    }),

    release_resource: tool({
      description: 'Release only this session’s current resource lease using its fence.',
      inputSchema: z.object({
        resource: z.string().regex(/^[a-zA-Z0-9_./:-]{1,200}$/),
        fence: z.number().int().positive(),
      }),
      execute: async (input) =>
        coordination.release(run.profileId, { ...input, sessionId: run.sessionId }),
    }),
  };

  if (run.profile.reachableByAgents) {
    Object.assign(tools, {
      list_agents: tool({
        description:
          'List the other agents of this installation: their id, name and what each one does. Their instructions, memories and conversations are not readable — here or anywhere else.',
        inputSchema: z.object({}),
        execute: async () => services.peers.agents(run.profileId),
      }),

      ask_agent: tool({
        description:
          'Ask another agent of this installation and wait for its written answer. Only text crosses: they never read your memories, sessions or history, and you never read theirs. The two of you keep one shared thread. A chain of calls is bounded — you cannot ask yourself, nor an agent that already spoke in this conversation, and the depth budget is shared by everyone in the chain.',
        inputSchema: agentCallSchema,
        execute: async (input, { abortSignal }) => services.peers.ask(run, input, abortSignal),
      }),
    });
  }

  if (run.profile.allowShell) {
    Object.assign(tools, shellTools(run.profileId, run.subagent ? run.id : undefined, gitAccess));
  }

  // Writing its own skills is part of every agent's work, not of managing itself: what it
  // writes is marked as its own, shown to the owner under Skills, and only it can change it.
  Object.assign(tools, skillTools(services.profiles, run));

  if (run.profile.allowSelfManagement) {
    tools.update_identity = tool({
      description:
        'Version an update to your own identity. Applies to new runs. Cannot change permissions, keys or providers.',
      inputSchema: z.object({
        expectedVersion: z.number().int().positive(),
        name: z.string().min(1).max(100).optional(),
        instructions: z.string().min(1).max(8000).optional(),
        identity: z
          .object({
            role: z.string().max(1000),
            tone: z.string().max(1000),
            goals: z.array(z.string().max(500)).max(10),
            boundaries: z.array(z.string().max(500)).max(10),
          })
          .optional(),
      }),
      execute: async (input) => {
        if (!(await services.profiles.profile(run.profileId)).allowSelfManagement) {
          throw new GatewayError(403, 'Self-management is disabled');
        }

        const updated = await services.profiles.updateProfile(run.profileId, input);

        return { id: updated.id, name: updated.name, version: updated.version };
      },
    });

    tools.read_identity = tool({
      description: 'Read the latest version of your identity before editing it.',
      inputSchema: z.object({}),
      execute: async () => {
        const p = await services.profiles.profile(run.profileId);

        return {
          id: p.id,
          name: p.name,
          instructions: p.instructions,
          identity: p.identity,
          version: p.version,
        };
      },
    });

    tools.create_profile = tool({
      description:
        'Create a separate profile without provider access. An administrator must configure its provider key before it can run.',
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        instructions: z.string().min(1).max(8000),
      }),
      execute: async (input) => {
        if (!(await services.profiles.profile(run.profileId)).allowSelfManagement) {
          throw new GatewayError(403, 'Self-management is disabled');
        }

        const { apiKeyEnv: _env, providerId: _provider, ...model } = run.profile.model;
        const created = await services.profiles.createProfile({ ...input, model });

        return { id: created.id, name: created.name };
      },
    });
  }

  return tools;
}

/**
 * Tools the agent asks for when it needs them. Every definition costs its description and its
 * schema on *every* model call of the run, so a set that is always complete is paid for by
 * turns that use none of it — measured at 8.5 KB of prompt for a greeting. What is left in
 * `core` is what a turn is likely to need before it has had a chance to ask for anything:
 * memory, skills, what the profile is doing, and the other agents, so a conversation between
 * profiles still costs one call rather than two.
 */
export const TOOL_GROUPS = {
  activity: {
    summary:
      'read your own full activity, tokens and estimated cost by day, model, channel, tool and individual run',
    tools: ['read_activity_stats', 'read_usage_runs'],
  },
  design: {
    summary:
      'read the design system of an application the owner designs for — its guide, the owner’s preferences, tokens and components — before drawing or describing any screen of it',
    tools: [
      'list_applications',
      'read_design_system',
      'read_design_file',
      'request_prototype',
      'read_prototype',
      'redo_prototype',
    ],
  },
  schedules: {
    summary:
      'do something later or on a repetition — reminders, daily summaries, recurring checks — and list, change, pause (switch off without deleting), resume or delete them',
    tools: ['list_schedules', 'create_schedule', 'update_schedule', 'delete_schedule'],
  },
  skills: {
    summary:
      'write, rewrite and remove your own skills: routines you follow the same way each time',
    tools: ['create_skill', 'update_skill', 'delete_skill'],
  },
  memory: {
    summary: 'tidy your memories: delete one, and link or unlink those recalled together',
    tools: ['forget_memory', 'link_memories', 'unlink_memories'],
  },
  media: {
    summary:
      'open attachments, save them, send files and documents into any conversation, find and send stickers, generate images, and reply with voice',
    tools: [
      'analyze_media',
      'send_file',
      'save_attachment',
      'generate_image',
      'list_speech_voices',
      'generate_speech',
      'find_stickers',
      'send_sticker',
      'tag_sticker',
    ],
  },
  files: {
    summary:
      'read, edit, write, find and search files on the machine this gateway runs on — for code too',
    tools: ['read_file', 'edit_file', 'write_file', 'find_files', 'search_files', 'list_directory'],
  },
  shell: {
    summary: 'run commands on the machine this gateway runs on',
    tools: ['run_command'],
  },
  web: {
    summary: 'search the web and read public pages',
    tools: ['web_search', 'fetch_url'],
  },
  conversations: {
    summary:
      'list your other conversations, read one, search by words across all of them (what was agreed elsewhere, who asked for what), write into one, and read your inbox',
    tools: [
      'list_sessions',
      'read_session',
      'search_history',
      'send_session_message',
      'read_inbox',
    ],
  },
  tasks: {
    summary:
      'record and update durable tasks, read checkpoints and stored output, manage resource leases, or compact context',
    tools: [
      'create_task',
      'update_task',
      'spawn_subagent',
      'list_task_subagents',
      'read_run_checkpoints',
      'read_artifact',
      'acquire_resource',
      'release_resource',
      'compact_context',
    ],
  },
  contacts: {
    summary:
      'list the people the owner approved on your channels and write to one, optionally bringing their answer back here',
    tools: ['list_contacts', 'message_contact'],
  },
  self: {
    summary: 'read and version your own identity, and create profiles',
    tools: ['read_identity', 'update_identity', 'create_profile'],
  },
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

const deferred = new Map<string, ToolGroup>(
  Object.entries(TOOL_GROUPS).flatMap(([group, entry]) =>
    entry.tools.map((name) => [name, group as ToolGroup] as const),
  ),
);

/** The groups this run can actually offer: a group whose tools are all absent is not one. */
export function offeredGroups(tools: ToolSet): ToolGroup[] {
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((group) =>
    TOOL_GROUPS[group].tools.some((name) => name in tools),
  );
}

/**
 * Adds the loader and reports which tools it gates. The returned set is live: loading a group
 * adds its names to it, and the runtime sends only the tools it holds.
 */
export function deferTools(tools: ToolSet, loaded: Set<string>): { gated: Set<string> } {
  const groups = offeredGroups(tools);
  const gated = new Set(
    Object.keys(tools).filter((name) => groups.includes(deferred.get(name) as ToolGroup)),
  );

  if (gated.size === 0) {
    return { gated };
  }

  tools.load_tools = tool({
    description: `Load a group of tools before using it. ${groups
      .map((group) => `${group}: ${TOOL_GROUPS[group].summary}`)
      .join('. ')}.`,
    inputSchema: z.object({
      groups: z.array(z.enum(groups as [ToolGroup, ...ToolGroup[]])).min(1),
    }),
    execute: async ({ groups: chosen }) => {
      for (const group of chosen) {
        for (const name of TOOL_GROUPS[group].tools) {
          if (name in tools) {
            loaded.add(name);
          }
        }
      }

      return { loaded: [...loaded] };
    },
  });

  return { gated };
}

/**
 * The profile's schedules, managed by the agent as fully as by the owner. A schedule runs the
 * instruction as a new turn in its conversation at the time; in a chat, the answer goes out
 * on the channel. Times are read in the owner's zone unless one is named.
 */
/** Screens drawn by Claude Code from a design system; the agent asks and reads, the owner approves. */
function prototypeTools(prototypes: Pick<Prototypes, 'create' | 'get' | 'redo'>, run: Run) {
  return {
    request_prototype: tool({
      description:
        'Ask for an interactive screen of an application, drawn by Claude Code with its real components and the owner’s preferences. It takes minutes; you are told here when it is ready. Give the request link from the board so the chain Pauta → Tela → Demanda holds.',
      inputSchema: z.object({
        application: z.string().min(1).max(48),
        title: z.string().min(1).max(160),
        brief: z
          .string()
          .min(1)
          .max(20_000)
          .describe(
            'What the screen has to do, every filter, column and action, in the owner’s words.',
          ),
        requestUrl: z.string().url().optional(),
      }),
      execute: async (input) =>
        prototypes.create(input, {
          kind: 'agent',
          profileId: run.profileId,
          sessionId: run.sessionId,
        }),
    }),
    read_prototype: tool({
      description:
        'Read a prototype: its request, its versions with their status and the owner’s comments, and which one is approved.',
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => prototypes.get(id),
    }),
    redo_prototype: tool({
      description:
        'Ask for a new version of a prototype from the owner’s comments, passed on as they wrote them. Only when the owner commented; never on your own judgement.',
      inputSchema: z.object({ id: z.string().uuid(), comments: z.string().min(1).max(20_000) }),
      execute: async ({ id, comments }) => prototypes.redo(id, { comments }, 'api'),
    }),
  };
}

/** The owner's applications and their design systems, read-only for every agent. */
function designTools(applications: Pick<Applications, 'list' | 'brief' | 'readForAgent'>) {
  return {
    list_applications: tool({
      description:
        'List the applications the owner designs for (the ERP, the managers app…): slug, name, platform, and how many design-system files each has.',
      inputSchema: z.object({}),
      execute: async () =>
        (await applications.list()).map(({ slug, name, platform, url, files, version }) => ({
          slug,
          name,
          platform,
          url,
          files,
          version,
        })),
    }),
    read_design_system: tool({
      description:
        'Read an application’s design system before you draw, prototype or describe any of its screens: the owner’s preferences (they win), the guide, the tokens and the list of components. Follow it; never design from memory.',
      inputSchema: z.object({ slug: z.string().min(1).max(48) }),
      execute: async ({ slug }) => applications.brief(slug),
    }),
    read_design_file: tool({
      description:
        'Read one text file of an application’s design system, such as a component’s notes (project/components/<Name>/README.md) or its types (project/components/<Name>/<Name>.d.ts).',
      inputSchema: z.object({
        slug: z.string().min(1).max(48),
        path: z.string().min(1).max(300),
      }),
      execute: async ({ slug, path }) => applications.readForAgent(slug, path),
    }),
  };
}

function scheduleTools(
  schedules: NonNullable<ToolServices['schedules']>,
  run: Run,
  zone: () => Promise<string>,
): ToolSet {
  const timing = {
    at: z
      .string()
      .optional()
      .describe(
        `A single time, ISO 8601 with its offset, e.g. 2026-10-02T15:00:00-03:00. Exclusive with cron.`,
      ),
    cron: z
      .string()
      .optional()
      .describe(
        'A repetition, five cron fields: minute hour day-of-month month day-of-week. "0 8 * * *" is every day at 08:00; "30 9 * * 1-5" is weekdays at 09:30. At most every 5 minutes. Exclusive with at.',
      ),
    timeZone: z
      .string()
      .optional()
      .describe(
        "IANA zone the time is read in. Default: the gateway's, the one the current time above is given in.",
      ),
  };

  return {
    list_schedules: tool({
      description: 'List this profile’s schedules: what, when, where, whether on, and when next.',
      inputSchema: z.object({}),
      execute: async () => schedules.list(run.profileId),
    }),
    create_schedule: tool({
      description:
        'Do something later, once or on a repetition: remind the owner, send a summary every morning, check something weekly. At the time, the instruction runs as a new turn in the chosen conversation — this one unless you give another session id, such as a WhatsApp group from your conversations — and your answer there goes out on its channel. Write the instruction as the request you will receive then, with everything needed and nothing assumed from this conversation.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('Short, for the owner’s list: "Morning summary".'),
        instruction: z.string().min(1).max(4000),
        sessionId: z.string().uuid().optional(),
        ...timing,
      }),
      execute: async ({ sessionId, timeZone, ...input }) =>
        schedules.create(
          run.profileId,
          { ...input, sessionId: sessionId ?? run.sessionId, timeZone: timeZone ?? (await zone()) },
          'agent',
        ),
    }),
    update_schedule: tool({
      description:
        'Change a schedule: its name, instruction, conversation, time, zone, or switch it off (enabled: false) and on. A new time replaces the old one.',
      inputSchema: z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(1).max(4000).optional(),
        sessionId: z.string().uuid().optional(),
        enabled: z.boolean().optional(),
        ...timing,
      }),
      execute: async ({ id, ...patch }) => schedules.update(run.profileId, id, patch),
    }),
    delete_schedule: tool({
      description: 'Delete a schedule for good. To pause one instead, switch it off.',
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => schedules.remove(run.profileId, id),
    }),
  };
}
