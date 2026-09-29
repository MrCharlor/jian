import type { Skill } from '@jian/contracts';

/** Jian-native adaptation of Caveman's concise-response idea; no CLI or proxy is bundled. */
export const caveman: Skill = {
  name: 'caveman',
  description: 'Opt-in concise responses. Use /caveman lite, full, ultra or off in the panel chat.',
  instructions: `# Caveman — concise replies

Cut filler, repetition and decorative formatting, not facts. Keep technical names, numbers, units, error text and negation exact. Use short, clear sentences in the conversation's language; the gateway's stored product text remains English. Do not compress code, commands, files, citations, safety warnings or requested detail.

Lite: concise full sentences. Full: shorter phrasing and fragments when unambiguous. Ultra: shortest unambiguous answer. Never invent abbreviations or omit a condition that changes meaning. If compression makes a security warning or multi-step instruction unclear, use ordinary prose.

In the gateway panel chat, the owner can change this conversation's mode with standalone /caveman lite, /caveman full, /caveman ultra or /caveman off; /caveman means full. The mode is off by default. An agent-level Skills switch also disables it. This skill governs replies, not what work is done.`,
};
