/** Accents the owner skips when typing fast in a chat; only the obvious ones. */
const SPELLING: Record<string, string> = {
  nao: 'não',
  entao: 'então',
  tambem: 'também',
  voce: 'você',
  botao: 'botão',
  pagina: 'página',
  informacao: 'informação',
  acao: 'ação',
  validacao: 'validação',
  funcao: 'função',
  configuracao: 'configuração',
  numero: 'número',
  codigo: 'código',
  usuario: 'usuário',
};

/** No em or en dash: a comma reads the same and does not sound written by a model. */
export function noDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',');
}

/** The obvious accents back, keeping the capital of a word that starts a sentence. */
export function accents(text: string): string {
  return text.replace(/\p{L}+/gu, (word) => {
    const fixed = SPELLING[word.toLowerCase()];
    if (!fixed) return word;
    return word[0] === word[0]?.toUpperCase()
      ? `${fixed.charAt(0).toUpperCase()}${fixed.slice(1)}`
      : fixed;
  });
}
