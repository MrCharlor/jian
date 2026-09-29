import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  type Message,
  type ModelSelection,
  type Session,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { and, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { messages, sessions } from '../storage/schema.js';

type SessionRow = typeof sessions.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    profileId: row.profileId,
    title: row.title,
    channel: row.channel,
    ...(row.peerProfileId ? { peerProfileId: row.peerProfileId } : {}),
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.summarizedUpTo ? { summarizedUpTo: row.summarizedUpTo.toISOString() } : {}),
    ...(row.model ? { model: row.model } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    profileId: row.profileId,
    sessionId: row.sessionId,
    ...(row.runId ? { runId: row.runId } : {}),
    role: row.role,
    content: row.content,
    ...(row.authorId
      ? { author: { id: row.authorId, ...(row.authorName ? { name: row.authorName } : {}) } }
      : {}),
    ...(row.call ? { call: row.call } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function insertSession(db: Queryable, session: Session): Promise<void> {
  await db.insert(sessions).values({
    ...session,
    peerProfileId: session.peerProfileId ?? null,
    scope: session.scope ?? null,
    summary: session.summary ?? null,
    summarizedUpTo: session.summarizedUpTo ? new Date(session.summarizedUpTo) : null,
    model: session.model ?? null,
    createdAt: new Date(session.createdAt),
  });
}

/** Ownership is part of the lookup, so another profile's session comes back as nothing at all. */
export async function findSession(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .limit(1);

  return row ? toSession(row) : null;
}

export async function listSessions(
  db: Queryable,
  profileId: string,
  limit: number,
): Promise<Session[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.profileId, profileId), sql`${sessions.channel} <> ${TASK_SESSION_CHANNEL}`),
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(limit);

  return rows.map(toSession);
}

/**
 * The newest message of each session, one row per session: what a conversation list shows under
 * each name. Newest first per session, read once for the whole profile.
 */
export async function lastMessages(
  db: Queryable,
  profileId: string,
): Promise<Map<string, { role: 'user' | 'assistant'; content: string; createdAt: Date }>> {
  const rows = await db
    .selectDistinctOn([messages.sessionId], {
      sessionId: messages.sessionId,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.profileId, profileId))
    .orderBy(messages.sessionId, desc(messages.createdAt));

  return new Map(rows.map(({ sessionId, ...last }) => [sessionId, last]));
}

/** The one session this profile keeps for a peer: a column and an index, never a scan. */
export async function findPeerSession(
  db: Queryable,
  profileId: string,
  peerProfileId: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.profileId, profileId),
        eq(sessions.peerProfileId, peerProfileId),
        eq(sessions.channel, AGENT_SESSION_CHANNEL),
      ),
    )
    .limit(1);

  return row ? toSession(row) : null;
}

export async function findGatewaySession(db: Queryable, profileId: string) {
  return findOwnSession(db, profileId, GATEWAY_SESSION_CHANNEL);
}

/** One of the conversations the gateway keeps for a profile, one of each: gateway, learning. */
export async function findOwnSession(
  db: Queryable,
  profileId: string,
  channel: string,
): Promise<Session | null> {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.profileId, profileId), eq(sessions.channel, channel)))
    .limit(1);

  return row ? toSession(row) : null;
}

export async function insertMessage(
  db: Queryable,
  message: Message,
  repeatable = false,
): Promise<void> {
  const { author, ...rest } = message;
  const insert = db.insert(messages).values({
    ...rest,
    authorId: author?.id ?? null,
    authorName: author?.name ?? null,
    createdAt: new Date(message.createdAt),
  });
  if (repeatable) await insert.onConflictDoNothing({ target: messages.id });
  else await insert;
}

export async function listSessionMessages(
  db: Queryable,
  sessionId: string,
  limit: number,
  after?: string,
): Promise<Message[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(
      after
        ? and(eq(messages.sessionId, sessionId), gt(messages.createdAt, new Date(after)))
        : eq(messages.sessionId, sessionId),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);

  return rows.map(toMessage).reverse();
}

/** The conversation as the prompt will carry it from now on, and where that record stops. */
export async function writeSessionSummary(
  db: Queryable,
  sessionId: string,
  summary: string,
  upTo: string,
): Promise<void> {
  await db
    .update(sessions)
    .set({ summary, summarizedUpTo: new Date(upTo) })
    .where(eq(sessions.id, sessionId));
}

/**
 * History pages backwards from a message, and searches by word when asked. The cursor is a
 * message id: its timestamp and id order the page, so a new message cannot shift a page seen.
 */
export async function pageMessages(
  db: Queryable,
  where: { profileId: string; sessionId?: string; before?: string; query?: string; limit: number },
): Promise<{ items: Message[]; nextCursor: string | null }> {
  const conditions = [eq(messages.profileId, where.profileId)];

  if (where.sessionId) {
    conditions.push(eq(messages.sessionId, where.sessionId));
  }

  if (where.query) {
    conditions.push(
      sql`to_tsvector('simple', ${messages.content}) @@ plainto_tsquery('simple', ${where.query})`,
    );
  }

  if (where.before) {
    const [cursor] = await db
      .select({ createdAt: messages.createdAt, id: messages.id })
      .from(messages)
      .where(and(eq(messages.profileId, where.profileId), eq(messages.id, where.before)))
      .limit(1);

    if (cursor) {
      conditions.push(
        or(
          lt(messages.createdAt, cursor.createdAt),
          and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
        ) as ReturnType<typeof eq>,
      );
    }
  }

  const rows = await db
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(where.limit + 1);

  const page = rows.slice(0, where.limit);

  return {
    items: page.map(toMessage),
    nextCursor: rows.length > where.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Only the owner's own session, and only its name. */
export async function renameSession(
  db: Queryable,
  profileId: string,
  sessionId: string,
  title: string,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ title })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}

export async function setSessionModel(
  db: Queryable,
  profileId: string,
  sessionId: string,
  model: ModelSelection | null,
): Promise<Session | null> {
  const [row] = await db
    .update(sessions)
    .set({ model })
    .where(and(eq(sessions.id, sessionId), eq(sessions.profileId, profileId)))
    .returning();

  return row ? toSession(row) : null;
}
