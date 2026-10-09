import { randomUUID } from 'node:crypto';
import {
  type Run,
  SCHEDULE_LIMIT,
  type Schedule,
  scheduleInputSchema,
  schedulePatchSchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { stableUuid } from '../core/ids.js';
import type { ProfileReader } from '../profiles/port.js';
import type { SessionReader } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import {
  advanceSchedule,
  deleteSchedule,
  dueSchedules,
  findSchedule,
  insertSchedule,
  listSchedules,
  pruneSchedules,
  recordScheduleRun,
  replaceSchedule,
  scheduleHistory,
} from './repository.js';
import { assertCron, nextRun } from './timing.js';

type RunSubmitter = {
  submit(
    profileId: string,
    sessionId: string,
    input: unknown,
    options?: { origin?: string },
  ): Promise<Run>;
};

/** How a run started by a schedule names its automation, for the owner's measure of it. */
export const scheduleOrigin = (schedule: Pick<Schedule, 'name'>) => `schedule:${schedule.name}`;

/** The way a run reaches a person when its conversation is a chat on a channel. */
type Deliveries = {
  deliverRun(profileId: string, sessionId: string, runId: string): Promise<void>;
};

/** How long a schedule's history is kept, and a single time once it ran, in days. */
const HISTORY_DAYS = 30;
const DONE_DAYS = 7;
const DAY_MS = 86_400_000;

/**
 * What a run started by a schedule says. The agent reads it as the owner's request arriving
 * now, marked so it knows nobody typed it this minute; the panel shows the mark apart.
 */
export const scheduledText = (schedule: Pick<Schedule, 'name' | 'instruction'>) =>
  `[Scheduled: ${schedule.name}] ${schedule.instruction}`;

/**
 * Things a profile does at a time, in one of its conversations. A schedule starts an ordinary
 * run there, as if the owner had written the instruction at that moment; in a channel chat the
 * answer goes out on the channel.
 */
export class Schedules {
  private deliveries?: Deliveries;

  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly sessions: SessionReader,
    private readonly runs: RunSubmitter,
    private readonly clock: Clock = Date.now,
  ) {}

  useDeliveries(deliveries: Deliveries) {
    this.deliveries = deliveries;
  }

  async list(profileId: string) {
    await this.profiles.profile(profileId);

    return listSchedules(this.store.db, profileId);
  }

  async create(profileId: string, input: unknown, createdBy: Schedule['createdBy']) {
    const data = scheduleInputSchema.parse(input);
    const now = new Date(this.clock());

    this.validate(data, now);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      await this.sessions.session(profileId, data.sessionId, tx);

      if ((await listSchedules(tx, profileId)).length >= SCHEDULE_LIMIT) {
        throw new GatewayError(409, `A profile keeps at most ${SCHEDULE_LIMIT} schedules`);
      }

      const next = data.enabled ? nextRun(data, now) : undefined;
      const schedule: Schedule = {
        id: randomUUID(),
        profileId,
        name: data.name,
        instruction: data.instruction,
        sessionId: data.sessionId,
        ...(data.at ? { at: new Date(data.at).toISOString() } : {}),
        ...(data.cron ? { cron: data.cron.trim() } : {}),
        timeZone: data.timeZone,
        enabled: data.enabled,
        ...(next ? { nextRunAt: next.toISOString() } : {}),
        createdBy,
        createdAt: nowIso(this.clock),
        updatedAt: nowIso(this.clock),
      };

      await insertSchedule(tx, schedule);
      await recordEvent(tx, this.clock, profileId, 'schedule.created', { id: schedule.id });

      return schedule;
    });
  }

  async update(profileId: string, id: string, input: unknown) {
    const patch = schedulePatchSchema.parse(input);
    const now = new Date(this.clock());

    return this.store.transaction(profileId, async (tx) => {
      const current = assertFound(await findSchedule(tx, profileId, id), 'Schedule');

      if (patch.sessionId) await this.sessions.session(profileId, patch.sessionId, tx);

      // A new time replaces the old kind of timing: `at` and `cron` never live together.
      const timing = patch.at
        ? { at: new Date(patch.at).toISOString() }
        : patch.cron
          ? { cron: patch.cron.trim() }
          : {
              ...(current.at ? { at: current.at } : {}),
              ...(current.cron ? { cron: current.cron } : {}),
            };
      const { at: _at, cron: _cron, nextRunAt: _next, ...kept } = current;
      const merged = {
        ...kept,
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.instruction ? { instruction: patch.instruction } : {}),
        ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
        ...(patch.timeZone ? { timeZone: patch.timeZone } : {}),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...timing,
      };

      if (patch.at || patch.cron || patch.timeZone) this.validate(merged, now);

      const next = merged.enabled ? nextRun(merged, now) : undefined;
      const schedule: Schedule = {
        ...merged,
        ...(next ? { nextRunAt: next.toISOString() } : {}),
        updatedAt: nowIso(this.clock),
      };

      await replaceSchedule(tx, schedule);
      await recordEvent(tx, this.clock, profileId, 'schedule.updated', { id });

      return schedule;
    });
  }

  async remove(profileId: string, id: string) {
    return this.store.transaction(profileId, async (tx) => {
      const schedule = assertFound(await findSchedule(tx, profileId, id), 'Schedule');

      await deleteSchedule(tx, profileId, id);
      await recordEvent(tx, this.clock, profileId, 'schedule.deleted', { id });

      return schedule;
    });
  }

  /** Once, now, without moving when it runs next: to see what it does before waiting for it. */
  async runNow(profileId: string, id: string) {
    const schedule = assertFound(await findSchedule(this.store.db, profileId, id), 'Schedule');
    const key = randomUUID();
    const now = new Date(this.clock());

    try {
      const run = await this.start(schedule, `schedule:${id}:manual:${key}`);

      await recordScheduleRun(this.store.db, {
        createdAt: new Date(this.clock()),
        id: key,
        scheduleId: id,
        profileId,
        dueAt: now,
        manual: true,
        runId: run.id,
      });
      return run;
    } catch (error) {
      await recordScheduleRun(this.store.db, {
        createdAt: new Date(this.clock()),
        id: key,
        scheduleId: id,
        profileId,
        dueAt: now,
        manual: true,
        error: error instanceof Error ? error.message.slice(0, 300) : 'The run could not start',
      });
      throw error;
    }
  }

  /** What the schedule did in the last thirty days, newest first. */
  async history(profileId: string, id: string) {
    assertFound(await findSchedule(this.store.db, profileId, id), 'Schedule');

    return scheduleHistory(
      this.store.db,
      profileId,
      id,
      new Date(this.clock() - HISTORY_DAYS * DAY_MS),
    );
  }

  /**
   * Starts every schedule whose time has come. Each one runs once for the time it was due,
   * however late the gateway is to it, and then moves to its next time after now: a worker that
   * was down overnight sends this morning's summary once, not one for every missed day. Along
   * the way it forgets history past thirty days, and single times done for a week.
   */
  async fireDue() {
    const now = new Date(this.clock());

    await pruneSchedules(
      this.store.db,
      new Date(now.getTime() - HISTORY_DAYS * DAY_MS),
      new Date(now.getTime() - DONE_DAYS * DAY_MS),
    );

    for (const schedule of await dueSchedules(this.store.db, now)) {
      const dueAt = new Date(schedule.nextRunAt ?? now);
      let run: Run | undefined;
      let failure: string | undefined;

      try {
        // Keyed by the time it was due, so a second worker, or a retry, finds the same run.
        run = await this.start(schedule, `schedule:${schedule.id}:${dueAt.toISOString()}`);
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 300) : 'The run could not start';
      }

      // One entry per time it was due, however many workers reached it.
      await recordScheduleRun(this.store.db, {
        createdAt: new Date(this.clock()),
        id: stableUuid(`schedule-run:${schedule.id}:${dueAt.toISOString()}`),
        scheduleId: schedule.id,
        profileId: schedule.profileId,
        dueAt,
        manual: false,
        runId: run?.id,
        error: failure,
      });

      const next = nextRun(schedule, now > dueAt ? now : dueAt);

      await this.store.transaction(schedule.profileId, async (tx) => {
        const moved = await advanceSchedule(
          tx,
          schedule,
          dueAt,
          {
            nextRunAt: next ?? null,
            // A single time is done once it ran; a repetition stays on.
            enabled: Boolean(schedule.cron),
            ...(run ? { lastRunId: run.id } : {}),
            ...(failure ? { lastError: failure } : {}),
          },
          now,
        );

        if (moved) {
          await recordEvent(tx, this.clock, schedule.profileId, 'schedule.ran', {
            id: schedule.id,
            ...(run ? { runId: run.id } : { error: failure }),
          });
        }
      });
    }
  }

  private async start(schedule: Schedule, requestKey: string) {
    const run = await this.runs.submit(
      schedule.profileId,
      schedule.sessionId,
      { text: scheduledText(schedule), requestKey },
      { origin: scheduleOrigin(schedule) },
    );

    await this.deliveries?.deliverRun(schedule.profileId, schedule.sessionId, run.id);

    return run;
  }

  private validate(
    timing: { at?: string | undefined; cron?: string | undefined; timeZone: string },
    now: Date,
  ) {
    if (timing.at && new Date(timing.at) <= now) {
      throw new GatewayError(400, 'That time has already passed');
    }

    if (timing.cron) assertCron(timing.cron, timing.timeZone);
  }
}
