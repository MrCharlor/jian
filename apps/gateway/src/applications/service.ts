import { randomUUID } from 'node:crypto';
import {
  type Application,
  applicationFileQuerySchema,
  applicationFileWriteSchema,
  applicationInputSchema,
  applicationPatchSchema,
  applicationPathSchema,
  OWNER_FILES,
} from '@jian/contracts';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { isUniqueViolation } from '../providers/repository.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  deleteApplication,
  deleteFile,
  findApplication,
  insertApplication,
  listApplications,
  listFiles,
  readFile,
  updateApplication,
  writeFile,
} from './repository.js';

/** What a design system's text files are; everything else is kept as bytes. */
const TEXT = /^(text\/|application\/(json|javascript|typescript)|image\/svg)/;

export function contentTypeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const types: Record<string, string> = {
    md: 'text/markdown',
    html: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    json: 'application/json',
    ts: 'text/plain',
    txt: 'text/plain',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    woff2: 'font/woff2',
    woff: 'font/woff',
  };

  return types[ext] ?? 'application/octet-stream';
}

export const isText = (contentType: string) => TEXT.test(contentType);

/** Tool reads stay inside a context budget; a component's notes fit, a bundle never does. */
const READ_LIMIT = 60_000;

/**
 * The products the owner designs for, each with its design system as files. Installation-wide,
 * like providers: every agent reads them, and only the owner changes them — in the panel or by
 * importing a design system folder.
 */
export class Applications {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  list() {
    return listApplications(this.store.db);
  }

  async get(slug: string, reader: Queryable = this.store.db): Promise<Application> {
    return assertFound(await findApplication(reader, slug), 'Application');
  }

  async create(input: unknown): Promise<Application> {
    const data = applicationInputSchema.parse(input);
    const now = new Date(this.clock());

    try {
      await insertApplication(this.store.db, {
        id: randomUUID(),
        slug: data.slug,
        name: data.name,
        url: data.url ?? null,
        audience: data.audience ?? null,
        platform: data.platform,
        source: data.source ?? null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GatewayError(409, `An application named ${data.slug} already exists`);
      }
      throw error;
    }

    return this.get(data.slug);
  }

  async update(slug: string, input: unknown): Promise<Application> {
    const current = await this.get(slug);
    const data = applicationPatchSchema.parse(input);

    await updateApplication(this.store.db, current.id, {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.audience !== undefined ? { audience: data.audience } : {}),
      ...(data.platform !== undefined ? { platform: data.platform } : {}),
      ...(data.source !== undefined ? { source: data.source } : {}),
      updatedAt: new Date(this.clock()),
    });

    return this.get(slug);
  }

  async remove(slug: string): Promise<Application> {
    const current = await this.get(slug);

    await deleteApplication(this.store.db, current.id);

    return current;
  }

  async files(slug: string) {
    const current = await this.get(slug);

    return listFiles(this.store.db, current.id);
  }

  async readText(slug: string, query: unknown) {
    const { path } = applicationFileQuerySchema.parse(query);
    const current = await this.get(slug);
    const file = assertFound(await readFile(this.store.db, current.id, path), 'File');

    if (file.encoding !== 'utf8') {
      throw new GatewayError(415, `${path} is not a text file`);
    }

    return { path, contentType: file.contentType, text: file.content };
  }

  /** An image of the design system, such as a photo or a logo a screen shows. */
  async readImage(slug: string, query: unknown) {
    const { path } = applicationFileQuerySchema.parse(query);
    const current = await this.get(slug);
    const file = assertFound(await readFile(this.store.db, current.id, path), 'File');

    if (!file.contentType.startsWith('image/') || file.encoding !== 'base64') {
      throw new GatewayError(415, `${path} is not an image`);
    }

    return { contentType: file.contentType, data: Buffer.from(file.content, 'base64') };
  }

  /** The owner's own edit of a text file, such as the PO preferences. */
  async writeText(slug: string, query: unknown, input: unknown) {
    const { path } = applicationFileQuerySchema.parse(query);
    const { text } = applicationFileWriteSchema.parse(input);
    const contentType = contentTypeOf(path);

    if (!isText(contentType)) {
      throw new GatewayError(415, `${path} is not a text file`);
    }

    await this.put(slug, [{ path, data: Buffer.from(text, 'utf8') }]);

    return this.readText(slug, { path });
  }

