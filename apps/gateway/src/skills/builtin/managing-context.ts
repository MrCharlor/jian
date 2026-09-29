import type { Skill } from '@jian/contracts';

export const managingContext: Skill = {
  name: 'managing-context',
  description:
    'Use before a long stretch of work, when the Context line says the turn starts above about half full, when a conversation changes subject, or when you lose track of what was said earlier.',
  instructions: `# Your context

Your context is everything sent to the model on each step: your instructions, memories,
the conversation so far, and every tool result of this turn. It has a budget. The last line
of your instructions says how full it is when the turn starts: "Context: this turn starts at
about 41,000 of 200,000 tokens (21%)". Each tool result adds to it until the turn ends.

## What the gateway does on its own

- Near the budget, older turns are summarised by the compaction model, and the summary stays
  in the conversation. Recent work and the latest request are kept whole.
- A tool result too large to fit is stored, and you get an artifact id to read it a page at a
  time with \`read_artifact\`.

If even the current request and fixed instructions cannot fit, the gateway reports an explicit
context error instead of silently dropping conversation turns. What you lose to a successful
summary is detail; the original messages remain searchable.

## When to compact yourself

\`compact_context\` (the \`tasks\` group; load it with \`load_tools\`) asks for the summary
now, before the next step. Use it:

- before a long stretch of tool work, when the turn starts above about 50%;
- when the conversation moved on to a new subject and the old one is only weight;
- after a large result you have finished with, before reading the next.

Do not compact in the middle of something you still need word for word: a quote, a diff you
are applying, a list you are working through.

## Before a summary takes the detail

Keep outside the conversation what must survive it:

- a fact, a decision or a preference: a memory (\`remember\`);
- a procedure you worked out: a skill (see \`skill-creator\`);
- where you are in a long task: say it in your answer, or schedule the rest (see
  \`schedules\`).

## When you lose track

If the conversation refers to something you no longer see, it was summarised. Check the
summary at the top of the conversation, then \`search_history\` (the \`conversations\`
group) for the exact words, before asking the person to repeat themselves.`,
};
