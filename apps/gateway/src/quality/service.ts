import { randomUUID } from 'node:crypto';
import {
  type Correction,
  type correctionKindSchema,
  type QualityRow,
  READY_AFTER,
} from '@jian/contracts';
import type { z } from 'zod';
import { type Clock, nowIso } from '../core/clock.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  insertCorrection,
  lastAnswered,
  listCorrections,
  listRounds,
  runOrigin,
} from './repository.js';

const DAY_MS = 86_400_000;

type Kind = z.infer<typeof correctionKindSchema>;
type Via = Correction['via'];

/**
 * The owner's corrections and what they say about each automation. A correction is written
 * where the owner made it — refusing, editing, or "corrige:" — and named after the automation
 * it judges, so the panel can show which ones earned a higher level.
 */
export class Quality {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly clock: Clock = Date.now,
  ) {}

  async record(
    db: Queryable,
    profileId: string,
    entry: {
      kind: Kind;
      via: Via;
      runId?: string;
      approvalId?: string;
      action?: string;
      original?: unknown;
      corrected?: unknown;
      note?: string;
    },
  ): Promise<Correction> {
    const origin = entry.runId ? await runOrigin(db, entry.runId) : undefined;
    const correction: Correction = {
      id: randomUUID(),
      profileId,
      ...(entry.runId ? { runId: entry.runId } : {}),
      ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
      automation: origin ?? entry.action ?? 'conversation',
      kind: entry.kind,
      ...(entry.original !== undefined ? { original: entry.original } : {}),
      ...(entry.corrected !== undefined ? { corrected: entry.corrected } : {}),
      ...(entry.note ? { note: entry.note.slice(0, 4000) } : {}),
      via: entry.via,
      createdAt: nowIso(this.clock),
    };

    await insertCorrection(db, correction);
    await recordEvent(db, this.clock, profileId, 'correction.recorded', correction, entry.runId);

    return correction;
  }

  /**
   * "corrige: …" from the owner, about the last answer in that conversation. Nothing is
   * recorded when there is no answer yet to correct.
   */
  async redo(
    db: Queryable,
    profileId: string,
    sessionId: string,
    note: string,
    via: Via,
  ): Promise<Correction | undefined> {
    const last = await lastAnswered(db, profileId, sessionId);

    if (!last) return undefined;

    return this.record(db, profileId, {
      kind: 'redone',
      via,
      runId: last.id,
      ...(last.output ? { original: last.output.slice(0, 4000) } : {}),
      note,
    });
  }

  async corrections(profileId: string, since?: Date): Promise<Correction[]> {
    await this.profiles.profile(profileId);

    return listCorrections(this.store.db, profileId, since ? { since } : {});
  }

  /**
   * One row per automation, most corrected first: the rounds it ran and the corrections it
   * took, in the last thirty days and in all, and how many rounds went untouched since the
   * last correction. Ready means enough clean rounds to consider raising its level.
   */
  async report(profileId: string): Promise<QualityRow[]> {
    await this.profiles.profile(profileId);

    const [rounds, corrected] = await Promise.all([
      listRounds(this.store.db, profileId),
      listCorrections(this.store.db, profileId, { limit: 5000 }),
    ]);
    const since = this.clock() - 30 * DAY_MS;
    const names = new Set([
      ...rounds.map((r) => r.automation),
      ...corrected.map((c) => c.automation),
    ]);

    const rows = [...names].map((automation): QualityRow => {
      const mine = rounds.filter((round) => round.automation === automation);
      const fixes = corrected.filter((item) => item.automation === automation);
      const last = fixes[0];
      const clean = last
        ? mine.filter((round) => round.at.getTime() > Date.parse(last.createdAt)).length
        : mine.length;
      const action = mine.find((round) => round.action)?.action;

      return {
        automation,
        ...(action ? { action } : {}),
        rounds30: mine.filter((round) => round.at.getTime() >= since).length,
        corrections30: fixes.filter((item) => Date.parse(item.createdAt) >= since).length,
        rounds: mine.length,
        corrections: fixes.length,
        clean,
        ready: clean >= READY_AFTER,
        ...(last ? { lastCorrection: last } : {}),
      };
    });

    return rows.sort(
      (a, b) =>
        b.corrections30 - a.corrections30 ||
        b.rounds30 - a.rounds30 ||
        a.automation.localeCompare(b.automation),
    );
  }
}
