import { utimes, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDependencies } from '../src/application/dependencies.js';
import {
  FILES_PURGE_JOB,
  JobWorker,
  type JobContext,
  type JobHandler,
} from '../src/application/job-service.js';
import { inTransaction } from '../src/application/unit-of-work.js';
import {
  backoffDelayMs,
  completeJob,
  enqueueJob,
  PermanentJobError,
} from '../src/modules/jobs/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  HOUR,
  TEST_STORAGE_ROOT,
  type TestContext,
} from './helpers.js';

/** Phase 3A S5 jobs: queue, claim, worker, retries, dead letter, stale locks, status, purge. */

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

let ctx: TestContext;
let org: AccountingOrg;
let deps: AppDependencies;
const testType = `test.s5_${randomUUID().slice(0, 8)}`;

function workerWith(handlers: Record<string, JobHandler>, workerId?: string) {
  return new JobWorker(
    deps,
    new Map<string, JobHandler>([
      // Every registered handler (files.purge, S6 import/export jobs) so parallel test files'
      // jobs are never claimed and failed as unknown types.
      ...ctx.worker.handlers,
      ...Object.entries(handlers),
    ]),
    { ...(workerId ? { workerId } : {}), random: () => 0.5 },
  );
}

function enqueue(
  organizationId: string,
  input: {
    type?: string;
    jobKey?: string;
    payload?: Record<string, unknown>;
    requiredPermission?: string;
    createdByUserId?: string;
  } = {},
) {
  return inTransaction(ctx.database.db, { organizationId }, (tx) =>
    ctx.services.jobs.enqueue(tx, { organizationId, type: input.type ?? testType, ...input }),
  );
}

async function jobRow(id: string) {
  const owner = await connectAs('owner');
  try {
    return (await owner.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
  } finally {
    await owner.end();
  }
}

async function ownerSql(text: string, params: unknown[] = []) {
  const owner = await connectAs('owner');
  try {
    return await owner.query(text, params);
  } finally {
    await owner.end();
  }
}

/** Runs worker batches until `id` leaves the queue (or a bound is hit). */
async function drain(worker: JobWorker, id: string) {
  for (let i = 0; i < 20; i++) {
    await worker.runOnce();
    const row = await jobRow(id);
    if (row.status !== 'queued' && row.status !== 'running') return row;
  }
  return jobRow(id);
}

beforeAll(async () => {
  ctx = await createTestContext({ JOBS_CONCURRENCY: '10' });
  deps = {
    db: ctx.database.db,
    config: ctx.config,
    clock: ctx.clock,
    logger: ctx.app.log,
    emailProvider: ctx.email,
  } as unknown as AppDependencies;
  org = await setUpAccountingOrg(ctx, { fiscalYear: false });
});
afterAll(async () => {
  // Leave nothing claimable behind for later runs.
  await ownerSql(
    `UPDATE jobs SET status = 'dead', finished_at = now(), locked_at = NULL, locked_by = NULL
      WHERE type = $1 AND status IN ('queued', 'running')`,
    [testType],
  );
  await ctx.close();
});

describe('backoff (S5-14)', () => {
  it('grows by 6x from 5 s, caps at 15 min and jitters by ±20%', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, 5000, 900_000, mid))).toEqual([
      5000, 30_000, 180_000, 900_000, 900_000,
    ]);
    expect(backoffDelayMs(1, 5000, 900_000, () => 0)).toBe(4000);
    expect(backoffDelayMs(1, 5000, 900_000, () => 1)).toBe(6000);
  });
});

describe('enqueue (S5-15)', () => {
  it('is idempotent on (organization, type, key) and returns the existing job', async () => {
    const key = `k-${randomUUID()}`;
    const first = await enqueue(org.organizationId, { jobKey: key, payload: { n: 1 } });
    const again = await enqueue(org.organizationId, { jobKey: key, payload: { n: 2 } });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, job: { id: first.job.id, payload: { n: 1 } } });
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    const elsewhere = await enqueue(other.organizationId, { jobKey: key });
    expect(elsewhere.created).toBe(true);
    const unkeyed = [await enqueue(org.organizationId), await enqueue(org.organizationId)];
    expect(unkeyed[0]!.job.id).not.toBe(unkeyed[1]!.job.id);
  });

  it('bounds payloads and types in the database', async () => {
    await expect(
      enqueue(org.organizationId, { payload: { big: 'x'.repeat(17_000) } }),
    ).rejects.toThrow();
    await expect(enqueue(org.organizationId, { type: 'NoDots' })).rejects.toThrow();
  });
});

