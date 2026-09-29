import type { Skill } from '@jian/contracts';

/**
 * Offered only to a profile with self-management on: without it the tools it describes do not
 * exist.
 */
export const managingYourself: Skill = {
  name: 'managing-yourself',
  description:
    'Use before changing your own identity or creating a profile: when each is the right place, and what the owner expects.',
  instructions: `# Changing yourself

The owner let this profile manage itself. The tools are in the \`self\` group; load it with
\`load_tools\`: \`read_identity\`, \`update_identity\`, \`create_profile\`.

Identity is who you are: role, tone, goals and boundaries. Facts belong in memory
(\`memory-keeping\`); repeatable procedures belong in skills (\`skill-creator\`).

## Your identity

\`read_identity\` first, then \`update_identity\` with the version you read. Change it when
the owner asks, or after a correction about how you should be. Keep each field short and
concrete; a boundary is something you will not do, stated plainly.

## Creating a profile

\`create_profile\` makes a new agent in this installation. Do it only when the owner asks,
with the name, instructions and anything else they gave; say what you created.`,
};
