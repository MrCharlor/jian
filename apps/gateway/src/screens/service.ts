import { randomUUID } from 'node:crypto';
import {
  type ScreenRecord,
  screenInventoryInputSchema,
  screenListQuerySchema,
  screenPrintsInputSchema,
  screenSheetInputSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Applications } from '../applications/service.js';
import type { Clock } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { applications, screenPrints, screens } from '../storage/schema.js';

/** Prints kept per screen: enough for the tabs and states of one screen, not a whole module. */
const PRINTS_PER_SCREEN = 12;

type PrintType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * The image type the bytes actually are, whatever the name or the sender says. A print is shown
 * in the panel and handed to the prototype, so only the three formats both read get in.
 */
export function imageType(bytes: Uint8Array): PrintType | undefined {
  const starts = (...signature: number[]) => signature.every((byte, at) => bytes[at] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
    return 'image/webp';
  }

  return undefined;
}

type Row = typeof screens.$inferSelect;

/**
 * The map of an application's screens. The list comes from the code and the menu; the sheet
 * of each from an agent that walked through it without saving anything; the owner reviews it.
 * Publishing the reviewed sheet on the board comes later.
 */
export class Screens {
  constructor(
    private readonly store: Store,
    private readonly applications: Pick<Applications, 'get'>,
    private readonly clock: Clock = Date.now,
  ) {}

