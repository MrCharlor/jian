/**
 * Checks on someone else's words before any model reads them, and on the agent's reply before
 * it reaches the card (B25). No model here: a pattern either matches or it does not, and what
 * matched is what the owner reads in the alert.
 */

type Rule = { why: string; pattern: RegExp };

/** Hosts a comment may link to without being held: the company, its code and its prototypes. */
const TRUSTED_IN = /(?:^|\.)(?:vxcase\.com\.br|bitbucket\.org|github\.com|claude\.ai)$/i;

/** Hosts a published reply may link to: the tracker and the previews. */
const TRUSTED_OUT = /^(?:work\.vxcase\.com\.br|[a-z0-9-]+\.preview\.dev\.vxcase\.com\.br)$/i;

const INJECTION: Rule[] = [
  {
    why: 'pede para ignorar instruções',
    pattern:
      /\b(?:ignor[ae]\w*|esque[cç]a\w*|desconsider[ae]\w*|disregard|forget)\b[^.\n]{0,40}\b(?:instru\w*|regras?|ordens?|prompt|instructions?|rules?|above|anteriores?)\b/i,
  },
  {
    why: 'fala do prompt do agente',
    pattern:
      /\b(?:system|developer)\s*prompt\b|\bprompt\s+(?:do\s+)?sistema\b|\bsuas?\s+instru[cç][oõ]es\b/i,
  },
  {
    why: 'tenta trocar o papel do agente',
    pattern:
      /\b(?:a\s+partir\s+de\s+agora\s+voc[eê]|voc[eê]\s+agora\s+[eé]|you\s+are\s+now|act\s+as|aja\s+como|finja\s+(?:ser|que)|pretend\s+(?:to\s+be|you))(?![\p{L}\p{N}])/iu,
  },
  {
    why: 'pede segredo',
    pattern:
      /\b(?:mostr|pass|envi|revel|compartilh|cole|show|send|reveal|give)\w*\s+(?:\w+\s+){0,3}(?:senhas?|tokens?|api[\s_-]?keys?|chaves?\s+(?:de\s+)?(?:api|acesso)|credenciais?|secrets?|segredos?|passwords?)\b/i,
  },
  {
    why: 'cita ferramentas internas do agente',
    pattern:
      /\b(?:load_tools|answer_mention|triage_comment|run_command|message_contact|vx_[a-z_]+|mcp__\w+)\b/i,
  },
  {
    why: 'imita a marcação das mensagens do agente',
    pattern: /<<<|>>>|<\/?\s*(?:system|instructions?|assistant|user)\s*>|\[\s*men[cç][aã]o\s*#/i,
  },
  {
    why: 'tem caractere invisível',
    pattern: /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u,
  },
  {
    why: 'tem bloco codificado',
    pattern: /[A-Za-z0-9+/]{120,}={0,2}/,
  },
];

const SECRET =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const hosts = (text: string) =>
  [...text.matchAll(/\bhttps?:\/\/([^/\s)>\]"']+)/gi)].map((match) =>
    (match[1] ?? '').toLowerCase().replace(/:\d+$/, ''),
  );

const excerpt = (text: string, index: number) =>
  text
    .slice(Math.max(0, index - 40), index + 80)
    .replace(/\s+/g, ' ')
    .trim();

/** Why a comment looks like an attempt to steer the agent, with the stretch that matched. */
export function injectionIn(body: string): { why: string; excerpt: string } | undefined {
  for (const rule of INJECTION) {
    const match = rule.pattern.exec(body);

    if (match) return { why: rule.why, excerpt: excerpt(body, match.index) };
  }

  const foreign = hosts(body).find((host) => !TRUSTED_IN.test(host));

  if (foreign) return { why: `tem link para fora da empresa (${foreign})`, excerpt: foreign };

  return undefined;
}

/** What keeps a reply off the card; empty when it may go. */
export function replyProblems(reply: string, allowedMentions: string[], limit = 1200): string[] {
  const problems: string[] = [];

  if (reply.length > limit) problems.push(`tem ${reply.length} caracteres (máximo ${limit})`);

  const foreign = hosts(reply).filter((host) => !TRUSTED_OUT.test(host));

  if (foreign.length) problems.push(`tem link para fora do Work (${foreign.join(', ')})`);

  const mentioned = [...reply.matchAll(/mention:([^)\s]+)/g)].map((match) => match[1] ?? '');
  const strangers = mentioned.filter((id) => !allowedMentions.includes(id));

  if (strangers.length) problems.push('marca alguém além de quem perguntou e do tech lead');
  if (SECRET.test(reply)) problems.push('tem algo com cara de segredo');

  const injection = injectionIn(reply);

  if (injection && !injection.why.startsWith('tem link')) problems.push(injection.why);

  return problems;
}
