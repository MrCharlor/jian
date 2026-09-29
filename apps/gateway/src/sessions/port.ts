import type { Message, Session } from '@jian/contracts';
import type { Queryable } from '../storage/database.js';

export interface SessionReader {
  session(profileId: string, sessionId: string, reader?: Queryable): Promise<Session>;
  sessions(profileId: string): Promise<Session[]>;
  messages(
    profileId: string,
    sessionId: string,
    limit?: number,
    after?: string,
  ): Promise<Message[]>;
  uncompactedMessages(profileId: string, sessionId: string, afterId?: string): Promise<Message[]>;
}

/** Naming is the agent's one write to a session, and only while it has no name. */
/** Replacing the turns a prompt carries with the record the agent wrote of them. */
export interface SessionSummarizer {
  summarize(
    profileId: string,
    sessionId: string,
    summary: string,
    upTo?: string,
    throughId?: string,
  ): Promise<void>;
}

export interface SessionNamer {
  nameIfUnnamed(profileId: string, sessionId: string, title: string): Promise<void>;
}

export interface SessionWriter extends SessionReader {
  createSession(
    profileId: string,
    input: unknown,
    transaction?: Queryable,
    scope?: 'direct' | 'group',
  ): Promise<Session>;
}

/** The session two agents share. Held apart from `SessionWriter`: only peer calls open one. */
export interface PeerSessions {
  record(
    profileId: string,
    sessionId: string,
    runId: string,
    role: 'user' | 'assistant',
    content: string,
    call?: { profileId: string; sessionId: string; runId: string },
  ): Promise<void>;
  peerSession(
    profileId: string,
    peerProfileId: string,
    title: string,
    transaction?: Queryable,
  ): Promise<Session>;
}
