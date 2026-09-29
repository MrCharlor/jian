// Cuts a release: `make release VERSION=1.2.3`. The note comes first, then the tag;
// the Image workflow publishes the image and GitHub release.
// Everything that can be wrong is checked before anything is written or pushed.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const stop = (message) => {
  console.error(message);
  process.exit(1);
};

const version = process.argv[2] ?? '';

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  stop('usage: make release VERSION=1.2.3   (or 1.2.3-rc.1 for a candidate)');
}

if (!existsSync(join(root, `docs/releases/${version}.md`))) {
  stop(`Write docs/releases/${version}.md first: it is the GitHub release note.`);
}

execFileSync('node', [join(root, 'scripts/release-notes.mjs'), version], { stdio: 'ignore' });

if (git('branch', '--show-current') !== 'main') {
  stop('Release from main.');
}

if (git('status', '--porcelain')) {
  stop('The working tree has changes: commit or stash them first.');
}

git('fetch', '--quiet', '--tags', 'origin', 'main');

if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) {
  stop('main is not what origin/main is: pull or push first, so the tag names a published commit.');
}

if (git('tag', '--list', `v${version}`)) {
  stop(`v${version} already exists. A published version is never moved; release the next one.`);
}

// The image takes its version from the tag; package.json stays 0.1.0, since nothing reads it.
git('tag', '-a', `v${version}`, '-m', `Jian ${version}`);
git('push', 'origin', `v${version}`);

console.log(`Tagged v${version}. The Image workflow builds it and publishes the release.`);
