import type {
  AgentCallOrigin,
  Checkpoint,
  GroupTurn,
  Run,
  RunProgress,
  Subagent,
} from '@jian/contracts';
import type { Queryable } from '../storage/database.js';

/** What decides a run beyond its text: where it continues from, who asked, what it may cost. */
export type SubmitOptions = {
  /** Set only by the authenticated owner-facing message route. */
  ownerMessage?: boolean;
  continuationOf?: string;
  activity?: 'conversation' | 'channel';
  call?: AgentCallOrigin;
  group?: GroupTurn;
  /** Who wrote the message, when the conversation is a room with several people in it. */
  author?: { id: string; name?: string };
  workItemId?: string;
  subagent?: Subagent;
  /** What started the run when nobody typed it: `schedule:<name>`. */
  origin?: string;
  transaction?: Queryable;
};

export interface RunReader {
  run(profileId: string, runId: string, reader?: Queryable): Promise<Run>;
  activities(profileId: string): Promise<Run[]>;
}

export interface RunWriter extends RunReader {
  submit(
    profileId: string,
    sessionId: string,
    input: unknown,
    options?: SubmitOptions,
  ): Promise<Run>;
  relayTo(profileId: string, runId: string, sessionId: string | null): Promise<void>;
}

/** The lease side of a run: every write here needs the owner that holds it. */
export interface RunExecution {
  claim(runId: string, profileId: string, owner: string): Promise<Run | null>;
  heartbeat(profileId: string, runId: string, owner: string): Promise<void>;
  checkpoint(profileId: string, runId: string, owner: string, data: unknown): Promise<void>;
  progress(runId: string, owner: string, progress: RunProgress | null): Promise<void>;
  steer(runId: string, owner: string): Promise<string | null>;
  say(profileId: string, runId: string, owner: string, text: string): Promise<void>;
  checkpoints(profileId: string, runId: string): Promise<Checkpoint[]>;
  recordUsage(
    profileId: string,
    runId: string,
    owner: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      estimated?: boolean;
      steps: number;
    },
  ): Promise<void>;
  finish(
    profileId: string,
    runId: string,
    owner: string,
    status: 'completed' | 'failed' | 'interrupted',
    content: string,
  ): Promise<Run>;
}

export interface RunRecovery {
  recover(): Promise<void>;
}
