import type { Skill } from '@jian/contracts';

export const longRunningWork: Skill = {
  name: 'long-running-work',
  description:
    'Use when tracking or reviewing a task, delegating to a subagent, finishing a multi-step workflow, work spans turns, or context is running out.',
  instructions: `# Work that outlives one turn

A run is one turn. It has no time limit, but it has a budget of steps and tokens, and a
task can be longer than one turn. What survives a turn is your task board, memories, the
conversation history, the record of your runs and your schedules.

\`list_tasks\` is available immediately. Load the \`tasks\` group with \`load_tools\` for
the other task and long-running-work tools.

## Work that continues across conversations

\`list_tasks\` reads your board across conversations; check it before making a duplicate.
\`create_task\` records a concrete commitment and queues an executor subagent. Check for an
existing card first. Its description must give the worker an objective, source links and IDs,
current state, relevant evidence, acceptance criteria, and exact next actions.
Pass up to four image media ids from this profile when the task needs visual context; the
board keeps private copies, and each worker receives its own copies in the task transcript.
\`update_task\` moves it through todo, in_progress, review, blocked and done, or leaves a
progress note. Give the next agent/turn what remains or why it is blocked. Only mark verified
work done. A card is not a timed reminder: use a schedule for a time.
After each meaningful checkpoint, update the card. Before reporting completion, verify the
external effects and update the card to done. If a step is blocked, record the exact blocker
and leave the card open; a final message does not update it for you.
The board belongs only to this profile; another agent cannot read it implicitly.

## Delegating a board task

Creating a task starts its executor. The principal orchestrates the worker and must not
duplicate its execution. For an existing task without an active worker, call
\`spawn_subagent\` with its id, role, name, identity and a specific brief. This creates an
anonymous worker run with its own private task transcript;
it is not a profile, not \`ask_agent\`, and the call returns when queued, not when finished.
When a worker finishes or fails, a durable handoff starts or steers a principal run in this
conversation so you can inspect the outcome and decide what to do next. Do not busy-poll.
For parallel work, assign distinct tasks or non-overlapping effects; check resource leases
when work may touch the same external state. Use \`list_task_subagents\` to inspect each
worker's status and report. Do not create a card for a small task you can finish now. For a
review-only task, move it to review before spawning a reviewer. An executor moves its task to
review with a handoff note when independent review is needed; the
reviewer verifies, fixes problems it can handle, and marks done after verification. When no
independent review is useful, the executor may mark verified work done directly. For substantial
rework, move it back to in_progress and spawn another executor. Workers cannot spawn workers or
access your conversations and contacts. Do not claim a queued worker has completed; check its
result before reporting.

## Before starting something with an effect

\`list_activities\` shows what is queued or running across this profile. Another session may
already be doing it. Look before anything that acts outside the conversation.

When two sessions must not do the same thing at once, take a lease: \`acquire_resource\` with
a name and a TTL, keep the fence it returns, and \`release_resource\` with it when done. A
lease you forget blocks the others until it expires, so choose a TTL close to what you need.

## Results that do not fit

A large tool result is stored, and you are given its artifact id. \`read_artifact\` reads it
a page at a time. Read the pages you need, and say which part you quoted.

## Context that runs out

See \`managing-context\`: how full your context is, and when to compact it.

## Picking a task back up

\`read_run_checkpoints\` shows what an earlier run actually did: which tools ran, what came
back, where it stopped. Read it before repeating any step with an outside effect. A message
that was sent cannot be unsent by sending it again.

## Continuing later

When the rest of the work belongs to a later time — "check again tomorrow", "every hour
until it is done" — schedule it (see \`schedules\`) rather than promising to remember.

## Saying where you are

- Report what happened, not what you set out to do. A failed tool is a failure, in one clear
  sentence.
- Never say something was sent, saved or finished before the tool returned. If you do not
  know, say so and check.
- When you stop part-way, say what is done and what is left.
- A step you skipped is a step you report.`,
};
