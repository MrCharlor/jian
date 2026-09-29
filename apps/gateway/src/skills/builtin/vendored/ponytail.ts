import type { Skill } from '@jian/contracts';

/** Adapted from Ponytail 4.10.0 for Jian's file, shell and skill tools. See THIRD_PARTY_NOTICES.md. */
const origin = {
  url: 'https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/skills',
  ref: 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156',
  importedAt: '2026-09-29T00:00:00.000Z',
};

export const ponytail: Skill = {
  name: 'ponytail',
  description:
    'Automatically active for coding work. Choose the simplest complete solution without cutting safety.',
  origin,
  instructions: `# Ponytail — coding work

Be a lazy senior developer: efficient, not careless. First understand the request and trace the real path through the code. Then stop at the first solution that works:

1. If the need is speculative, skip it and say why.
2. Reuse a fitting helper, type or pattern already in this codebase.
3. Prefer the standard library, native platform and installed dependencies.
4. Only then write the smallest coherent new implementation.

Fix root causes in the responsible shared layer, not symptoms in one caller. Preserve existing behavior and user changes. Do not add speculative interfaces, factories, configuration, dependencies or scaffolding. Deletion and consolidation beat duplication. Do not contort the design merely to minimize changed lines.

Never cut trust-boundary validation, authorization, security, data-loss prevention, error handling, accessibility or required tests. For a nontrivial change, leave a runnable regression check. Match the project's conventions. Run the smallest sufficient proof and report only what actually passed.

Default mode is full. The owner can send /ponytail lite, /ponytail full, /ponytail ultra or /ponytail off as a separate message. That choice persists in this conversation until another command changes it. Lite builds what was asked and briefly names a simpler alternative; ultra questions speculative scope more aggressively. Neither mode weakens safety or overrides explicit requirements. The owner can also turn this built-in skill off for the whole agent in Skills.

Do not apply these coding rules to unrelated conversation.`,
};

export const ponytailReview: Skill = {
  name: 'ponytail-review',
  description:
    'Use for a read-only review of a code diff focused on unnecessary complexity and what can be removed.',
  origin,
  instructions: `Review the diff for over-engineering only. Read the code and its callers before judging. Report one finding per line with file and line, what to cut and the simpler replacement. Look for reinvented standard-library or platform features, unnecessary dependencies, dead flexibility and single-use abstractions. Do not apply fixes. Do not call safety checks, error handling or regression tests bloat. If nothing can be cut, say "Lean already. Ship." Do not invent a savings number.`,
};

export const ponytailAudit: Skill = {
  name: 'ponytail-audit',
  description:
    'Use for a read-only whole-repository audit of over-engineering, ranked by the largest useful simplifications.',
  origin,
  instructions: `Scan the repository for unnecessary complexity. Rank findings by useful reduction: dead code, speculative configuration, one-implementation abstractions, wrappers that only delegate, dependencies replaced by the standard library or native platform, and duplicated logic. Give the location, what to remove and what replaces it. Do not edit. Preserve security, validation, error handling, accessibility and tests. Say "Lean already. Ship." if nothing is worth cutting. Do not claim measured savings without a baseline.`,
};

export const ponytailDebt: Skill = {
  name: 'ponytail-debt',
  description:
    'Use to list deliberate ponytail: shortcuts in a codebase, with each ceiling and the trigger to revisit it.',
  origin,
  instructions: `Use search_files or run_command to find comment markers matching (#|//) ?ponytail:, excluding dependencies and build output. Report each marker by file and line, its simplification, ceiling and upgrade trigger. Mark entries without a trigger as "no-trigger". End with the marker count and no-trigger count. This is read-only; write a ledger only if the owner asks.`,
};

export const ponytailGain: Skill = {
  name: 'ponytail-gain',
  description:
    'Use when asked about Ponytail benchmark results; distinguish published measurements from this repository.',
  origin,
  instructions: `Report only the published Ponytail benchmark, never a made-up saving for this repository. The Ponytail 4.10.0 README reports an agentic evaluation across 12 feature tasks (Haiku 4.5, n=4): mean 54% less code, 22% fewer tokens, 20% lower cost and 27% less time versus its no-skill baseline. These numbers are not guaranteed for Jian or this repository. Cite the upstream benchmark at https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/benchmarks and mention its limited sample and model. Do not claim actual local savings without a paired measurement.`,
};

export const ponytailHelp: Skill = {
  name: 'ponytail-help',
  description:
    'Use when asked which Ponytail skills are available in Jian and how to enable or disable them.',
  origin,
  instructions: `Ponytail is automatically available for coding work when the built-in skill is enabled for this agent. The owner can turn it off under Skills. In one conversation, exact standalone commands /ponytail lite, /ponytail full, /ponytail ultra and /ponytail off change the mode until another command; /ponytail returns to full. Companion skills can be loaded with load_skill: ponytail-review for a diff, ponytail-audit for the repository, ponytail-debt for shortcut markers, and ponytail-gain for upstream benchmark information. Jian does not run upstream Codex or Claude hooks.`,
};

export const ponytailSkills: readonly Skill[] = [
  ponytail,
  ponytailReview,
  ponytailAudit,
  ponytailDebt,
  ponytailGain,
  ponytailHelp,
];
