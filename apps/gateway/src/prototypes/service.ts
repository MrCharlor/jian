import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Prototype, prototypeInputSchema, prototypeRedoSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import type { Applications } from '../applications/service.js';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Quality } from '../quality/service.js';
import type { Store } from '../storage/database.js';
import { applicationFiles, applications } from '../storage/schema.js';
import { claudeCode, type Generator } from './generator.js';
import {
  claimNext,
  failAbandoned,
  findPrototypeRow,
  insertPrint,
  insertPrototype,
  insertVersion,
  listPrints,
  listPrototypeRows,
  listVersions,
  toVersion,
  updatePrototype,
  updateVersion,
  versionHtml,
} from './repository.js';

/** The longest page a generation may keep; a screen is far below this. */
const HTML_LIMIT = 2_000_000;

const OUTPUT = 'prototipo.html';

/** Where an agent that asked for a prototype is told it is ready. */
type Notifier = (
  profileId: string,
  sessionId: string,
  text: string,
  key: string,
) => Promise<unknown>;

/**
 * The instructions Claude Code reads first in the folder. The design system's own guide and the
 * owner's preferences sit next to it; this says what to build and in what shape, so the screen
 * opens in the panel with the same runtime as a component preview.
 */
function instructions(name: string, platform: string) {
  return `# Protótipo para ${name}

Você está numa pasta de trabalho do Jian. Faça **uma tela interativa** e grave em \`${OUTPUT}\`.

## Leia antes, nesta ordem
1. \`pedido.md\`: o que a tela precisa fazer, de qual pedido veio, e os comentários do PO se for uma nova versão.
2. \`design-system/project/preferencias-do-po.md\`: regras do PO. **Valem por cima de tudo.**
3. \`design-system/project/README.md\`: o guia do design system. Siga a estrutura de página, os textos e as regras dele.
4. Os componentes que for usar: \`design-system/project/components/<Nome>/README.md\` e \`<Nome>.d.ts\`.
5. \`prints/\`, se houver: a tela de hoje ou um rascunho. É ponto de partida, não cópia.
6. \`anterior.html\`, se houver: a versão anterior. Mude só o que os comentários pedem.

## Formato do arquivo
- Um HTML só, completo (\`<!doctype html>\`), plataforma ${platform}.
- React e os componentes **já estarão carregados** quando a tela abrir: \`window.React\`, \`window.ReactDOM\` e \`window.VXCase\` (ou o namespace que o guia indicar), com o CSS do design system. **Não** inclua \`<script src>\` nem \`<link>\` para eles.
- Todo o seu código vai num único \`<script>\` no fim do \`<body>\`, em JavaScript puro, sem JSX e sem build: use \`const h = React.createElement\`.
- Nada de rede: sem fetch, sem CDN, sem imagens externas. Dados de exemplo ficam no próprio arquivo.
- A tela funciona de verdade: filtros filtram, botões abrem o que abririam, confirmações aparecem. Use os dados de exemplo que as preferências do PO pedem.
- Textos em português, como o guia manda. Nada de nome técnico na tela.

## Ao terminar
Confira que \`${OUTPUT}\` existe e que o script não tem erro de sintaxe. Responda em uma linha o que a tela tem.
`;
}

/**
 * Screens drawn by Claude Code on this machine, from an application's design system and a
 * request. One generation runs at a time, in the background; every version is kept, and the
 * owner's comments between versions count as corrections of the `prototipo:<app>` automation.
 */
