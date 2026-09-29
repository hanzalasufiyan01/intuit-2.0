import {
  listBatchesForCleanup,
  listExportsForCleanup,
  organizationsWithDataExchangeWork,
  redactRows,
  updateBatch,
  updateExport,
} from '../../modules/data-exchange/index.js';
import { getJobByKey } from '../../modules/jobs/index.js';
import type { AppDependencies } from '../dependencies.js';
import type { FileService } from '../file-service.js';
import { systemOrigin, type JobContext, type JobService } from '../job-service.js';
import { inTransaction } from '../unit-of-work.js';
import { EXPORT_GENERATE_JOB } from './export-service.js';
import { IMPORT_COMMIT_JOB, IMPORT_VALIDATE_JOB } from './import-service.js';

export const DATA_EXCHANGE_CLEANUP_JOB = 'data_exchange.cleanup';

/**
 * Import/export housekeeping (S6-27, S6-36; L-11), hourly per organization with work due:
 * idle batches expire after 7 days, finished batches have their staged source cells and typed
 * values redacted after 30 days, ready exports expire after 7 days (files soft-deleted, then
 * the S5 purge), and work whose job ended without finishing is reconciled.
 */
export class DataExchangeCleanup {
  constructor(
    private readonly deps: AppDependencies,
    private readonly files: FileService,
    private readonly jobs: JobService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private redactBefore() {
    return new Date(this.now.getTime() - this.deps.config.dataExchange.stagingRetentionMs);
  }

  /** Enqueues one hour-keyed cleanup per organization with work due (idempotent per hour). */
  async schedule(): Promise<number> {
    const organizations = await inTransaction(this.deps.db, {}, (tx) =>
      organizationsWithDataExchangeWork(tx, this.redactBefore()),
    );
    const hour = this.now.toISOString().slice(0, 13);
    let created = 0;
    for (const organizationId of organizations) {
      const result = await inTransaction(this.deps.db, { organizationId }, (tx) =>
        this.jobs.enqueue(tx, {
          organizationId,
          type: DATA_EXCHANGE_CLEANUP_JOB,
          jobKey: `${DATA_EXCHANGE_CLEANUP_JOB}:${hour}`,
        }),
      );
      if (result.created) created += 1;
    }
    return created;
  }

  async run(job: JobContext) {
    const origin = systemOrigin(job.job.id);
    return job.run(async (tx) => {
      const organizationId = job.organizationId;
      const summary = {
        expired: 0,
        redacted: 0,
        reconciled: 0,
        exportsExpired: 0,
        exportsFailed: 0,
      };
      const batches = await listBatchesForCleanup(tx, organizationId, this.redactBefore());
      for (const batch of batches.expired) {
        await updateBatch(tx, organizationId, batch.id, {
          status: 'expired',
          finishedAt: this.now,
        });
        if (batch.fileId)
          await this.files.systemDeleteInTransaction(tx, organizationId, batch.fileId, origin);
        summary.expired += 1;
      }
      for (const batch of batches.toRedact) {
        await redactRows(tx, organizationId, batch.id);
        await updateBatch(tx, organizationId, batch.id, { redactedAt: this.now });
        summary.redacted += 1;
      }
      for (const batch of batches.stale) {
        const key =
          batch.status === 'validating'
            ? `${IMPORT_VALIDATE_JOB}:${batch.id}:${batch.mappingVersion}`
            : `${IMPORT_COMMIT_JOB}:${batch.id}`;
        const type = batch.status === 'validating' ? IMPORT_VALIDATE_JOB : IMPORT_COMMIT_JOB;
        const pending = await getJobByKey(tx, organizationId, type, key);
        if (pending && (pending.status === 'queued' || pending.status === 'running')) continue;
        await updateBatch(tx, organizationId, batch.id, {
          status: batch.status === 'validating' ? 'ready' : 'needs_review',
          summary: {
            ...batch.summary,
            lastError:
              batch.status === 'validating'
                ? 'Validation could not be completed. Try again.'
                : 'The commit could not be completed; nothing was imported. Review and try again.',
          },
        });
        summary.reconciled += 1;
      }
      const exportsDue = await listExportsForCleanup(tx, organizationId);
      for (const e of exportsDue.expired) {
        await updateExport(tx, organizationId, e.id, { status: 'expired' });
        if (e.fileId)
          await this.files.systemDeleteInTransaction(tx, organizationId, e.fileId, origin);
        summary.exportsExpired += 1;
      }
      for (const e of exportsDue.stale) {
        const pending = await getJobByKey(
          tx,
          organizationId,
          EXPORT_GENERATE_JOB,
          `${EXPORT_GENERATE_JOB}:${e.id}`,
        );
        if (pending && (pending.status === 'queued' || pending.status === 'running')) continue;
        await updateExport(tx, organizationId, e.id, {
          status: 'failed',
          error: 'The export could not be completed.',
          finishedAt: this.now,
        });
        summary.exportsFailed += 1;
      }
      return summary;
    });
  }
}
