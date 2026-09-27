import type { Memory } from '@jian/contracts';
import { rankMemories } from '../context/build.js';
import type { Judge } from '../decisions/service.js';

/** How many memories sharing words with the new one are read for meaning. */
const CANDIDATES = 15;
const CONTENT_CHARS = 600;
/** The existing memory must have been chosen with at least this probability to hold a save. */
const SAME_SUBJECT = 0.6;

/** Not a valid memory key, so no memory can take its place among the options. */
const NONE = '(none)';

/**
 * The memory already kept about the same subject as one about to be written under a new key,
 * or nothing. Two memories on one subject drift apart, and the next recall brings back both,
 * one of them stale. Words find the candidates; a judgement on meaning picks among them.
 */
export async function sameSubject(
  judge: Judge,
  memories: { search(profileId: string, query: string, limit?: number): Promise<Memory[]> },
  profileId: string,
  written: { key: string; content: string },
): Promise<Memory | undefined> {
  const text = `${written.key.replace(/[-_]+/g, ' ')} ${written.content}`;
  const candidates = rankMemories(text, await memories.search(profileId, text, CANDIDATES * 2))
    .map(({ memory }) => memory)
    .filter((memory) => memory.key !== written.key)
    .slice(0, CANDIDATES);

  if (candidates.length === 0) {
    return undefined;
  }

  const answers = await judge(
    { newNote: { key: written.key, content: written.content.slice(0, CONTENT_CHARS * 2) } },
    {
      same: {
        type: 'choice',
        instructions:
          'Which of the saved notes is about the same subject as `newNote`, so that `newNote` should update it rather than be saved beside it?',
        criteria: {
          ...Object.fromEntries(
            candidates.map((memory) => [memory.key, memory.content.slice(0, CONTENT_CHARS)]),
          ),
          [NONE]: 'None: `newNote` is about a different subject than every saved note.',
        },
      },
    },
    { use: 'memories' },
  );
  const same = answers?.same;

  if (same?.type !== 'choice' || same.choice === NONE) {
    return undefined;
  }

  return (same.probabilities[same.choice] ?? 0) >= SAME_SUBJECT
    ? candidates.find((memory) => memory.key === same.choice)
    : undefined;
}
