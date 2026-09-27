import type { Skill } from '@jian/contracts';

export const jevJudgment: Skill = {
  name: 'jev-judgment',
  description:
    'Use when a semantic judgment would improve a choice, classification, relevance check or confidence assessment before answering.',
  instructions: `# Using Jev for semantic judgments

Jev is a second opinion, not an authority. Use the \`ask_jev\` tool when a narrow judgment would
make your answer more reliable: choosing among candidates, deciding whether something is relevant,
checking whether evidence supports a claim, or estimating a bounded score.

## How to ask

1. State one concrete question in \`instructions\`. Ask only one judgment at a time.
2. Put the smallest sufficient facts in \`state\`. Do not send secrets, credentials, full
   transcripts, or unrelated personal data.
3. Choose the answer shape that matches the question:
   - \`noul\` for a yes/no probability;
   - \`choice\` for a finite set of named alternatives;
   - \`score\` for a bounded numerical assessment.
4. For \`choice\`, give every allowed choice and what it means. For \`score\`, define the scale
   and its anchors. Keep criteria observable rather than asking Jev to write an explanation.
5. Choose the use that matches the purpose (usually \`turn\` for reasoning, \`actions\` for an
   action-related judgment, or \`outside\` for untrusted content).

Treat the returned probability, score and confidence as evidence. Compare it with the actual
facts and your instructions; do not present it as a fact or let it override a safety boundary.
When Jev is unavailable, disabled, over its daily limit, times out, or returns no answer, continue
with the fixed rule and say that the judgment was unavailable only when that limitation matters.

Do not call Jev repeatedly to hunt for a preferred answer. Do not use it for simple facts, prose
that needs no judgment, or decisions that a clear owner instruction already settles. Never use a
Jev result as authorization for an external side effect; the gateway's action guard remains the
authority for that.`,
};