  private present(row: Row, slug: string, prints: string[]): ScreenRecord {
    return {
      id: row.id,
      application: slug,
      route: row.route,
      menuPath: row.menuPath,
      title: row.title,
      ...(row.squad ? { squad: row.squad } : {}),
      state: row.state as ScreenRecord['state'],
      ...(row.sheet ? { sheet: row.sheet } : {}),
      ...(row.workUrl ? { workUrl: row.workUrl } : {}),
      prints,
      ...(row.mappedAt ? { mappedAt: row.mappedAt.toISOString() } : {}),
      ...(row.reviewedAt ? { reviewedAt: row.reviewedAt.toISOString() } : {}),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async printNames(ids: string[]) {
    const names = new Map<string, string[]>();

    if (!ids.length) return names;

    const rows = await this.store.db
      .select({ screenId: screenPrints.screenId, name: screenPrints.name })
      .from(screenPrints)
      .where(inArray(screenPrints.screenId, ids))
      .orderBy(asc(screenPrints.name));

    for (const row of rows) {
      names.set(row.screenId, [...(names.get(row.screenId) ?? []), row.name]);
    }

    return names;
  }

  async list(query: unknown = {}): Promise<ScreenRecord[]> {
    const filter = screenListQuerySchema.parse(query);
    const app = filter.application ? await this.applications.get(filter.application) : undefined;
    const rows = await this.store.db
      .select({ screen: screens, slug: applications.slug })
      .from(screens)
      .innerJoin(applications, eq(applications.id, screens.applicationId))
      .where(
        and(
          app ? eq(screens.applicationId, app.id) : undefined,
          filter.state ? eq(screens.state, filter.state) : undefined,
        ),
      )
      .orderBy(asc(applications.slug), asc(screens.menuPath), asc(screens.route))
      .limit(2000);
    const prints = await this.printNames(rows.map((row) => row.screen.id));

    return rows.map((row) => this.present(row.screen, row.slug, prints.get(row.screen.id) ?? []));
  }

  async get(id: string): Promise<ScreenRecord> {
    const [row] = await this.store.db
      .select({ screen: screens, slug: applications.slug })
      .from(screens)
      .innerJoin(applications, eq(applications.id, screens.applicationId))
      .where(eq(screens.id, id))
      .limit(1);
    const found = assertFound(row, 'Screen');
    const prints = await this.printNames([id]);

    return this.present(found.screen, found.slug, prints.get(id) ?? []);
  }

  /**
   * Lists screens: a new route is created as `listed`, a known one gets its menu path and title
   * updated, and the squad only when one is given. Screens missing from the batch stay, and
   * no sheet, print or state is touched, so running it twice changes nothing.
   */
  async saveInventory(input: unknown) {
    const data = screenInventoryInputSchema.parse(input);
    const app = await this.applications.get(data.application);
    // One statement cannot touch the same row twice; the last listing of a route wins.
    const byRoute = new Map(data.screens.map((screen) => [screen.route, screen]));
    const now = new Date(this.clock());
    const touched = await this.store.db
      .insert(screens)
      .values(
        [...byRoute.values()].map((screen) => ({
          id: randomUUID(),
          applicationId: app.id,
          route: screen.route,
          menuPath: screen.menuPath,
          title: screen.title,
          squad: screen.squad ?? null,
          state: 'listed',
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [screens.applicationId, screens.route],
        set: {
          menuPath: sql`excluded.menu_path`,
          title: sql`excluded.title`,
          squad: sql`coalesce(excluded.squad, ${screens.squad})`,
          updatedAt: now,
        },
        // Unchanged rows are left alone, so they keep their date and do not count as updated.
        setWhere: sql`${screens.menuPath} is distinct from excluded.menu_path
          or ${screens.title} is distinct from excluded.title
          or (excluded.squad is not null and ${screens.squad} is distinct from excluded.squad)`,
      })
      .returning({ created: sql<boolean>`(xmax = 0)` });
    const created = touched.filter((row) => row.created).length;

    return {
      created,
      updated: touched.length - created,
      unchanged: byRoute.size - touched.length,
    };
  }

  /** The agent's sheet. Whatever the screen was, it is a draft again until the owner reviews it. */
  async writeSheet(id: string, input: unknown): Promise<ScreenRecord> {
    const { squad, ...sheet } = screenSheetInputSchema.parse(input);
    // What exists today and what it suggests were asked are facts: each needs a source.
    const unsourced = [...sheet.today, ...sheet.requirements].find(
      (item) => item.source === 'unknown',
    );

    if (unsourced) {
      throw new GatewayError(
        400,
        `"${unsourced.text}" has no source; what was not seen nor read goes in questions`,
      );
    }

    await this.get(id);

    const now = new Date(this.clock());

    await this.store.db
      .update(screens)
      .set({
        sheet,
        state: 'draft',
        mappedAt: now,
        reviewedAt: null,
        ...(squad ? { squad } : {}),
        updatedAt: now,
      })
      .where(eq(screens.id, id));

    return this.get(id);
  }

  /** Adds prints, replacing one of the same name. The bytes must be the image they claim. */
  async attachPrints(id: string, input: unknown): Promise<ScreenRecord> {
    const { prints } = screenPrintsInputSchema.parse(input);
    const current = await this.get(id);

    for (const print of prints) {
      const type = imageType(Buffer.from(print.data, 'base64'));

      if (type !== print.contentType) {
        throw new GatewayError(400, `${print.name} is not a ${print.contentType} image`);
      }
    }

    const names = new Set([...current.prints, ...prints.map((print) => print.name)]);

    if (names.size > PRINTS_PER_SCREEN) {
      throw new GatewayError(
        409,
        `A screen keeps up to ${PRINTS_PER_SCREEN} prints; this one already has ${current.prints.length}`,
      );
    }

    const now = new Date(this.clock());

    await this.store.transaction(id, async (tx) => {
      for (const print of prints) {
        await tx
          .insert(screenPrints)
          .values({
            screenId: id,
            name: print.name,
            contentType: print.contentType,
            content: print.data,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [screenPrints.screenId, screenPrints.name],
            set: { contentType: print.contentType, content: print.data, createdAt: now },
          });
      }
      await tx.update(screens).set({ updatedAt: now }).where(eq(screens.id, id));
    });

    return this.get(id);
  }

  async print(id: string, name: string) {
    const [row] = await this.store.db
      .select()
      .from(screenPrints)
      .where(and(eq(screenPrints.screenId, id), eq(screenPrints.name, name)))
      .limit(1);
    const found = assertFound(row, 'Print');

    return {
      name: found.name,
      contentType: found.contentType as PrintType,
      data: found.content,
    };
  }

  /** The owner read the sheet and agrees with it. Only a draft can be reviewed. */
  async review(id: string): Promise<ScreenRecord> {
    const current = await this.get(id);

    if (current.state !== 'draft') {
      throw new GatewayError(
        409,
        current.sheet
          ? `${current.title} is ${current.state}, not a draft`
          : `${current.title} has no sheet to review yet`,
      );
    }

    const now = new Date(this.clock());

    await this.store.db
      .update(screens)
      .set({ state: 'reviewed', reviewedAt: now, updatedAt: now })
      .where(and(eq(screens.id, id), eq(screens.state, 'draft')));

    return this.get(id);
  }
}