  /**
   * Writes design-system files and bumps the version once. `keepOwnerFiles` is how a re-import
   * from the source leaves the owner's own files as they wrote them.
   */
  async put(
    slug: string,
    files: Array<{ path: string; data: Buffer }>,
    options: { keepOwnerFiles?: boolean; replace?: boolean } = {},
  ): Promise<Application> {
    const current = await this.get(slug);
    const now = new Date(this.clock());
    const kept = new Set<string>(options.keepOwnerFiles ? OWNER_FILES : []);

    await this.store.transaction(current.id, async (tx) => {
      if (options.replace) {
        for (const existing of await listFiles(tx, current.id)) {
          if (!kept.has(existing.path)) await deleteFile(tx, current.id, existing.path);
        }
      }

      for (const file of files) {
        const path = applicationPathSchema.parse(file.path);

        if (kept.has(path) && (await readFile(tx, current.id, path))) continue;

        const contentType = contentTypeOf(path);
        const text = isText(contentType);

        await writeFile(tx, {
          applicationId: current.id,
          path,
          contentType,
          encoding: text ? 'utf8' : 'base64',
          content: text ? file.data.toString('utf8') : file.data.toString('base64'),
          bytes: file.data.byteLength,
          updatedAt: now,
        });
      }

      await updateApplication(tx, current.id, { version: current.version + 1, updatedAt: now });
    });

    return this.get(slug);
  }

  /**
   * What an agent reads before it designs for an application: the guide, the owner's
   * preferences, the tokens, and the list of components with the first lines of their notes.
   * A component's whole notes and types are one more read, by path.
   */
  async brief(slug: string): Promise<string> {
    const current = await this.get(slug);
    const files = await listFiles(this.store.db, current.id);
    const text = async (path: string) => {
      const row = await readFile(this.store.db, current.id, path);

      return row?.encoding === 'utf8' ? row.content : undefined;
    };
    const readme = (await text('project/README.md')) ?? '';
    const preferences = (await text('project/preferencias-do-po.md')) ?? '';
    const tokens = (await text('project/tokens.json')) ?? '';
    const components = files
      .map((file) => /^project\/components\/([^/]+)\/README\.md$/.exec(file.path)?.[1])
      .filter((name): name is string => Boolean(name));
    const index: string[] = [];

    for (const name of components) {
      const notes = (await text(`project/components/${name}/README.md`)) ?? '';
      const first = notes
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith('#'));

      index.push(`- ${name}${first ? `: ${first.slice(0, 160)}` : ''}`);
    }

    const brief = [
      `# ${current.name} (${current.slug})`,
      current.url ? `Address: ${current.url}` : '',
      current.audience ? `Who uses it: ${current.audience}` : '',
      `Platform: ${current.platform} · design system version ${current.version}`,
      '',
      preferences ? `## Owner preferences (these win over the guide)\n\n${preferences}` : '',
      // The guide is long; its outline tells the agent which parts to read for this screen.
      readme
        ? `## Guide (read it whole with read_design_file: project/README.md)\n\n${readme
            .split('\n')
            .filter((line) => /^#{1,3} /.test(line))
            .join('\n')}`
        : '## Guide\n\nNo guide yet.',
      tokens ? `## Tokens\n\n\`\`\`json\n${tokens}\n\`\`\`` : '',
      components.length
        ? `## Components (read one with read_design_file: project/components/<Name>/README.md or <Name>.d.ts)\n\n${index.join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return brief.length > READ_LIMIT
      ? `${brief.slice(0, READ_LIMIT)}\n\n[Cut at ${READ_LIMIT} characters; read the rest by file.]`
      : brief;
  }

  async readForAgent(slug: string, path: string): Promise<string> {
    const { text } = await this.readText(slug, { path });

    return text.length > READ_LIMIT ? `${text.slice(0, READ_LIMIT)}\n\n[Cut.]` : text;
  }
}
