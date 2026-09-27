import { LEARNING_SESSION_CHANNEL, type Profile, type Run, type Session } from '@jian/contracts';
import { type Judge, noul } from '../decisions/service.js';
import { listRecentRuns } from '../runs/repository.js';
import { findOwnSession } from '../sessions/repository.js';
import type { Store } from '../storage/database.js';

/** A turn with this many tool calls did enough work to be worth looking back on. */
const MANY_TOOLS = 10;
/** Without such a turn, the recent conversation is still reviewed this often, in turns. */
const REVIEW_EVERY = 15;
/** At most one look back per profile in this long: learning must not cost more than working. */
const COOLDOWN_MS = 10 * 60_000;
/** What the brief quotes of each request and answer. */
const QUOTE_CHARS = 600;
/** The brief is a message, and a message holds this much. */
const BRIEF_CHARS = 7_800;
/**
 * Below this probability that the work holds something to keep, the look back is skipped. Low
 * on purpose: a review that finds nothing costs one turn, a lesson missed is gone.
 */
const NOTHING_TO_KEEP = 0.15;

export type TurnWork = {
  tools: Array<{ name: string; error?: string }>;
  answer: string;
};

type LearningServices = {
  store: Store;
  profiles: { profile(id: string): Promise<Profile> };
  sessions: { learningSession(profileId: string): Promise<Session> };
  /** Asks whether the work holds anything to keep before a whole turn is spent finding out. */
  judge?: Judge;
  runs: {
    submit(
      profileId: string,
      sessionId: string,
      input: unknown,
      options?: { activity?: 'conversation' | 'channel' },
    ): Promise<Run>;
  };
};

const quote = (text: string, limit = QUOTE_CHARS) => {
  const flat = text.replace(/\s+/g, ' ').trim();

  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/**
 * The agent learning from its own work. After a turn worth looking back on, a short turn of its
 * own reads what happened and keeps what will help next time — a skill for a way of working, a
 * memory for a fact — or, most often, nothing. It runs in the profile's Learning conversation,
 * where the owner reads what was kept and why, with only the memory and skill tools.
 */
export class Learning {
  constructor(
    private readonly services: LearningServices,
    private readonly clock: () => number = Date.now,
  ) {}

  async consider(run: Run, work: TurnWork): Promise<Run | undefined> {
    const profile = await this.services.profiles.profile(run.profileId);

    if (!profile.learnFromWork) return undefined;

    // Read, not opened: a profile gets its Learning conversation on its first look back.
    const learning = await findOwnSession(
      this.services.store.db,
      run.profileId,
      LEARNING_SESSION_CHANNEL,
    );

    if (run.sessionId === learning?.id) return undefined;

    const recent = await listRecentRuns(this.services.store.db, run.profileId, 100);
    const lastLook = learning && recent.find((item) => item.sessionId === learning.id);

    if (lastLook && this.clock() - Date.parse(lastLook.createdAt) < COOLDOWN_MS) return undefined;

    const failed = work.tools.filter((tool) => tool.error);
    const since = recent.filter(
      (item) =>
        item.sessionId !== learning?.id &&
        item.status === 'completed' &&
        (!lastLook || item.createdAt > lastLook.createdAt),
    );
    const reason =
      work.tools.length >= MANY_TOOLS
        ? `a turn with ${work.tools.length} tool calls`
        : failed.length
          ? `a turn that recovered from ${failed.length === 1 ? 'a failed tool' : `${failed.length} failed tools`}`
          : since.length >= REVIEW_EVERY
            ? `the last ${since.length} turns`
            : undefined;

    if (!reason) return undefined;

    const periodic = work.tools.length < MANY_TOOLS && !failed.length;
    const yours = profile.skills.filter((skill) => skill.writtenBy === 'agent');
    const material = periodic
      ? [
          'Recent turns, oldest first:',
          ...since
            .slice(0, REVIEW_EVERY)
            .reverse()
            .map(
              (item) =>
                `- Asked: ${quote(item.input, 300)}\n  Answered: ${quote(item.output ?? '', 300)}`,
            ),
        ]
      : [
          `Request: ${quote(run.input)}`,
          `Tools, in order: ${work.tools
            .map((tool) =>
              tool.error ? `${tool.name} (failed: ${quote(tool.error, 160)})` : tool.name,
            )
            .join(', ')}`,
          `Answer: ${quote(work.answer)}`,
        ];

    if (this.services.judge) {
      const answers = await this.services.judge(
        { work: material.join('\n') },
        {
          teaches: {
            type: 'noul',
            instructions:
              'Does `work` hold something an assistant should keep for next time: a correction or a stated preference from the person, a fact about a person or a decision, or a way of doing a kind of task that worked after something failed?',
            criteria: {
              true: 'There is a correction, preference, fact or working method worth keeping.',
              false: 'Routine requests and answers with nothing new to keep.',
            },
          },
        },
        { use: 'learning' },
      );
      const yes = noul(answers?.teaches);

      if (yes !== undefined && yes < NOTHING_TO_KEEP) return undefined;
    }

    const brief = [
      `[Learning] Looking back at ${reason}: "${quote(run.input, 80)}"`,
      'This is your own review, not a message from anyone. Look back at the work below and decide whether something in it will help you next time:',
      '- a way of doing a kind of task — steps, an order, a format, a check that caught a mistake — becomes a skill: update one of yours if it covers the task, otherwise create one (see skill-creator);',
      '- a fact about a person, a decision or a preference that you learned becomes a memory, if you do not keep it already;',
      '- a correction from the owner is the strongest signal: keep what they wanted, and how to tell next time.',
      'Most turns teach nothing new. Then change nothing. Never keep what is private to one conversation in a skill: skills are how you work everywhere.',
      'End with one or two lines for the owner: what you kept and why, or "Nothing to keep."',
      '',
      ...material,
      '',
      yours.length
        ? `Skills you wrote: ${yours.map((skill) => `${skill.name} — ${skill.description}`).join('; ')}`
        : 'You have not written any skill yet.',
    ].join('\n');

    const session = learning ?? (await this.services.sessions.learningSession(run.profileId));

    return this.services.runs.submit(run.profileId, session.id, {
      text: brief.slice(0, BRIEF_CHARS),
      requestKey: `learn:${run.id}`,
    });
  }
}