describe('worker', () => {
  it('runs a job, records progress and result', async () => {
    const seen: string[] = [];
    const { job } = await enqueue(org.organizationId, { payload: { value: 21 } });
    const worker = workerWith({
      [testType]: async (j: JobContext) => {
        seen.push(j.job.id);
        await j.progress(40, 'Halfway');
        const progress = await jobRow(j.job.id);
        expect(progress).toMatchObject({
          progress: 40,
          progress_message: 'Halfway',
          status: 'running',
        });
        return { doubled: (j.job.payload.value as number) * 2 };
      },
    });
    const row = await drain(worker, job.id);
    expect(row).toMatchObject({
      status: 'succeeded',
      progress: 100,
      result: { doubled: 42 },
      attempts: 1,
    });
    expect(row.locked_by).toBeNull();
    expect(seen.filter((id) => id === job.id)).toHaveLength(1);
  });

  it('never lets two workers claim the same job', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) ids.add((await enqueue(org.organizationId)).job.id);
    const runs: string[] = [];
    const handler: JobHandler = async (j) => {
      runs.push(j.job.id);
      await new Promise((r) => setTimeout(r, 5));
      return null;
    };
    const a = workerWith({ [testType]: handler }, 'worker-a');
    const b = workerWith({ [testType]: handler }, 'worker-b');
    for (let i = 0; i < 10; i++) await Promise.all([a.runOnce(), b.runOnce()]);
    const mine = runs.filter((id) => ids.has(id));
    expect(new Set(mine).size).toBe(20);
    expect(mine).toHaveLength(20);
  });

  it('retries with backoff, then dead-letters after 5 attempts with a job.failed audit', async () => {
    const { job } = await enqueue(org.organizationId);
    const worker = workerWith({
      [testType]: async () => {
        throw new Error('temporary outage');
      },
    });
    await worker.runOnce();
    let row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(row.last_error).toContain('temporary outage');
    const delay = (row.run_after.getTime() - row.updated_at.getTime()) / 1000;
    expect(delay).toBeGreaterThanOrEqual(4);
    expect(delay).toBeLessThanOrEqual(6);

    for (let attempt = 2; attempt <= 5; attempt++) {
      await ownerSql('UPDATE jobs SET run_after = now() WHERE id = $1', [job.id]);
      await worker.runOnce();
    }
    row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'dead', attempts: 5 });
    expect(row.finished_at).not.toBeNull();
    const audit = await ownerSql(
      "SELECT actor_type, metadata FROM audit_events WHERE action = 'job.failed' AND resource_id = $1",
      [job.id],
    );
    expect(audit.rows).toEqual([
      { actor_type: 'system', metadata: { type: testType, status: 'dead', attempts: 5 } },
    ]);
  });

  it('fails permanently without retrying, and fails unknown job types', async () => {
    const { job } = await enqueue(org.organizationId);
    const worker = workerWith({
      [testType]: async () => {
        throw new PermanentJobError('bad input');
      },
    });
    const row = await drain(worker, job.id);
    expect(row).toMatchObject({ status: 'failed', attempts: 1 });

    const unknown = await enqueue(org.organizationId, { type: `${testType}.unknown` });
    const failed = await drain(worker, unknown.job.id);
    expect(failed).toMatchObject({ status: 'failed' });
    const audit = await ownerSql(
      "SELECT count(*)::int AS n FROM audit_events WHERE action = 'job.failed' AND resource_id = ANY($1)",
      [[job.id, unknown.job.id]],
    );
    // S5-18 / §12: only dead-lettered jobs are audited; permanent failures stay on the job row.
    expect(audit.rows[0].n).toBe(0);
  });

  it('recovers stale locks after 10 minutes, not before, and dead-letters exhausted ones', async () => {
    const handler: JobHandler = async () => ({ ok: true });
    const worker = workerWith({ [testType]: handler });
    const fresh = await enqueue(org.organizationId);
    const stale = await enqueue(org.organizationId);
    const exhausted = await enqueue(org.organizationId);
    const lockSql = `UPDATE jobs SET status = 'running', locked_by = 'ghost', attempts = $2,
                      locked_at = now() - $3::interval WHERE id = $1`;
    await ownerSql(lockSql, [fresh.job.id, 1, '9 minutes']);
    await ownerSql(lockSql, [stale.job.id, 1, '11 minutes']);
    await ownerSql(lockSql, [exhausted.job.id, 5, '11 minutes']);
    await worker.runOnce();
    await worker.runOnce();
    expect(await jobRow(fresh.job.id)).toMatchObject({ status: 'running', locked_by: 'ghost' });
    expect(await jobRow(stale.job.id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await jobRow(exhausted.job.id)).toMatchObject({ status: 'dead', attempts: 6 });

    // The ghost can no longer change the job it lost.
    const lost = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId },
      (tx) =>
        completeJob(
          tx,
          {
            organizationId: org.organizationId,
            jobId: stale.job.id,
            workerId: 'ghost',
            attempts: 1,
          },
          null,
        ),
    );
    expect(lost).toBe(false);
  });
});

