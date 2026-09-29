// Print a version's note for the GitHub release, validating the same file the gateway ships.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2] ?? '';

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Expected a release version.');
}

const file = join(dirname(fileURLToPath(import.meta.url)), `../docs/releases/${version}.md`);
const note = readFileSync(file, 'utf8');
const front = /^---\n([\s\S]*?)\n---\n/.exec(note);

if (
  !front ||
  !/^date: \d{4}-\d{2}-\d{2}$/m.test(front[1] ?? '') ||
  !note.slice(front[0].length).trim()
) {
  throw new Error(`Invalid release note: docs/releases/${version}.md`);
}

const summary = /^summary: (.+)$/m.exec(front[1] ?? '')?.[1];
process.stdout.write(`${summary ? `${summary}\n\n` : ''}${note.slice(front[0].length).trim()}\n`);
