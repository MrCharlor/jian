import type { KnowledgeScope } from '@jian/contracts';

/**
 * How a rule is found by words and by where it holds. The base is a few hundred rules, read
 * whole and matched here: the same answer in PostgreSQL and in the tests' database, with no
 * text-search dictionary to install.
 */

/** Lower case, no accents, words only: "Listagens do ERP" and "listagem do erp" meet. */
export const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const STOP = new Set([
  'para',
  'com',
  'que',
  'dos',
  'das',
  'uma',
  'por',
  'nao',
  'sem',
  'mais',
  'como',
  'pelo',
  'pela',
  'nos',
  'nas',
  'sao',
  'ser',
  'tem',
  'quando',
  'onde',
  'qual',
  'este',
  'esta',
  'isso',
  'cada',
  'entre',
  'sobre',
  'apos',
  'ate',
  'seu',
  'sua',
  'the',
  'and',
]);

/** A light plural fold, enough for "listagens" to meet "listagem" and "cores" to meet "cor". */
const stem = (word: string) =>
  word.endsWith('oes')
    ? `${word.slice(0, -3)}ao`
    : word.endsWith('ns')
      ? `${word.slice(0, -2)}m`
      : word.endsWith('es') && word.length > 4
        ? word.slice(0, -2)
        : word.endsWith('s') && word.length > 3
          ? word.slice(0, -1)
          : word;

/** The distinct meaningful words of a text, folded. */
export function words(value: string): string[] {
  return [
    ...new Set(
      fold(value)
        .split(' ')
        .filter((word) => word.length >= 3 && !STOP.has(word))
        .map(stem),
    ),
  ];
}

/** Two names of the same thing: equal once folded, or one inside the other ("ERP", "VXCASE ERP"). */
export function sameName(a: string | undefined, b: string | undefined) {
  const left = a ? fold(a) : '';
  const right = b ? fold(b) : '';

  if (!left || !right) return false;

  return left === right || ` ${left} `.includes(` ${right} `) || ` ${right} `.includes(` ${left} `);
}

/** How many of the wanted words the text has. */
export function hits(wanted: string[], text: string) {
  const have = new Set(words(text));

  return wanted.filter((word) => have.has(word)).length;
}

/** What a rule is about, as words: its text, where it holds and its code. */
export const haystack = (rule: { text: string; scope: KnowledgeScope; code?: string | null }) =>
  [rule.text, rule.scope.application ?? '', rule.scope.screen ?? '', rule.code ?? ''].join(' ');

/** The scope as the owner reads it: "toda listagem do ERP", "tela Cores de Aparelhos". */
export function scopeLabel(scope: KnowledgeScope) {
  switch (scope.kind) {
    case 'geral':
      return 'geral';
    case 'aplicacao':
      return `aplicação ${scope.application}`;
    case 'tipo_de_tela':
      return `toda ${scope.screen}${scope.application ? ` do ${scope.application}` : ''}`;
    case 'tela':
      return `tela ${scope.screen}${scope.application ? ` (${scope.application})` : ''}`;
  }
}
