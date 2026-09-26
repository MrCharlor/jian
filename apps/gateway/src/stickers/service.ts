import { createHash, randomUUID } from 'node:crypto';
import {
  type InlineMedia,
  type Profile,
  type Run,
  type Sticker,
  stickerSchema,
  stickerTagsSchema,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { and, desc, eq, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { stickers } from '../storage/schema.js';

/** How many a profile keeps. Past it, the least sent, least seen and oldest one makes room. */
const MAX_STICKERS = 200;
/** What one search offers the agent to choose from. */
const OFFERED = 20;

type StickerMedia = {
  describeSticker(
    profileId: string,
    data: string,
    signal: AbortSignal,
  ): Promise<{ keep: boolean; description: string; tags: string[] }>;
  sendSticker(run: Run, data: string, toolCallId: string, sessionId?: string): Promise<unknown>;
};

type Row = typeof stickers.$inferSelect;

/**
 * A tag as a tool takes it. stickerTagSchema's Unicode pattern (\p{L}) is not a regex OpenAI
 * accepts in a function schema, and one refused schema fails the whole turn, so the model sees
 * a plain string and the tag is checked on arrival: by stickerTagsSchema when it is written, and
 * as an exact match, found or not, when it is searched.
 */
const toolTag = z
  .string()
  .max(31)
  .describe('One lowercase word or short phrase: letters, digits, spaces or hyphens.');

export type StickerOrder = 'relevance' | 'most_sent' | 'most_seen' | 'newest';

const toSticker = (row: Row): Sticker =>
  stickerSchema.parse({
    id: row.id,
    profileId: row.profileId,
    ...(row.description ? { description: row.description } : {}),
    tags: row.tags,
    uses: row.uses,
    seen: row.seen,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  });

const orders: Record<Exclude<StickerOrder, 'relevance'>, SQL[]> = {
  most_sent: [desc(stickers.uses), desc(stickers.seen), desc(stickers.createdAt)],
  most_seen: [desc(stickers.seen), desc(stickers.uses), desc(stickers.createdAt)],
  newest: [desc(stickers.createdAt)],
};

/**
 * The agent's own sticker collection, gathered from the chats it is in. WhatsApp does not give a
 * paired account's saved stickers to anything outside the app, so the collection is what people
 * sent: each image kept once, described and tagged once by the image-analysis model, counted
 * each time someone sends it again, and found by what it shows. The owner sees it under
 * Stickers and removes what the agent should not use.
 */
export class Stickers {
  constructor(
    private readonly store: Store,
    private readonly media: StickerMedia,
    private readonly profiles: { profile(id: string): Promise<Profile> },
  ) {}

  /** Keeps a received sticker, or counts it again; a new one is catalogued in the background. */
  async keep(profileId: string, input: InlineMedia): Promise<void> {
    if (input.mimeType !== 'image/webp') return;
    // Switched off, a sticker costs nothing: not kept, not described.
    if (!(await this.profiles.profile(profileId)).useStickers) return;

    const hash = createHash('sha256').update(input.data).digest('hex');
    const [kept] = await this.store.db
      .insert(stickers)
      .values({ id: randomUUID(), profileId, hash, data: input.data })
      .onConflictDoUpdate({
        target: [stickers.profileId, stickers.hash],
        set: { seen: sql`${stickers.seen} + 1` },
      })
      .returning({
        id: stickers.id,
        seen: stickers.seen,
        described: stickers.description,
        declined: stickers.declined,
      });

    if (!kept || kept.seen > 1) {
      // Seen before, but never described — the model was down, say: this is another chance.
      // One the model declined stays declined, and costs no second look.
      if (kept && !kept.described && !kept.declined)
        void this.describe(profileId, kept.id, input.data);
      return;
    }

    await this.trim(profileId);
    void this.describe(profileId, kept.id, input.data);
  }

  private async describe(profileId: string, id: string, data: string) {
    try {
      const { keep, description, tags } = await this.media.describeSticker(
        profileId,
        data,
        AbortSignal.timeout(60_000),
      );

      // Declined: only the fingerprint stays, so the image itself is not kept, and the same
      // sticker sent again is recognised and left alone.
      if (!keep) {
        await this.store.db
          .update(stickers)
          .set({ declined: true, data: '', description: null, tags: [] })
          .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));
        return;
      }

      if (description || tags.length)
        await this.store.db
          .update(stickers)
          .set({ ...(description ? { description } : {}), tags })
          .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));
    } catch (error) {
      // Without a description it is still kept, and still offered when nothing matches better.
      console.error(
        `jian: sticker ${id} could not be described — ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async trim(profileId: string) {
    // A declined fingerprint holds no image and takes no place in the collection.
    const extra = await this.store.db
      .select({ id: stickers.id })
      .from(stickers)
      .where(and(eq(stickers.profileId, profileId), eq(stickers.declined, false)))
      .orderBy(...orders.most_sent)
      .offset(MAX_STICKERS);

    for (const { id } of extra)
      await this.store.db
        .delete(stickers)
        .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));
  }

  async list(profileId: string): Promise<Sticker[]> {
    const rows = await this.store.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.profileId, profileId), eq(stickers.declined, false)))
      .orderBy(...orders.most_sent)
      .limit(MAX_STICKERS);

    return rows.map(toSticker);
  }

  private async row(profileId: string, id: string) {
    const [row] = await this.store.db
      .select()
      .from(stickers)
      .where(
        and(eq(stickers.profileId, profileId), eq(stickers.id, id), eq(stickers.declined, false)),
      )
      .limit(1);

    if (!row) throw new GatewayError(404, 'Sticker not found');

    return row;
  }

  async image(profileId: string, id: string) {
    const row = await this.row(profileId, id);

    return { ...toSticker(row), mimeType: 'image/webp' as const, data: row.data };
  }

  /** Replaces a sticker's tags: the owner's correction, or the agent's. */
  async tag(profileId: string, id: string, input: unknown): Promise<Sticker> {
    const { tags } = stickerTagsSchema.parse(input);

    await this.row(profileId, id);

    const [row] = await this.store.db
      .update(stickers)
      .set({ tags: [...new Set(tags)] })
      .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)))
      .returning();

    return toSticker(row as Row);
  }

  /**
   * Removed by the owner: kept only as its fingerprint, like one the model declined, so the same
   * sticker sent again is not collected and described all over again.
   */
  async forget(profileId: string, id: string): Promise<Sticker> {
    const row = await this.row(profileId, id);

    await this.store.db
      .update(stickers)
      .set({ declined: true, data: '', description: null, tags: [] })
      .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));

    return toSticker(row);
  }

  /**
   * Stickers by what they are. A tag is an exact match and narrows; the words of a query are
   * matched against the tags and the description, a tag counting twice. Without a query the
   * order asked for decides, most sent by default.
   */
  async search(
    profileId: string,
    options: { query?: string | undefined; tag?: string | undefined; order?: StickerOrder },
  ) {
    const words = [
      ...new Set((options.query ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
    ].slice(0, 8);
    const tag = options.tag?.trim().toLowerCase();
    const score = words.length
      ? sql<number>`(${sql.join(
          words.map(
            (word) =>
              sql`(case when ${stickers.tags}::text ilike ${`%${word}%`} then 2 else 0 end) + (case when lower(coalesce(${stickers.description}, '')) like ${`%${word}%`} then 1 else 0 end)`,
          ),
          sql` + `,
        )})`
      : sql<number>`0`;
    const order = options.order && options.order !== 'relevance' ? options.order : undefined;
    const rows = await this.store.db
      .select({
        id: stickers.id,
        description: stickers.description,
        tags: stickers.tags,
        uses: stickers.uses,
        seen: stickers.seen,
        score,
      })
      .from(stickers)
      .where(
        and(
          eq(stickers.profileId, profileId),
          eq(stickers.declined, false),
          tag ? sql`${stickers.tags} @> ${JSON.stringify([tag])}::jsonb` : undefined,
          words.length ? sql`${score} > 0` : undefined,
        ),
      )
      // A literal 0 in ORDER BY reads as a column position, so no query means no score to sort.
      .orderBy(
        ...(order || !words.length
          ? orders[order ?? 'most_sent']
          : [desc(score), ...orders.most_sent]),
      )
      .limit(OFFERED);

    return rows.map(({ id, description, tags, uses, seen }) => ({
      id,
      shows: description ?? 'not described yet',
      tags,
      sent: uses,
      seen,
    }));
  }

  tools(run: Run): ToolSet {
    if (!run.profile.useStickers) return {};

    return {
      find_stickers: tool({
        description:
          'Find stickers in your collection, gathered from what people sent in your chats. Search by meaning ("laughing", "approving"), by an exact tag, or list the ones you send most or the ones people send most. Returns ids, what each shows, its tags, how often you sent it and how often people did.',
        inputSchema: z.object({
          query: z.string().max(200).optional(),
          tag: toolTag.optional(),
          order: z
            .enum(['relevance', 'most_sent', 'most_seen', 'newest'])
            .default('relevance')
            .describe('most_seen: what the people you talk to send most, their style.'),
        }),
        execute: async ({ query, tag, order }) => {
          const found = await this.search(run.profileId, { query, tag, order });

          return found.length
            ? { stickers: found }
            : {
                stickers: [],
                note:
                  query || tag
                    ? 'Nothing matches.'
                    : 'No stickers yet: they are kept as people send them.',
              };
        },
      }),
      send_sticker: tool({
        description:
          'Send a sticker from your collection, by its id from find_stickers, in this conversation or in another of yours. It goes out as a sticker on WhatsApp and Telegram.',
        inputSchema: z.object({
          stickerId: z.uuid(),
          sessionId: z
            .uuid()
            .optional()
            .describe('Another of your conversations to send it in; this one when absent.'),
        }),
        execute: async ({ stickerId, sessionId }, options) => {
          const row = await this.row(run.profileId, stickerId);
          const sent = await this.media.sendSticker(run, row.data, options.toolCallId, sessionId);

          await this.store.db
            .update(stickers)
            .set({ uses: sql`${stickers.uses} + 1`, lastUsedAt: new Date() })
            .where(and(eq(stickers.profileId, run.profileId), eq(stickers.id, stickerId)));

          return sent;
        },
      }),
      tag_sticker: tool({
        description:
          'Replace the tags of a sticker in your collection, when its tags miss how it is really used — "that one means we are done here". Tags are short lowercase words: the feeling, the reaction, the subject.',
        inputSchema: z.object({
          stickerId: z.uuid(),
          tags: z.array(toolTag).min(1).max(12),
        }),
        execute: async ({ stickerId, tags }) => {
          const tagged = await this.tag(run.profileId, stickerId, { tags });

          return { stickerId, tags: tagged.tags };
        },
      }),
    };
  }
}
