import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PostgresStore } from '../storage/postgres.js';
import { Applications } from './service.js';

/**
 * Imports a design-system folder into an application, from the machine the gateway runs on:
 *
 *   node dist/applications/cli.js import <slug> <folder> [--name "Name"] [--source <url>]
 *
 * The folder holds `project/…` as Claude Design writes it. Files the owner edits in the panel
 * are kept as they are; everything else is replaced, so a file the source dropped goes too.
 * The application is created when it does not exist yet.
 */
async function walk(root: string, dir = root): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) files.push(...(await walk(root, path)));
    else files.push(relative(root, path).split(sep).join('/'));
  }

  return files;
}

function option(args: string[], name: string) {
  const at = args.indexOf(name);

  return at >= 0 ? args[at + 1] : undefined;
}

async function main() {
  const [command, slug, folder, ...rest] = process.argv.slice(2);
  const url = process.env.DATABASE_URL;

  if (command !== 'import' || !slug || !folder || !url) {
    console.error(
      'Usage: DATABASE_URL=… node dist/applications/cli.js import <slug> <folder> [--name N] [--source URL]',
    );
    process.exitCode = 2;
    return;
  }

  const store = new PostgresStore(url);
  const applications = new Applications(store);

  try {
    const name = option(rest, '--name');
    const source = option(rest, '--source');
    const existing = await applications.get(slug).catch(() => undefined);

    if (!existing) {
      await applications.create({ slug, name: name ?? slug, ...(source ? { source } : {}) });
    } else if (source || name) {
      await applications.update(slug, { ...(name ? { name } : {}), ...(source ? { source } : {}) });
    }

    const paths = (await walk(folder)).filter((path) => path.startsWith('project/'));
    const files = await Promise.all(
      paths.map(async (path) => ({ path, data: await readFile(join(folder, path)) })),
    );
    const done = await applications.put(slug, files, { keepOwnerFiles: true, replace: true });

    console.log(`${done.name}: ${done.files} files, design system version ${done.version}.`);
  } finally {
    await store.close();
  }
}

await main();