describe('GET /jobs/:id (S5-16)', () => {
  it('shows a job to its creator and holders of the required permission only', async () => {
    const ownerUser = (await org.owner.get('/auth/session')).body.data.user.id as string;
    const mine = await enqueue(org.organizationId, { createdByUserId: ownerUser });
    const res = await org.owner.get(`/jobs/${mine.job.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: mine.job.id,
      type: testType,
      status: 'queued',
      error: null,
    });

    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get(`/jobs/${mine.job.id}`)).status).toBe(403);
    const shared = await enqueue(org.organizationId, {
      createdByUserId: ownerUser,
      requiredPermission: 'parties.view',
    });
    expect((await member.client.get(`/jobs/${shared.job.id}`)).status).toBe(200);
    const restricted = await enqueue(org.organizationId, {
      createdByUserId: ownerUser,
      requiredPermission: 'parties.update',
    });
    expect((await member.client.get(`/jobs/${restricted.job.id}`)).status).toBe(403);

    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    expect((await other.owner.get(`/jobs/${mine.job.id}`)).status).toBe(404);
    expect((await org.owner.get(`/jobs/${randomUUID()}`)).status).toBe(404);
  });

  it('never exposes handler error detail', async () => {
    const ownerUser = (await org.owner.get('/auth/session')).body.data.user.id as string;
    const { job } = await enqueue(org.organizationId, { createdByUserId: ownerUser });
    await drain(
      workerWith({
        [testType]: async () => {
          throw new PermanentJobError('SELECT secret FROM internals');
        },
      }),
      job.id,
    );
    const res = await org.owner.get(`/jobs/${job.id}`);
    expect(res.body.data).toMatchObject({
      status: 'failed',
      error: 'The job could not be completed.',
    });
    expect(JSON.stringify(res.body)).not.toContain('internals');
  });
});

describe('file purge (S5-13, S5-19)', () => {
  it('schedules one date-keyed purge per organization and purges due files with audit', async () => {
    const party = await org.owner.post('/parties', {
      kind: 'organization',
      displayName: 'Purge Co',
    });
    const up = await org.owner.upload(
      `/files?linkType=party&linkId=${party.body.data.id}`,
      PDF,
      'old.pdf',
    );
    const keep = await org.owner.upload(
      `/files?linkType=party&linkId=${party.body.data.id}`,
      PDF,
      'keep.pdf',
    );
    expect((await org.owner.delete(`/files/${up.body.data.id}`)).status).toBe(204);
    const file = (await ownerSql('SELECT storage_key FROM files WHERE id = $1', [up.body.data.id]))
      .rows[0];
    const objectPath = path.join(TEST_STORAGE_ROOT, ...(file.storage_key as string).split('/'));

    // Not yet due: nothing scheduled for this organization.
    await ctx.services.jobs.schedulePurges();
    const day = ctx.clock.now().toISOString().slice(0, 10);
    const key = `${FILES_PURGE_JOB}:${day}`;
    const before = await ownerSql(
      'SELECT id FROM jobs WHERE organization_id = $1 AND job_key = $2',
      [org.organizationId, key],
    );
    expect(before.rowCount).toBe(0);

    await ownerSql("UPDATE files SET purge_after = now() - interval '1 second' WHERE id = $1", [
      up.body.data.id,
    ]);
    await ctx.services.jobs.schedulePurges();
    await ctx.services.jobs.schedulePurges();
    const scheduled = await ownerSql(
      'SELECT id FROM jobs WHERE organization_id = $1 AND job_key = $2',
      [org.organizationId, key],
    );
    expect(scheduled.rowCount).toBe(1);

    const row = await drain(ctx.worker, scheduled.rows[0].id);
    expect(row.status).toBe('succeeded');
    expect(row.result.purged).toBeGreaterThanOrEqual(1);
    const purged = (
      await ownerSql('SELECT status, purged_at FROM files WHERE id = $1', [up.body.data.id])
    ).rows[0];
    expect(purged.status).toBe('purged');
    await expect(import('node:fs/promises').then((fs) => fs.stat(objectPath))).rejects.toThrow();
    const audit = await ownerSql(
      "SELECT actor_type FROM audit_events WHERE action = 'file.purged' AND resource_id = $1",
      [up.body.data.id],
    );
    expect(audit.rows).toEqual([{ actor_type: 'system' }]);
    // Live files are untouched.
    expect((await org.owner.get(`/files/${keep.body.data.id}`)).status).toBe(200);
  });

  it('sweeps orphaned objects older than an hour and keeps recent ones and live files', async () => {
    const party = await org.owner.post('/parties', {
      kind: 'organization',
      displayName: 'Orphan Co',
    });
    const live = await org.owner.upload(
      `/files?linkType=party&linkId=${party.body.data.id}`,
      PDF,
      'live.pdf',
    );
    const livePath = (
      await ownerSql('SELECT storage_key FROM files WHERE id = $1', [live.body.data.id])
    ).rows[0].storage_key as string;
    const dir = path.join(TEST_STORAGE_ROOT, 'org', org.organizationId, '2026', '01');
    await mkdir(dir, { recursive: true });
    const oldOrphan = path.join(dir, randomUUID());
    const newOrphan = path.join(dir, randomUUID());
    await writeFile(oldOrphan, 'x');
    await writeFile(newOrphan, 'x');
    const twoHoursAgo = new Date(Date.now() - 2 * HOUR);
    await utimes(oldOrphan, twoHoursAgo, twoHoursAgo);
    await utimes(path.join(TEST_STORAGE_ROOT, ...livePath.split('/')), twoHoursAgo, twoHoursAgo);

    const { job } = await enqueue(org.organizationId, {
      type: FILES_PURGE_JOB,
      jobKey: `sweep-${randomUUID()}`,
    });
    const row = await drain(ctx.worker, job.id);
    expect(row.status).toBe('succeeded');
    expect(row.result.orphansRemoved).toBeGreaterThanOrEqual(1);
    const fs = await import('node:fs/promises');
    await expect(fs.stat(oldOrphan)).rejects.toThrow();
    await expect(fs.stat(newOrphan)).resolves.toBeDefined();
    await expect(
      fs.stat(path.join(TEST_STORAGE_ROOT, ...livePath.split('/'))),
    ).resolves.toBeDefined();
  });
});

describe('database security (K-2)', () => {
  it('applies RLS to jobs, forbids deletes and restricts the definer functions', async () => {
    const { job } = await enqueue(org.organizationId);
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query("SELECT set_config('app.organization_id', $1, true)", [randomUUID()]);
      expect((await app.query('SELECT 1 FROM jobs WHERE id = $1', [job.id])).rowCount).toBe(0);
      await expect(app.query('DELETE FROM jobs WHERE id = $1', [job.id])).rejects.toThrow(
        /permission denied/,
      );
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
    const grants = await ownerSql(
      `SELECT p.proname, p.prosecdef, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('intuit_app', p.oid, 'EXECUTE') AS app_exec
         FROM pg_proc p
        WHERE p.proname IN ('app_claim_jobs', 'app_organizations_with_due_file_purges')
        ORDER BY p.proname`,
    );
    expect(grants.rows).toEqual([
      { proname: 'app_claim_jobs', prosecdef: true, public_exec: false, app_exec: true },
      {
        proname: 'app_organizations_with_due_file_purges',
        prosecdef: true,
        public_exec: false,
        app_exec: true,
      },
    ]);
  });

  it('enforces lock and completion consistency', async () => {
    const { job } = await enqueue(org.organizationId);
    await expect(
      ownerSql("UPDATE jobs SET status = 'running' WHERE id = $1", [job.id]),
    ).rejects.toThrow(/jobs_lock_consistency/);
    await expect(
      ownerSql("UPDATE jobs SET status = 'succeeded' WHERE id = $1", [job.id]),
    ).rejects.toThrow(/jobs_finished_consistency/);
  });

  it('keeps enqueue within the tenant (RLS WITH CHECK)', async () => {
    const other = await setUpAccountingOrg(ctx, { fiscalYear: false });
    await expect(
      inTransaction(ctx.database.db, { organizationId: org.organizationId }, (tx) =>
        enqueueJob(tx, { organizationId: other.organizationId, type: testType, maxAttempts: 5 }),
      ),
    ).rejects.toThrow();
  });
});
