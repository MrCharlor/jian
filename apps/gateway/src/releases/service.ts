import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReleaseNote, Releases } from '@jian/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Store } from '../storage/database.js';
import { releaseReads } from '../storage/schema.js';

/** A new reading history for the 0.1.0 relaunch; the previous one stays available on rollback. */
const OWNER = 'owner-relaunch';

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/**
 * Where this build's notes are: copied next to the compiled server by the build, or read from
 * the repository when the gateway runs from source.
 */
const LOCATIONS = [
  new URL('../release-notes/', import.meta.url),
  new URL('../../../../docs/releases/', import.meta.url),
];

/** Semantic order; a candidate sorts below the release it leads to. */
export function compareVersions(a: string, b: string): number {
  const left = VERSION.exec(a);
  const right = VERSION.exec(b);

  if (!left || !right) {
    return a.localeCompare(b);
  }

  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index]);

    if (difference) return difference;
  }

  if (!left[4] !== !right[4]) return left[4] ? -1 : 1;

  return (left[4] ?? '').localeCompare(right[4] ?? '', 'en', { numeric: true });
}

/** One note file: `date` and an optional `summary` in the front matter, Markdown after it. */
export function parseNote(file: string, text: string): ReleaseNote {
  const version = file.replace(/\.md$/, '');
  const match = VERSION.exec(version);
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);

  if (!match || !front) {
    throw new Error(`${file}: a version name and a front matter are both required`);
  }

  const fields = Object.fromEntries(
    (front[1] ?? '').split('\n').flatMap((line) => {
      const split = line.indexOf(':');

      return split > 0 ? [[line.slice(0, split).trim(), line.slice(split + 1).trim()]] : [];
    }),
  );

  const date = fields.date ?? '';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${file}: date must be YYYY-MM-DD`);
  }

  return {
    version,
    date,
    ...(fields.summary ? { summary: fields.summary } : {}),
    body: text.slice(front[0].length).trim(),
    prerelease: Boolean(match[4]),
  };
}

export function readNotes(directory?: URL): ReleaseNote[] {
  const location = directory ?? LOCATIONS.find((item) => existsSync(fileURLToPath(item)));

  if (!location) {
    return [];
  }

  return readdirSync(location)
    .filter((file) => file.endsWith('.md'))
    .map((file) => parseNote(file, readFileSync(new URL(file, location), 'utf8')))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * What this installation runs and what changed in it. The notes come with the build; how far
 * the owner has read comes from the database, so the dialog opens once per update whichever
 * browser they sign in from.
 */
export class ReleaseNotes {
  private readonly version: string | undefined;

  constructor(
    private readonly store: Store,
    version: string | undefined,
    private readonly notes: ReleaseNote[] = readNotes(),
  ) {
    const stamped = version?.replace(/^v/, '');

    // A build with no version, or a placeholder one, is a developer's: nothing to announce.
    this.version =
      stamped && VERSION.test(stamped) && stamped !== '0.0.0-dev' ? stamped : undefined;
  }

  async releases(): Promise<Releases> {
    const running = this.version;
    // A stable installation reads stable releases; the candidates it never ran are noise.
    const candidate = Boolean(running && VERSION.exec(running)?.[4]);
    const known = running
      ? this.notes.filter(
          (note) => compareVersions(note.version, running) <= 0 && (candidate || !note.prerelease),
        )
      : [];
    const seen = await this.seen();

    return {
      ...(running ? { version: running } : {}),
      notes: known,
      // A first visit shows the running release alone; the history behind it is there to read,
      // not to be announced. After that, everything newer than what was last shown.
      unseen: running
        ? known.filter((note) =>
            seen ? compareVersions(note.version, seen) > 0 : note.version === running,
          )
        : [],
    };
  }

  /** Only ever forward: a second tab closing late must not show the same notes again. */
  async markSeen(): Promise<Releases> {
    const running = this.version;

    if (running) {
      const seen = await this.seen();

      if (!seen || compareVersions(running, seen) > 0) {
        await this.store.db
          .insert(releaseReads)
          .values({ scope: OWNER, version: running })
          .onConflictDoUpdate({
            target: releaseReads.scope,
            set: { version: running, updatedAt: sql`now()` },
          });
      }
    }

    return this.releases();
  }

  private async seen(): Promise<string | undefined> {
    const [row] = await this.store.db
      .select({ version: releaseReads.version })
      .from(releaseReads)
      .where(eq(releaseReads.scope, OWNER))
      .limit(1);

    return row?.version;
  }
}
