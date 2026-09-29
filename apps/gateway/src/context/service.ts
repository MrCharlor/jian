import { LEARNING_SESSION_CHANNEL, type Run } from '@jian/contracts';
import { listConversations } from '../channels/repository.js';
import type { Judge } from '../decisions/service.js';
import { findMemories, searchMemories, withLinks } from '../memories/repository.js';
import type { RunReader } from '../runs/port.js';
import type { SessionReader } from '../sessions/port.js';
import { findGatewaySession } from '../sessions/repository.js';
import { availableSkills } from '../skills/builtin/index.js';
import type { Store } from '../storage/database.js';
import { buildContext, rankMemories } from './build.js';
import { judgeTurn } from './judgments.js';
import type { ContextSource } from './port.js';

export class Contexts {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly sessions: SessionReader,
    private readonly settings?: { timeZone(): Promise<string> },
    /** Reads the shortlist for meaning when the installation has a Jev key; see judgments.ts. */
    private readonly judge?: Judge,
  ) {}

  async context(run: Run): ReturnType<ContextSource['context']> {
    if (run.subagent) {
      const history = await this.sessions.messages(run.profileId, run.sessionId, 40);
      return {
        system: [
          run.profile.instructions,
          `You are ${JSON.stringify(run.subagent.name)}, an ephemeral ${run.subagent.role} worker for one task.`,
          `Identity and working approach: ${run.subagent.identity}`,
          'Work only on the assigned task. You have no owner conversation, shared memories, contacts, or authority to delegate. Use list_tasks to read the current version and update_task to report progress. Before your final report, mark verified work done, or hand off to review when independent review is needed; leave the exact blocker in the task if incomplete. Your final response is a factual report, not a message to the owner.',
        ].join('\n\n'),
        messages: history
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({ role: message.role, content: message.content })),
      };
    }
    const words = [...new Set(run.input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
      0,
      12,
    );

    const session = await this.sessions.session(run.profileId, run.sessionId);

    // Independent reads: whatever the request mentions, what the profile is busy with, whom it
    // talks to on its channels, and the turns since the record of what was compacted away.
    // `buildContext` is what decides how much of each survives.
    const [matched, activities, gateway, conversations, history] = await Promise.all([
      searchMemories(this.store.db, run.profileId, words, 100),
      this.runs.activities(run.profileId),
      findGatewaySession(this.store.db, run.profileId),
      listConversations(this.store.db, run.profileId),
      this.sessions.messages(run.profileId, run.sessionId, 40, session.summarizedUpTo),
    ]);

    // One step out from what matched: the memories linked to it, which the request may not
    // mention at all.
    const memories = await withLinks(this.store.db, run.profileId, matched);
    const matchedKeys = new Set(memories.map((memory) => memory.key));
    const linked = await findMemories(
      this.store.db,
      run.profileId,
      [...new Set(memories.flatMap((memory) => memory.links ?? []))].filter(
        (key) => !matchedKeys.has(key),
      ),
    );

    const before = history.findLast(
      (message) => message.role === 'assistant' && message.runId !== run.id,
    )?.content;
    // A look back reads its own brief and loads no skill; judging it would only cost a call.
    const judged =
      this.judge && session.channel !== LEARNING_SESSION_CHANNEL
        ? await judgeTurn(this.judge, {
            request: run.input,
            ...(before ? { before } : {}),
            memories: rankMemories(run.input, memories).map(({ memory }) => memory),
            skills: availableSkills(run.profile).map(({ name, description }) => ({
              name,
              description,
            })),
          })
        : {};

    const built = buildContext(run, {
      ...(judged.relevance ? { relevance: judged.relevance } : {}),
      ...(judged.skill ? { suggestedSkill: judged.skill } : {}),
      ...(this.settings ? { timeZone: await this.settings.timeZone() } : {}),
      memories,
      linked,
      activities,
      // The owner's own conversation, from the panel, comes first: it is where they reach the
      // agent directly, and without it the agent believes the conversation it is in is missing.
      conversations: [
        ...(gateway
          ? [{ sessionId: gateway.id, channel: 'gateway', with: 'your owner, in the Jian panel' }]
          : []),
        ...conversations.map((contact) => ({
          sessionId: contact.sessionId as string,
          channel: contact.type,
          with: contact.displayName ?? contact.actorId,
          ...(contact.scope === 'group' ? { group: true } : {}),
        })),
      ],
      history,
      ...(session.summary ? { summary: session.summary } : {}),
    });

    return judged.light ? { ...built, light: true as const } : built;
  }
}
