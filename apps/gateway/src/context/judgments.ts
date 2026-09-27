import type { Memory } from '@jian/contracts';
import { type Judge, noul, type Question } from '../decisions/service.js';

/** How many of the memories the words matched are read again for meaning, best first. */
export const JUDGED_MEMORIES = 15;
/** What each judged memory shows of itself; its start says what it is about. */
const MEMORY_CHARS = 600;
const REQUEST_CHARS = 4000;
const BEFORE_CHARS = 1500;
/** A Choice takes at most this many options; past it the catalog is not judged. */
const MAX_OPTIONS = 255;
/** The turn is waiting to start; past this it starts with the fixed ranking. */
const TIMEOUT_MS = 1500;
/** The one skill suggested must have been chosen with at least this probability. */
const SKILL_THRESHOLD = 0.5;
/**
 * Above this probability the turn is taken as light. High on purpose: thinking too little on
 * a hard request costs a worse answer, thinking too much on a greeting only costs time.
 */
const LIGHT_THRESHOLD = 0.85;

/** Not a valid skill name, so no skill can take its place among the options. */
const NONE = '(no skill)';

export type TurnJudgments = {
  /** For each judged memory key, the probability that it helps with this turn. */
  relevance?: Record<string, number>;
  /** The one skill most likely to fit the turn, when one clearly does. */
  skill?: string;
  /** The turn is plainly light — small talk or a simple question — and needs little thought. */
  light?: true;
};

/**
 * What is worth putting in front of the agent for this turn, asked in one request before it
 * starts: which of the memories the words matched actually bear on it, and which skill, if
 * any, fits it. The agent keeps its full catalog and its own judgement; these only change the
 * order memories are recalled in and add one line naming a skill. Without an answer the turn
 * starts as it did before: memories by shared words, no suggestion.
 */
export async function judgeTurn(
  judge: Judge,
  turn: {
    request: string;
    /** The agent's last reply, which a short answer like "yes, do it" refers to. */
    before?: string;
    memories: Memory[];
    skills: Array<{ name: string; description: string }>;
  },
): Promise<TurnJudgments> {
  const memories = turn.memories.slice(0, JUDGED_MEMORIES);
  const skills = turn.skills.length < MAX_OPTIONS ? turn.skills : [];
  const questions: Record<string, Question> = {};

  memories.forEach((_memory, index) => {
    questions[`memory:${index}`] = {
      type: 'noul',
      instructions: `Would the saved note \`memories.m${index}\` help the agent answer or carry out \`request\`?`,
      criteria: {
        true: 'The note is about the subject, people or task of the request, or a rule for doing it.',
        false: 'The note is about something else and would not change the answer.',
      },
    };
  });

  if (skills.length > 0) {
    questions.skill = {
      type: 'choice',
      instructions:
        'Which of these skills — written instructions for a kind of task — should the agent read before answering `request`?',
      criteria: {
        ...Object.fromEntries(skills.map((skill) => [skill.name, skill.description])),
        [NONE]:
          'None: the request is conversation the agent answers directly, or no skill here fits it.',
      },
    };
  }

  questions.light = {
    type: 'noul',
    instructions:
      'Is `request` light — a greeting, thanks, small talk, a short confirmation or a simple question with a direct answer — so that answering it needs no planning, several steps or careful reasoning?',
    criteria: {
      true: 'A quick, direct reply fully serves the request.',
      false:
        'The request asks for work, analysis, a decision, several steps, or anything that benefits from thinking it through.',
    },
  };

  const answers = await judge(
    {
      request: turn.request.slice(-REQUEST_CHARS),
      ...(turn.before ? { agentSaidBefore: turn.before.slice(-BEFORE_CHARS) } : {}),
      memories: Object.fromEntries(
        memories.map((memory, index) => [
          `m${index}`,
          { key: memory.key, content: memory.content.slice(0, MEMORY_CHARS) },
        ]),
      ),
    },
    questions,
    { use: 'turn', timeoutMs: TIMEOUT_MS },
  );

  if (!answers) {
    return {};
  }

  const relevance: Record<string, number> = {};

  memories.forEach((memory, index) => {
    const yes = noul(answers[`memory:${index}`]);

    if (yes !== undefined) {
      relevance[memory.key] = yes;
    }
  });

  const picked = answers.skill;
  const skill =
    picked?.type === 'choice' &&
    picked.choice !== NONE &&
    (picked.probabilities[picked.choice] ?? 0) >= SKILL_THRESHOLD &&
    skills.some((item) => item.name === picked.choice)
      ? picked.choice
      : undefined;

  return {
    ...(Object.keys(relevance).length > 0 ? { relevance } : {}),
    ...(skill ? { skill } : {}),
    ...((noul(answers.light) ?? 0) >= LIGHT_THRESHOLD ? { light: true as const } : {}),
  };
}
