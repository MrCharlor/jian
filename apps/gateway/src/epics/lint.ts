/**
 * The rules the owner set for epics and tasks, each learned from a card he sent back. A draft
 * shows every one it breaks before he reads it; none of them blocks the create on its own.
 */
type Draft = {
  title: string;
  description: string;
  tasks: Array<{ title: string; description: string; criteria: string[] }>;
  images: Array<{ caption: string; task?: number }>;
};

const EPIC_SECTIONS = ['Hoje', 'Esperado', 'Decisões', 'Ordem de execução', 'Pronto quando'];
const TASK_SECTIONS = ['Contexto', 'Hoje', 'Regras de negócio', 'Referências técnicas'];

/** The body of a "## Name" section, up to the next one; undefined when there is none. */
const section = (text: string, name: string) => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${name}`.toLowerCase());

  if (start < 0) return undefined;

  const end = lines.findIndex((line, index) => index > start && /^##\s/.test(line));

  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
};

/** A line that asks instead of deciding; a link or code with "?" does not count. */
const openQuestions = (text: string) =>
  text
    .split('\n')
    .map((line) =>
      line
        .replace(/`[^`]*`/g, '')
        .replace(/\]\([^)]*\)/g, ']')
        .replace(/https?:\/\/\S+/g, ''),
    )
    .filter((line) => /\?\s*$/.test(line.trim()) || /\?\s+[A-ZÁÉÍÓÚ]/.test(line));

export function lintDraft(draft: Draft): string[] {
  const problems: string[] = [];
  const everything = [
    draft.title,
    draft.description,
    ...draft.tasks.flatMap((task) => [task.title, task.description, ...task.criteria]),
  ].join('\n');

  if (!draft.title.startsWith('[EPIC] '))
    problems.push('O título do épico não começa com "[EPIC] ".');

  for (const name of EPIC_SECTIONS) {
    if (section(draft.description, name) === undefined) {
      problems.push(`O épico não tem a seção "${name}".`);
    }
  }

  if (/^##\s+Fora do épico/m.test(draft.description)) {
    problems.push('O épico tem "Fora do épico"; o que estiver fora vira card próprio.');
  }

  if (/make test/i.test(section(draft.description, 'Pronto quando') ?? '')) {
    problems.push('O "Pronto quando" do épico cita make test; isso vai no checklist das tasks.');
  }

  if (draft.tasks.length > 8) {
    problems.push(`O épico tem ${draft.tasks.length} tasks; acima de 8, vale dividir em dois.`);
  }

  if (/input técnico/i.test(everything)) {
    problems.push(
      'Há texto de instrução do modelo ("input técnico"); a ordem de execução sai fechada.',
    );
  }

  if (/ [—–] /.test(everything)) problems.push('Há travessão no texto.');

  for (const line of openQuestions(everything)) {
    problems.push(`Pergunta aberta: "${line.trim().slice(0, 120)}".`);
  }

  draft.tasks.forEach((task, index) => {
    const where = `Task ${index + 1} ("${task.title.slice(0, 60)}")`;
    const first = task.title.split(/\s+/)[0] ?? '';

    if (!/(ar|er|ir|or)$/i.test(first)) {
      problems.push(`${where}: o título não começa com verbo no infinitivo.`);
    }

    for (const name of TASK_SECTIONS) {
      if (section(task.description, name) === undefined) {
        problems.push(`${where}: falta a seção "${name}".`);
      }
    }

    const rules = [...new Set(task.description.match(/\bRN-\d+\b/g) ?? [])];

    for (const rule of rules) {
      if (!task.criteria.some((criterion) => criterion.includes(`(${rule})`))) {
        problems.push(`${where}: ${rule} não tem critério de aceite.`);
      }
    }

    if (!/make test/i.test(task.criteria.at(-1) ?? '')) {
      problems.push(`${where}: o último critério não é o make test.`);
    }
  });

  for (const image of draft.images) {
    if (/legado/i.test(image.caption)) {
      problems.push(
        `O print "${image.caption.slice(0, 60)}" parece da tela antiga; print só da tela nova.`,
      );
    }
  }

  return problems;
}
