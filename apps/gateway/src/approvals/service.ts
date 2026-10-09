import { createHash, randomUUID } from 'node:crypto';
import {
  type ActionPolicy,
  APPROVAL_DAYS,
  APPROVAL_LIMIT,
  type Approval,
  type AutonomyLevel,
  approvalDecisionSchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Queryable, Store } from '../storage/database.js';
import {
  countPending,
  expireApprovals,
  findApproval,
  findApprovalByNumber,
  findApprovedCall,
  findPendingCall,
  insertApproval,
  listApprovals,
  nextApprovalNumber,
  setApprovalStatus,
} from './repository.js';

export type ActionKind = 'machine' | 'service' | 'message';

type DecidedVia = NonNullable<Approval['decidedVia']>;

const DAY_MS = 86_400_000;

/**
 * The same call hashes the same whatever order the model wrote the fields in, so an approval
 * granted for one proposal is recognised when the agent repeats it after the owner's answer.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

export const inputHash = (input: unknown): string =>
  createHash('sha256').update(canonical(input)).digest('hex');

/** The level of one action: the exact action if the owner named it, the kind otherwise. */
export function levelOf(policy: ActionPolicy, action: string, kind: ActionKind): AutonomyLevel {
  return policy.tools[action] ?? policy[kind];
}

/** What the agent is told when it may only propose: the owner does the deed. */
export const proposeOnly = (action: string) =>
  `Not run: ${action} is at autonomy level 1 for this agent, so you only propose it. Tell the owner exactly what you would do and leave the action to them.`;

export const waitingFor = (approval: Approval) =>
  `Not run yet: this action waits for the owner's approval as request #${approval.number}. Tell the owner, in your own words, exactly what #${approval.number} would do and that they can answer "ok ${approval.number}" or "não ${approval.number}: motivo". Then end your turn; do not call the tool again until the owner answers.`;

/**
 * Actions the agent prepared and the owner decides on. One short number per profile is the
 * handle the owner answers with; the hash of the input is what makes the approval apply to
 * that exact call and to no other.
 */
export class Approvals {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly clock: Clock = Date.now,
  ) {}

  async list(profileId: string): Promise<Approval[]> {
    await this.profiles.profile(profileId);

    return this.store.transaction(profileId, async (tx) => {
      await expireApprovals(tx, profileId, new Date(this.clock()));

      return listApprovals(tx, profileId);
    });
  }

  /**
   * The gate a level-2 tool call goes through. An approval already granted for this call is
   * spent and the call proceeds; otherwise a request is recorded, or the existing one for the
   * same call is pointed at, and the call is held with the number the owner will answer to.
   */
  async gate(
    run: { profileId: string; sessionId: string; id: string },
    call: { tool: string; action: string; input: unknown; summary: string },
  ): Promise<{ proceed: true } | { proceed: false; held: string; approval: Approval }> {
    const hash = inputHash(call.input);

    return this.store.transaction(run.profileId, async (tx) => {
      await expireApprovals(tx, run.profileId, new Date(this.clock()));

      const granted = await findApprovedCall(tx, run.profileId, run.sessionId, call.tool, hash);

      if (granted) {
        await setApprovalStatus(tx, granted.id, 'used');
        await recordEvent(tx, this.clock, run.profileId, 'approval.used', { id: granted.id });

        return { proceed: true };
      }

      const pending = await findPendingCall(tx, run.profileId, run.sessionId, call.tool, hash);

      if (pending) {
        return { proceed: false, held: waitingFor(pending), approval: pending };
      }

      if ((await countPending(tx, run.profileId)) >= APPROVAL_LIMIT) {
        throw new GatewayError(
          429,
          `The owner has ${APPROVAL_LIMIT} requests waiting already; do not add more until they answer`,
        );
      }

      const now = this.clock();
      const approval: Approval = {
        id: randomUUID(),
        profileId: run.profileId,
        runId: run.id,
        sessionId: run.sessionId,
        number: await nextApprovalNumber(tx, run.profileId),
        tool: call.tool,
        action: call.action,
        input: call.input,
        summary: call.summary.slice(0, 2000),
        status: 'pending',
        createdAt: nowIso(() => now),
        expiresAt: new Date(now + APPROVAL_DAYS * DAY_MS).toISOString(),
      };

      await insertApproval(tx, { ...approval, inputHash: hash });
      await recordEvent(tx, this.clock, run.profileId, 'approval.requested', approval, run.id);

      return { proceed: false, held: waitingFor(approval), approval };
    });
  }

  async approve(profileId: string, id: string, input: unknown, via: DecidedVia = 'api') {
    const { reason } = approvalDecisionSchema.parse(input ?? {});

    return this.decide(profileId, { id }, true, via, reason);
  }

  async reject(profileId: string, id: string, input: unknown, via: DecidedVia = 'api') {
    const { reason } = approvalDecisionSchema.parse(input ?? {});

    return this.decide(profileId, { id }, false, via, reason);
  }

  /**
   * The owner's answer, by id from the panel or the API, by number from a chat. Only a pending
   * request can be decided: an expired one is refused, so a late "ok" never runs stale work.
   */
  async decide(
    profileId: string,
    which: { id: string } | { number: number },
    approve: boolean,
    via: DecidedVia,
    reason?: string,
    tx?: Queryable,
  ): Promise<Approval> {
    const apply = async (db: Queryable) => {
      await expireApprovals(db, profileId, new Date(this.clock()));

      const current = assertFound(
        'id' in which
          ? await findApproval(db, profileId, which.id)
          : await findApprovalByNumber(db, profileId, which.number),
        'Approval',
      );

      if (current.status !== 'pending') {
        throw new GatewayError(409, `Request #${current.number} is already ${current.status}`);
      }

      const status = approve ? 'approved' : 'rejected';
      const at = new Date(this.clock());

      await setApprovalStatus(db, current.id, status, { at, via, ...(reason ? { reason } : {}) });

      const decided: Approval = {
        ...current,
        status,
        decidedAt: at.toISOString(),
        decidedVia: via,
        ...(reason ? { reason } : {}),
      };

      await recordEvent(db, this.clock, profileId, 'approval.decided', decided, current.runId);

      return decided;
    };

    if (tx) return apply(tx);

    await this.profiles.profile(profileId);

    return this.store.transaction(profileId, apply);
  }

  /** What the agent reads when the owner has answered: the decision, and what to do with it. */
  static notice(approval: Approval): string {
    const reason = approval.reason ? `: ${approval.reason}` : '';

    return approval.status === 'approved'
      ? `[Request #${approval.number} approved by the owner${reason}] Run the held action now, exactly as proposed: call ${approval.tool} again with the same input. Then report what happened.`
      : `[Request #${approval.number} rejected by the owner${reason}] Do not run that action. Acknowledge it briefly; propose another way only if the reason asks for one.`;
  }
}
