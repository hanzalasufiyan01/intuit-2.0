import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ForbiddenError, NotFoundError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { organizationsWithDuePurges } from '../modules/files/index.js';
import {
  backoffDelayMs,
  claimJobs,
  completeJob,
  enqueueJob,
  finishJobUnsuccessfully,
  getJob,
  PermanentJobError,
  retryJob,
  setJobProgress,
  type JobLock,
  type JobRecord,
} from '../modules/jobs/index.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Background jobs (Decision 76; K-2; S5-14..S5-19). Jobs are enqueued inside the caller's
 * business transaction, claimed across organizations by the narrow definer function, and each
 * one is then processed under its own organization's RLS context.
 */

export const FILES_PURGE_JOB = 'files.purge';

export function jobView(job: JobRecord) {
  const unsuccessful = job.status === 'failed' || job.status === 'dead';
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    progressMessage: job.progressMessage,
    result: job.status === 'succeeded' ? job.result : null,
    // Handler errors may carry internal detail; they stay in the database and the logs.
    error: unsuccessful ? 'The job could not be completed.' : null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export interface JobContext {
  job: JobRecord;
  organizationId: string;
  /** Runs `work` in a transaction under the job's organization (RLS). */
  run<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Records progress (0..100). Returns false if this worker no longer holds the job. */
  progress(percent: number, message?: string | null): Promise<boolean>;
}

export type JobHandler = (ctx: JobContext) => Promise<Record<string, unknown> | null | void>;

export class JobService {
  constructor(private readonly deps: AppDependencies) {}

  /** Enqueues inside an existing organization transaction (S5-15: idempotent by key). */
  enqueue(
    tx: Transaction,
    input: {
      organizationId: string;
      type: string;
      jobKey?: string | null;
      payload?: Record<string, unknown>;
      requiredPermission?: string | null;
      createdByUserId?: string | null;
    },
  ) {
    return enqueueJob(tx, { ...input, maxAttempts: this.deps.config.jobs.maxAttempts });
  }

  /** S5-16: the creator, or a holder of the job's required permission; other tenants get 404. */
  get(principal: Principal, jobId: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const job = await getJob(tx, ctx.organizationId, jobId);
      if (!job) throw new NotFoundError('Job not found.');
      const allowed =
        job.createdByUserId === ctx.userId ||
        (job.requiredPermission !== null && hasPermission(ctx, job.requiredPermission));
      if (!allowed) throw new ForbiddenError('You do not have access to this job.');
      return jobView(job);
    });
  }

  /**
   * S5-19: enqueues one date-keyed `files.purge` per organization with due purges. Repeated
   * runs on the same day return the existing job.
   */
  async schedulePurges(): Promise<number> {
    const organizations = await inTransaction(this.deps.db, {}, (tx) =>
      organizationsWithDuePurges(tx),
    );
    const day = this.deps.clock.now().toISOString().slice(0, 10);
    let created = 0;
    for (const organizationId of organizations) {
      const result = await inTransaction(this.deps.db, { organizationId }, (tx) =>
        this.enqueue(tx, {
          organizationId,
          type: FILES_PURGE_JOB,
          jobKey: `${FILES_PURGE_JOB}:${day}`,
        }),
      );
      if (result.created) created += 1;
    }
    return created;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 2000);
}

/**
 * In-process worker (S5-17). `runOnce` claims and processes one batch (tests drive it
 * directly); `start` polls until stopped.
 */
export class JobWorker {
  readonly workerId: string;

  constructor(
    private readonly deps: AppDependencies,
    /** Registered handlers (read-only; tests build workers that keep every handler). */
    readonly handlers: ReadonlyMap<string, JobHandler>,
    options: { workerId?: string; random?: () => number } = {},
  ) {
    this.workerId = options.workerId ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.random = options.random ?? Math.random;
  }

  private readonly random: () => number;

  private get config() {
    return this.deps.config.jobs;
  }

  async runOnce(): Promise<number> {
    const claimed = await inTransaction(this.deps.db, {}, (tx) =>
      claimJobs(tx, this.workerId, this.config.concurrency, this.config.staleLockMs),
    );
    await Promise.all(claimed.map((c) => this.process(c.organizationId, c.id)));
    return claimed.length;
  }

  private async process(organizationId: string, jobId: string): Promise<void> {
    const tenant = <T>(work: (tx: Transaction) => Promise<T>) =>
      inTransaction(this.deps.db, { organizationId }, work);
    const job = await tenant((tx) => getJob(tx, organizationId, jobId));
    if (!job || job.lockedBy !== this.workerId) return;
    const lock: JobLock = {
      organizationId,
      jobId,
      workerId: this.workerId,
      attempts: job.attempts,
    };

    // A stale lock recovered after the final attempt: nothing is left to try.
    if (job.attempts > job.maxAttempts) {
      await this.giveUp(lock, job, 'dead', 'The job exceeded its attempts (stale lock).');
      return;
    }
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.giveUp(lock, job, 'failed', `No handler for job type ${job.type}.`);
      return;
    }
    try {
      const result = await handler({
        job,
        organizationId,
        run: tenant,
        progress: (percent, message = null) =>
          tenant((tx) => setJobProgress(tx, lock, percent, message)),
      });
      await tenant((tx) => completeJob(tx, lock, result ?? null));
    } catch (error) {
      const description = describeError(error);
      this.deps.logger.warn(
        { jobId, jobType: job.type, attempt: job.attempts, err: error },
        'Job attempt failed',
      );
      if (error instanceof PermanentJobError) {
        await this.giveUp(lock, job, 'failed', description);
      } else if (job.attempts >= job.maxAttempts) {
        await this.giveUp(lock, job, 'dead', description);
      } else {
        const delay = backoffDelayMs(
          job.attempts,
          this.config.backoffBaseMs,
          this.config.backoffMaxMs,
          this.random,
        );
        await tenant((tx) => retryJob(tx, lock, description, delay));
      }
    }
  }

  private async giveUp(lock: JobLock, job: JobRecord, status: 'failed' | 'dead', error: string) {
    await inTransaction(this.deps.db, { organizationId: lock.organizationId }, async (tx) => {
      if (!(await finishJobUnsuccessfully(tx, lock, status, error))) return;
      // S5-18 / §12: `job.failed` is audited when a job is dead-lettered. Permanent failures
      // keep their status and error on the job row and in the logs.
      if (status !== 'dead') return;
      await recordAuditEvent(tx, {
        occurredAt: this.deps.clock.now(),
        organizationId: lock.organizationId,
        actorUserId: null,
        actorType: 'system',
        action: 'job.failed',
        resourceType: 'job',
        resourceId: job.id,
        metadata: { type: job.type, status, attempts: job.attempts },
        origin: systemOrigin(job.id),
      });
    });
  }

  /** Polls every `pollIntervalMs`; returns a stop function that waits for the in-flight batch. */
  start(onError: (error: unknown) => void): () => Promise<void> {
    return poll(() => this.runOnce(), this.config.pollIntervalMs, onError);
  }
}

export function systemOrigin(jobId: string): EventOrigin {
  return { requestId: `job:${jobId}`, ipAddress: null, userAgent: null };
}

/** Runs `tick` repeatedly with `intervalMs` between runs; the stop function awaits the last run. */
export function poll(
  tick: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let stopped = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const run = () => {
    if (stopped) return;
    inFlight = tick()
      .catch(onError)
      .finally(() => {
        if (!stopped) timer = setTimeout(run, intervalMs);
      });
  };
  let timer = setTimeout(run, intervalMs);
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await inFlight;
  };
}
