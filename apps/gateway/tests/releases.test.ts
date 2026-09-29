import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { compareVersions, ReleaseNotes, readNotes } from '../src/releases/service.js';
import { releaseReads } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-release-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };

const note = (version: string) => ({
  version,
  date: '2026-09-24',
  body: `What ${version} changed.`,
  prerelease: version.includes('-'),
});
const history = ['2.2.0', '2.2.0-rc.1', '2.1.0', '2.0.0'].map(note);

describe('the release notes the panel announces', () => {
  it('parses every note this build carries', () => {
    const notes = readNotes();

    expect(notes.length).toBeGreaterThan(0);
    expect(notes.map((item) => item.version)).toEqual(['0.1.0']);
    expect(notes[0]?.body).toBe('Welcome to Jian.');
  });

  it('orders a candidate below the release it leads to', () => {
    expect(compareVersions('2.2.0-rc.1', '2.2.0')).toBeLessThan(0);
    expect(compareVersions('2.2.0-rc.2', '2.2.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('2.10.0', '2.9.0')).toBeGreaterThan(0);
  });

  it('announces the running release once, then only what is newer, and never goes back', async () => {
    const { store } = await testServices();
    const at = (version: string) => new ReleaseNotes(store, version, history);

    // A first visit: the running release alone, not the history behind it.
    expect((await at('2.1.0').releases()).unseen.map((item) => item.version)).toEqual(['2.1.0']);
    await at('2.1.0').markSeen();
    expect((await at('2.1.0').releases()).unseen).toEqual([]);

    // An update to a stable release skips the candidate it never ran.
    const updated = await at('2.2.0').releases();

    expect(updated.unseen.map((item) => item.version)).toEqual(['2.2.0']);
    expect(updated.notes.map((item) => item.version)).toEqual(['2.2.0', '2.1.0', '2.0.0']);

    await at('2.2.0').markSeen();
    // A tab still on the older build closes late: the newer mark stands.
    await at('2.1.0').markSeen();
    expect((await at('2.2.0').releases()).unseen).toEqual([]);
  });

  it('announces nothing on a build with no version stamped on it', async () => {
    const { store } = await testServices();

    expect(await new ReleaseNotes(store, undefined, history).releases()).toEqual({
      notes: [],
      unseen: [],
    });
    expect((await new ReleaseNotes(store, '0.0.0-dev', history).releases()).unseen).toEqual([]);
  });

  it('announces the relaunch even after an earlier release was marked read', async () => {
    const { store } = await testServices();
    const welcome = note('0.1.0');

    await store.db.insert(releaseReads).values({ scope: 'owner', version: '2.5.0' });
    const relaunched = new ReleaseNotes(store, '0.1.0', [welcome]);

    expect((await relaunched.releases()).unseen).toEqual([welcome]);
    await relaunched.markSeen();
    expect((await relaunched.releases()).unseen).toEqual([]);
    expect(
      (await store.db.select().from(releaseReads)).map((row) => [row.scope, row.version]),
    ).toEqual(
      expect.arrayContaining([
        ['owner', '2.5.0'],
        ['owner-relaunch', '0.1.0'],
      ]),
    );
  });

  it('is read and marked only by the owner', async () => {
    const services = await testServices();
    const app = createApp({
      ...services,
      releases: new ReleaseNotes(services.store, '2.1.0', history),
      token,
      logger: false,
    });

    try {
      expect((await app.inject({ url: '/v1/releases' })).statusCode).toBe(401);

      const read = await app.inject({ url: '/v1/releases', headers: admin });

      expect(read.json()).toMatchObject({ version: '2.1.0', unseen: [{ version: '2.1.0' }] });

      const seen = await app.inject({ method: 'POST', url: '/v1/releases/seen', headers: admin });

      expect(seen.json()).toMatchObject({ version: '2.1.0', unseen: [] });
    } finally {
      await app.close();
    }
  });
});
