import { and, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { jobs } from './schema.js';

export type JobRecord = typeof jobs.$inferSelect;

export interface NewJob {
  organizationId: string;
  type: string;
  /** Idempotency key: an enqueue with an existing (organization, type, key) returns that job. */
  jobKey?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts: number;
  requiredPermission?: string | null;
  createdByUserId?: string | null;
}

/**
 * Enqueues a job in the caller's transaction (S5-15). Returns the existing job when the
 * idempotency key is already taken; `created` says which.
 */
export async function enqueueJob(
  tx: Transaction,
  job: NewJob,
): Promise<{ job: JobRecord; created: boolean }> {
  const [inserted] = await tx
    .insert(jobs)
    .values({
      organizationId: job.organizationId,
      type: job.type,
      jobKey: job.jobKey ?? null,
      payload: job.payload ?? {},
      maxAttempts: job.maxAttempts,
      requiredPermission: job.requiredPermission ?? null,
      createdByUserId: job.createdByUserId ?? null,
    })
    .onConflictDoNothing({
      target: [jobs.organizationId, jobs.type, jobs.jobKey],
      where: sql`job_key IS NOT NULL`,
    })
    .returning();
  if (inserted) return { job: inserted, created: true };
  const [existing] = await tx
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.organizationId, job.organizationId),
        eq(jobs.type, job.type),
        eq(jobs.jobKey, job.jobKey!),
      ),
    );
  return { job: existing!, created: false };
}

export async function getJob(
  tx: Transaction,
  organizationId: string,
  jobId: string,
): Promise<JobRecord | undefined> {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.organizationId, organizationId), eq(jobs.id, jobId)));
  return row;
}

export interface ClaimedJob {
  id: string;
  organizationId: string;
  type: string;
}

/**
 * Claims due jobs across organizations through the narrow SECURITY DEFINER function (K-2):
 * queued jobs whose run_after has passed, and running jobs whose lock is stale.
 */
export async function claimJobs(
  tx: Transaction,
  workerId: string,
  limit: number,
  staleAfterMs: number,
): Promise<ClaimedJob[]> {
  const result = await tx.execute<{ id: string; organization_id: string; type: string }>(
    sql`SELECT id, organization_id, type
          FROM app_claim_jobs(${workerId}, ${limit}, make_interval(secs => ${staleAfterMs / 1000}))`,
  );
  return result.rows.map((r) => ({ id: r.id, organizationId: r.organization_id, type: r.type }));
}

/** Only the worker holding the current lock may change a running job. */
function held(organizationId: string, jobId: string, workerId: string, attempts: number) {
  return and(
    eq(jobs.organizationId, organizationId),
    eq(jobs.id, jobId),
    eq(jobs.status, 'running'),
    eq(jobs.lockedBy, workerId),
    eq(jobs.attempts, attempts),
  );
}

export interface JobLock {
  organizationId: string;
  jobId: string;
  workerId: string;
  attempts: number;
}

export async function setJobProgress(
  tx: Transaction,
  lock: JobLock,
  progress: number,
  message: string | null,
): Promise<boolean> {
  const rows = await tx
    .update(jobs)
    .set({
      progress: Math.max(0, Math.min(100, Math.round(progress))),
      progressMessage: message?.slice(0, 500) ?? null,
      updatedAt: sql`now()`,
    })
    .where(held(lock.organizationId, lock.jobId, lock.workerId, lock.attempts))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

export async function completeJob(
  tx: Transaction,
  lock: JobLock,
  result: Record<string, unknown> | null,
): Promise<boolean> {
  const rows = await tx
    .update(jobs)
    .set({
      status: 'succeeded',
      progress: 100,
      result,
      lockedAt: null,
      lockedBy: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(held(lock.organizationId, lock.jobId, lock.workerId, lock.attempts))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Schedules another attempt after `delayMs` (database clock). */
export async function retryJob(
  tx: Transaction,
  lock: JobLock,
  error: string,
  delayMs: number,
): Promise<boolean> {
  const rows = await tx
    .update(jobs)
    .set({
      status: 'queued',
      lastError: error.slice(0, 2000),
      runAfter: sql`now() + make_interval(secs => ${delayMs / 1000})`,
      lockedAt: null,
      lockedBy: null,
      updatedAt: sql`now()`,
    })
    .where(held(lock.organizationId, lock.jobId, lock.workerId, lock.attempts))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Ends a job as `failed` (permanent error) or `dead` (attempts exhausted). */
export async function finishJobUnsuccessfully(
  tx: Transaction,
  lock: JobLock,
  status: 'failed' | 'dead',
  error: string,
): Promise<boolean> {
  const rows = await tx
    .update(jobs)
    .set({
      status,
      lastError: error.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(held(lock.organizationId, lock.jobId, lock.workerId, lock.attempts))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** The job with an idempotency key, if any (S6: reconciling work whose job ended). */
export async function getJobByKey(
  tx: Transaction,
  organizationId: string,
  type: string,
  jobKey: string,
): Promise<JobRecord | undefined> {
  const [row] = await tx
    .select()
    .from(jobs)
    .where(
      and(eq(jobs.organizationId, organizationId), eq(jobs.type, type), eq(jobs.jobKey, jobKey)),
    );
  return row;
}
