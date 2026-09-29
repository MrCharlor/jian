// Release notes are the source; the changelog is their checked, newest-first copy.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const notesDir = join(root, 'docs/releases');
const target = join(root, 'CHANGELOG.md');
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?\.md$/;

function parse(file) {
  const match = versionPattern.exec(file);
  if (!match) throw new Error(`Invalid release note filename: ${file}`);

  const note = readFileSync(join(notesDir, file), 'utf8');
  const front = /^---\n([\s\S]*?)\n---\n/.exec(note);
  const date = /^date: (\d{4}-\d{2}-\d{2})$/m.exec(front?.[1] ?? '')?.[1];
  const summary = /^summary: (.+)$/m.exec(front?.[1] ?? '')?.[1];
  const body = front ? note.slice(front[0].length).trim() : '';
  if (!date || !body) throw new Error(`Invalid release note: ${file}`);

  return { version: file.slice(0, -3), date, summary, body, key: match.slice(1) };
}

function newestFirst(a, b) {
  for (let index = 0; index < 3; index += 1) {
    const difference = Number(b.key[index]) - Number(a.key[index]);
    if (difference) return difference;
  }
  if (!a.key[3] !== !b.key[3]) return a.key[3] ? 1 : -1;
  return (b.key[3] ?? '').localeCompare(a.key[3] ?? '', 'en', { numeric: true });
}

const notes = readdirSync(notesDir)
  .filter((file) => file.endsWith('.md'))
  .map(parse)
  .sort(newestFirst);
const changelog = [
  '# Changelog',
  '',
  'Every release of Jian, newest first.',
  '',
  '<!-- Generated from docs/releases by scripts/changelog.mjs. Edit the release note, then run `make changelog`. -->',
  '',
  ...notes.flatMap((note) => [
    `## ${note.version} — ${note.date}`,
    '',
    ...(note.summary ? [note.summary, ''] : []),
    note.body,
    '',
  ]),
].join('\n');

if (process.argv[2] === '--check') {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {}
  if (current !== changelog) {
    console.error('CHANGELOG.md is stale. Run make changelog.');
    process.exit(1);
  }
} else {
  writeFileSync(target, changelog);
}