export class Prototypes {
  private running = false;
  private notifier?: Notifier;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: Store,
    private readonly applications: Pick<Applications, 'get'>,
    private readonly quality?: Pick<Quality, 'record'>,
    private readonly generate: Generator = claudeCode,
    private readonly root: string = process.env.JIAN_PROTOTYPES_DIR ||
      join(homedir(), 'prototypes'),
    private readonly clock: Clock = Date.now,
  ) {}

  useNotifier(notifier: Notifier) {
    this.notifier = notifier;
  }

  stop() {
    this.abort.abort();
  }

  private async view(id: string): Promise<Prototype> {
    const row = assertFound(await findPrototypeRow(this.store.db, id), 'Prototype');
    const [versions, prints] = await Promise.all([
      listVersions(this.store.db, id),
      listPrints(this.store.db, id),
    ]);
    const { prototype, slug } = row;

    return {
      id: prototype.id,
      application: slug,
      title: prototype.title,
      ...(prototype.requestUrl ? { requestUrl: prototype.requestUrl } : {}),
      brief: prototype.brief,
      prints: prints.map((print) => print.name),
      createdBy: prototype.createdBy as Prototype['createdBy'],
      ...(prototype.approvedVersion ? { approvedVersion: prototype.approvedVersion } : {}),
      versions: versions.map(toVersion),
      createdAt: prototype.createdAt.toISOString(),
      updatedAt: prototype.updatedAt.toISOString(),
    };
  }

  get(id: string) {
    return this.view(id);
  }

  async list(application?: string): Promise<Prototype[]> {
    const app = application ? await this.applications.get(application) : undefined;
    const rows = await listPrototypeRows(this.store.db, app?.id);

    return Promise.all(rows.map(({ prototype }) => this.view(prototype.id)));
  }

  /** A new prototype, its first version waiting for the generator. */
  async create(
    input: unknown,
    by:
      | { kind: 'owner'; profileId?: string }
      | { kind: 'agent'; profileId: string; sessionId: string },
  ): Promise<Prototype> {
    const data = prototypeInputSchema.parse(input);
    const app = await this.applications.get(data.application);

    if (!app.files) {
      throw new GatewayError(409, `${app.name} has no design system yet; bring one in first`);
    }

    const id = randomUUID();
    const now = new Date(this.clock());

    await this.store.transaction(id, async (tx) => {
      await insertPrototype(tx, {
        id,
        applicationId: app.id,
        title: data.title,
        requestUrl: data.requestUrl ?? null,
        brief: data.brief,
        createdBy: by.kind,
        // The agent that asked, or the one open in the panel: whose quality the rounds count in.
        profileId: by.profileId ?? null,
        sessionId: by.kind === 'agent' ? by.sessionId : null,
        createdAt: now,
        updatedAt: now,
      });

      for (const print of data.prints) {
        await insertPrint(tx, {
          prototypeId: id,
          name: print.name,
          contentType: print.contentType,
          content: print.data,
        });
      }

      await insertVersion(tx, { prototypeId: id, number: 1, status: 'queued', createdAt: now });
    });

    return this.view(id);
  }

  /** Another version from the last one and the owner's comments, which count as a correction. */
  async redo(id: string, input: unknown, via: 'panel' | 'channel' | 'api' = 'panel') {
    const { comments } = prototypeRedoSchema.parse(input);
    const current = await this.view(id);
    const row = assertFound(await findPrototypeRow(this.store.db, id), 'Prototype');
    const last = current.versions.at(-1);

    if (last && ['queued', 'generating'].includes(last.status)) {
      throw new GatewayError(409, `Version ${last.number} is still being made`);
    }

    const number = (last?.number ?? 0) + 1;
    const now = new Date(this.clock());

    await this.store.transaction(id, async (tx) => {
      await insertVersion(tx, {
        prototypeId: id,
        number,
        status: 'queued',
        comments,
        createdAt: now,
      });
      await updatePrototype(tx, id, { updatedAt: now });
      if (row.prototype.profileId) {
        await this.quality?.record(tx, row.prototype.profileId, {
          kind: 'redone',
          via,
          action: `prototipo:${current.application}`,
          note: comments,
          ...(last ? { original: `${current.title}, versão ${last.number}` } : {}),
        });
      }
    });

    return this.view(id);
  }

  async approve(id: string, number: number) {
    const current = await this.view(id);
    const version = current.versions.find((item) => item.number === number);

    if (version?.status !== 'ready') {
      throw new GatewayError(409, `Version ${number} is not ready`);
    }

    await updatePrototype(this.store.db, id, {
      approvedVersion: number,
      updatedAt: new Date(this.clock()),
    });

    return this.view(id);
  }

  /** The screen of a ready version, for the signed preview address. */
  async html(id: string, number: number): Promise<{ slug: string; html: string }> {
    const row = assertFound(await findPrototypeRow(this.store.db, id), 'Prototype');
    const html = assertFound(await versionHtml(this.store.db, id, number), 'Version');

    return { slug: row.slug, html };
  }

  /** Called on the worker's tick: makes the next waiting version, one at a time. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      for (;;) {
        const next = await claimNext(this.store.db, new Date(this.clock()));

        if (!next) return;

        await this.make(next.prototypeId, next.number);
      }
    } finally {
      this.running = false;
    }
  }

  /** At start-up, before the first tick: nothing is being made by a process that is gone. */
  recover() {
    return failAbandoned(this.store.db, new Date(this.clock()));
  }

  private async make(id: string, number: number) {
    const started = this.clock();
    const folder = join(this.root, id, `v${number}`);

    try {
      await this.prepare(id, number, folder);

      const outcome = await this.generate(
        folder,
        'Leia CLAUDE.md e faça a tela pedida. Grave o resultado em prototipo.html.',
        this.abort.signal,
      );

      if (!outcome.ok) throw new Error(outcome.error);

      const html = await readFile(join(folder, OUTPUT), 'utf8').catch(() => {
        throw new Error(`Claude Code finished without writing ${OUTPUT}`);
      });

      if (html.length > HTML_LIMIT) throw new Error('The screen is too large to keep');

      const finished = new Date(this.clock());

      await updateVersion(this.store.db, id, number, {
        status: 'ready',
        html,
        durationMs: finished.getTime() - started,
        finishedAt: finished,
      });
      await updatePrototype(this.store.db, id, { updatedAt: finished });
      await this.tell(id, number, 'pronta');
    } catch (error) {
      const finished = new Date(this.clock());

      await updateVersion(this.store.db, id, number, {
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
        durationMs: finished.getTime() - started,
        finishedAt: finished,
      });
      await this.tell(id, number, 'falhou');
    } finally {
      // The design system copy is large and rebuilt every time; the screen is in the database.
      await rm(join(folder, 'design-system'), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Writes the folder Claude Code works in: design system, request, prints, the last version. */
  private async prepare(id: string, number: number, folder: string) {
    const row = assertFound(await findPrototypeRow(this.store.db, id), 'Prototype');
    const [app] = await this.store.db
      .select()
      .from(applications)
      .where(eq(applications.id, row.prototype.applicationId))
      .limit(1);
    const files = await this.store.db
      .select()
      .from(applicationFiles)
      .where(eq(applicationFiles.applicationId, row.prototype.applicationId));
    const versions = await listVersions(this.store.db, id);
    const current = versions.find((item) => item.number === number);
    const previous = versions.filter((item) => item.number < number && item.html).at(-1);
    const prints = await listPrints(this.store.db, id);

    await rm(folder, { recursive: true, force: true });
    await mkdir(join(folder, 'prints'), { recursive: true });

    for (const file of files) {
      const target = join(folder, 'design-system', file.path);

      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        file.encoding === 'base64' ? Buffer.from(file.content, 'base64') : file.content,
      );
    }

    for (const print of prints) {
      await writeFile(join(folder, 'prints', print.name), Buffer.from(print.content, 'base64'));
    }

    if (previous?.html) await writeFile(join(folder, 'anterior.html'), previous.html);

    await writeFile(
      join(folder, 'pedido.md'),
      [
        `# ${row.prototype.title}`,
        row.prototype.requestUrl ? `Pedido no Work: ${row.prototype.requestUrl}` : '',
        '',
        '## O que a tela precisa fazer',
        row.prototype.brief,
        current?.comments
          ? `\n## Comentários do PO sobre a versão ${previous?.number ?? number - 1}\n${current.comments}`
          : '',
        prints.length
          ? `\n## Prints\n${prints.map((print) => `- prints/${print.name}`).join('\n')}`
          : '',
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
    );
    await writeFile(
      join(folder, 'CLAUDE.md'),
      instructions(app?.name ?? row.slug, app?.platform ?? 'web'),
    );
  }

  private async tell(id: string, number: number, outcome: 'pronta' | 'falhou') {
    const row = await findPrototypeRow(this.store.db, id);
    const { profileId, sessionId, title } = row?.prototype ?? {};

    if (!this.notifier || !profileId || !sessionId) return;

    await this.notifier(
      profileId,
      sessionId,
      `[Protótipo] "${title}", versão ${number}: ${outcome}. Leia com read_prototype (${id}).`,
      `prototype:${id}:${number}`,
    ).catch(() => {});
  }
}
