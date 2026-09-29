import type { PgBoss } from 'pg-boss';
import type { AgentRuntime } from '../agent/runtime.js';
import type { Store } from '../storage/database.js';
import type { Work } from '../tasks/service.js';
import type { RunRecovery } from './port.js';
import { listQueuedRuns, listUnreportedTaskWorkers } from './repository.js';

const queueName = 'jian-agent-runs';

export class RunQueue {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private boss: PgBoss,
    private services: { lifecycle: RunRecovery; store: Store; work: Pick<Work, 'reportWorker'> },
    private runtime: AgentRuntime,
    private report: (message: string) => void = console.error,
  ) {}

  async start() {
    this.boss.on('error', () => this.report('jian: queue connection failed'));
    await this.boss.start();

    // Run leases handle recovery; queue retries must not replay an agent's external effects.
    await this.boss.createQueue(queueName, {
      policy: 'exclusive',
      retryLimit: 0,
      expireInSeconds: 660,
    });

    await this.boss.work<{ profileId: string; runId: string }>(
      queueName,
      { localConcurrency: 4, batchSize: 1, pollingIntervalSeconds: 1 },
      async (jobs) => {
        for (const job of jobs) {
          await this.runtime.execute(job.data.profileId, job.data.runId);
        }
      },
    );

    await this.tick();
  }

  private async dispatch() {
    await this.services.lifecycle.recover();

    for (const worker of await listUnreportedTaskWorkers(this.services.store.db, 100)) {
      if (this.stopped) return;
      await this.services.work
        .reportWorker(worker.profileId, worker.id)
        .catch(() => this.report(`jian: task worker ${worker.id} handoff failed; will retry`));
    }

    const queued = await listQueuedRuns(this.services.store.db, 1000);

    for (const run of queued) {
      if (this.stopped) {
        return;
      }

      await this.boss.send(
        queueName,
        { profileId: run.profileId, runId: run.id },
        { singletonKey: run.id },
      );
    }
  }

  private async tick() {
    if (this.stopped) {
      return;
    }

    this.pending = this.dispatch().catch(() =>
      this.report('jian: run dispatch failed; will retry'),
    );

    await this.pending;

    if (!this.stopped) {
      this.timer = setTimeout(() => {
        void this.tick();
      }, 2000);

      this.timer.unref();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.runtime.stop();
    await this.pending;
    await this.boss.stop({ graceful: true, timeout: 15_000 });
  }
}
