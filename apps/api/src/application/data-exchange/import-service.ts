import { sql } from 'drizzle-orm';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../domain/errors.js';
import type { Transaction } from '../../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../../modules/audit/index.js';
import { journalsCreatedByImport } from '../../modules/accounting/index.js';
import {
  countActiveBatches,
  CsvError,
  csvRecord,
  CSV_BOM,
  detectDelimiter,
  findCommittedBatchWithFile,
  getBatch,
  getMapping,
  IMPORT_LIMITS,
  insertBatch,
  insertMapping,
  insertRows,
  listBatches,
  listMappings,
  listRows,
  loadRows,
  normalize,
  readCsv,
  rowCounts,
  setRowsExcluded,
  softDeleteMapping,
  updateBatch,
  writeRecordIds,
  writeRowResults,
  type CsvDelimiter,
  type ImportBatch,
  type ImportDomainKey,
  type ImportOptions,
  type ImportRow,
  type ImportRowStatus,
  type RowMessage,
} from '../../modules/data-exchange/index.js';
import {
  hasPermission,
  requirePermission,
  resolveActingUserContext,
  type AuthorizationContext,
  type Principal,
} from '../authorization.js';
import type { AppDependencies } from '../dependencies.js';
import type { FileService } from '../file-service.js';
import type { JobContext, JobService } from '../job-service.js';
import { withOrganization } from '../organization-service.js';
import { importDomains } from './imports/index.js';
import type { DomainServices, ImportDomain, ImportField, MappedRow, RowOutcome } from './types.js';

/**
 * Import batches (Decision 7 pipeline; S6-01..S6-25, S6-35..S6-46; L-1, L-6, L-9, L-10):
 * create → upload (S5 files, link type import_batch) → inspect → map → validate every row
 * (background job, dry run) → review (first 500 rows shown, full error report) → commit (one
 * atomic transaction through the owning services, re-validated inside it).
 */

export const IMPORT_VALIDATE_JOB = 'import.validate';
export const IMPORT_COMMIT_JOB = 'import.commit';

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  delimiter: 'auto',
};

const SAMPLE_ROWS = 20;

/** Option input as parsed from requests: absent keys keep their current value. */
export type ImportOptionsInput = { [K in keyof ImportOptions]?: ImportOptions[K] | undefined };

function definedOptions(input: ImportOptionsInput): Partial<ImportOptions> {
  return Object.fromEntries(
    Object.entries(input).filter(([, v]) => v !== undefined),
  ) as Partial<ImportOptions>;
}

/** A commit whose re-validation found errors: rolled back, then reported (S6-12). */
class CommitValidationFailed extends Error {
  constructor(readonly outcomes: RowOutcome[]) {
    super('Commit re-validation failed');
  }
}

const importOrigin = (batchId: string): EventOrigin => ({
  requestId: `import:${batchId}`,
  ipAddress: null,
  userAgent: null,
});

function statusOf(outcome: RowOutcome): ImportRowStatus {
  if (outcome.messages.some((m) => m.severity === 'error')) return 'error';
  if (outcome.messages.some((m) => m.severity === 'warning')) return 'warning';
  return 'valid';
}

export function batchView(batch: ImportBatch, domain: ImportDomain) {
  const summary = batch.summary as Record<string, unknown>;
  return {
    id: batch.id,
    domain: batch.domain,
    domainLabel: domain.label,
    format: batch.format,
    status: batch.status,
    version: batch.version,
    options: batch.options,
    mapping: batch.mapping,
    mappingVersion: batch.mappingVersion,
    validatedMappingVersion: batch.validatedMappingVersion,
    columns: batch.columns,
    counts: {
      total: batch.rowCount,
      valid: batch.validCount,
      warning: batch.warningCount,
      error: batch.errorCount,
      excluded: batch.excludedCount,
    },
    fileId: batch.fileId,
    fileName: (summary.fileName as string | undefined) ?? null,
    duplicateOfBatchId: (summary.duplicateOfBatchId as string | undefined) ?? null,
    lastError: (summary.lastError as string | undefined) ?? null,
    created: (summary.created as number | undefined) ?? null,
    discardedDrafts: (summary.discardedDrafts as number | undefined) ?? null,
    jobs: {
      validate: (summary.validateJobId as string | undefined) ?? null,
      commit: (summary.commitJobId as string | undefined) ?? null,
    },
    createdByUserId: batch.createdByUserId,
    committedByUserId: batch.committedByUserId,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    committedAt: batch.committedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    expiresAt: batch.expiresAt.toISOString(),
    redacted: batch.redactedAt !== null,
  };
}

/** Suggests field → column from normalized headers, labels and synonyms (S6-42). */
export function suggestMapping(fields: readonly ImportField[], columns: readonly string[]) {
  const keys = columns.map((c) => normalize.matchKey(c));
  const used = new Set<number>();
  const mapping: Record<string, number | null> = {};
  for (const f of fields) {
    const candidates = [f.key, f.label, ...f.synonyms].map((c) => normalize.matchKey(c));
    const index = keys.findIndex((k, i) => !used.has(i) && candidates.includes(k));
    mapping[f.key] = index >= 0 ? index : null;
    if (index >= 0) used.add(index);
  }
  return mapping;
}

export class ImportService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly services: DomainServices,
    private readonly files: FileService,
    private readonly jobs: JobService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private get limits() {
    return this.deps.config.dataExchange;
  }

  domain(key: ImportDomainKey): ImportDomain {
    const domain = importDomains.get(key);
    if (!domain) throw new ValidationError([{ path: 'domain', message: 'Unknown import type.' }]);
    return domain;
  }

  /** Loads a batch; `view` allows its creator, `change` needs the domain's create permission. */
  private async loadBatch(
    tx: Transaction,
    ctx: AuthorizationContext,
    batchId: string,
    access: 'view' | 'change',
    options: { forUpdate?: boolean } = {},
  ) {
    const batch = await getBatch(tx, ctx.organizationId, batchId, options);
    if (!batch) throw new NotFoundError('Import not found.');
    const domain = this.domain(batch.domain);
    if (access === 'change' || batch.createdByUserId !== ctx.userId) {
      requirePermission(ctx, domain.permission);
    }
    return { batch, domain };
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    batch: ImportBatch,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'import_batch',
      resourceId: batch.id,
      metadata: { domain: batch.domain, ...metadata },
      origin,
    });
  }

  private assertVersion(batch: ImportBatch, version: number) {
    if (batch.version !== version) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'This import changed in the meantime. Reload it and try again.',
      );
    }
  }

  private async assertCapacity(tx: Transaction, organizationId: string) {
    if ((await countActiveBatches(tx, organizationId)) >= this.limits.maxActivePerOrganization) {
      throw new AppError(
        'IMPORT_LIMIT_REACHED',
        409,
        'Other imports are being validated or committed. Try again when they finish.',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Catalog, templates and saved mappings
  // ---------------------------------------------------------------------------

  catalog(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const result = [];
      for (const domain of importDomains.values()) {
        if (!hasPermission(ctx, domain.permission)) continue;
        result.push({
          key: domain.key,
          label: domain.label,
          groupsRows: domain.groupsRows,
          fields: await domain.fields({ tx, ctx, services: this.services }),
        });
      }
      return result;
    });
  }

  /** A header-only CSV template (S6-41); the field guide is in the catalog. */
  template(principal: Principal, key: ImportDomainKey) {
    const domain = this.domain(key);
    return withOrganization(
      this.deps,
      principal,
      { permission: domain.permission },
      async (tx, ctx) => {
        const fields = await domain.fields({ tx, ctx, services: this.services });
        return {
          fileName: `${key.replace(/_/g, '-')}-template.csv`,
          content: CSV_BOM + csvRecord(fields.map((f) => f.label)),
        };
      },
    );
  }

  listMappings(principal: Principal, key: ImportDomainKey | undefined) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) =>
      (await listMappings(tx, ctx.organizationId, key))
        .filter((m) => hasPermission(ctx, this.domain(m.domain).permission))
        .map((m) => ({
          id: m.id,
          domain: m.domain,
          name: m.name,
          mapping: m.mapping,
          options: m.options,
          updatedAt: m.updatedAt.toISOString(),
        })),
    );
  }

  saveMapping(
    principal: Principal,
    input: {
      domain: ImportDomainKey;
      name: string;
      mapping: Record<string, string>;
      options: ImportOptionsInput;
    },
    origin: EventOrigin,
  ) {
    const domain = this.domain(input.domain);
    return withOrganization(
      this.deps,
      principal,
      { permission: domain.permission },
      async (tx, ctx) => {
        const fields = new Set(
          (await domain.fields({ tx, ctx, services: this.services })).map((f) => f.key),
        );
        const unknown = Object.keys(input.mapping).filter((k) => !fields.has(k));
        if (unknown.length) {
          throw new ValidationError([
            { path: 'mapping', message: 'The mapping names unknown fields.' },
          ]);
        }
        const saved = await insertMapping(tx, {
          organizationId: ctx.organizationId,
          domain: input.domain,
          name: input.name.trim(),
          mapping: input.mapping,
          options: definedOptions(input.options),
          userId: ctx.userId,
        });
        if (!saved)
          throw new ConflictError('CONFLICT', 'A saved mapping with this name already exists.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'import_mapping.saved',
          resourceType: 'import_mapping',
          resourceId: saved.id,
          metadata: { domain: saved.domain, name: saved.name },
          origin,
        });
        return {
          id: saved.id,
          domain: saved.domain,
          name: saved.name,
          mapping: saved.mapping,
          options: saved.options,
          updatedAt: saved.updatedAt.toISOString(),
        };
      },
    );
  }

  deleteMapping(principal: Principal, mappingId: string, origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const mapping = await getMapping(tx, ctx.organizationId, mappingId);
      if (!mapping) throw new NotFoundError('Saved mapping not found.');
      requirePermission(ctx, this.domain(mapping.domain).permission);
      await softDeleteMapping(tx, ctx.organizationId, mappingId);
      await recordAuditEvent(tx, {
        occurredAt: this.now,
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'import_mapping.deleted',
        resourceType: 'import_mapping',
        resourceId: mappingId,
        metadata: { domain: mapping.domain, name: mapping.name },
        origin,
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  create(
    principal: Principal,
    input: { domain: ImportDomainKey; options: ImportOptionsInput },
    origin: EventOrigin,
  ) {
    const domain = this.domain(input.domain);
    return withOrganization(
      this.deps,
      principal,
      { permission: domain.permission },
      async (tx, ctx) => {
        const batch = await insertBatch(tx, {
          organizationId: ctx.organizationId,
          domain: domain.key,
          options: { ...DEFAULT_IMPORT_OPTIONS, ...definedOptions(input.options) },
          userId: ctx.userId,
          expiresAt: new Date(this.now.getTime() + this.limits.batchExpiryMs),
        });
        await this.audit(tx, ctx, 'import.created', batch, {}, origin);
        return batchView(batch, domain);
      },
    );
  }

  get(principal: Principal, batchId: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'view');
      return batchView(batch, domain);
    });
  }

  list(
    principal: Principal,
    query: { domain?: ImportDomainKey | undefined; limit: number; before?: string | undefined },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const batches = await listBatches(tx, ctx.organizationId, {
        limit: query.limit,
        domain: query.domain,
        before: query.before ? new Date(query.before) : undefined,
      });
      return batches
        .filter(
          (b) =>
            b.createdByUserId === ctx.userId ||
            hasPermission(ctx, this.domain(b.domain).permission),
        )
        .map((b) => batchView(b, this.domain(b.domain)));
    });
  }

  /**
   * Reads the header and the first rows (S6-39): detects the delimiter unless one was chosen,
   * rejects blank or duplicate headers, and suggests a mapping. After staging, returns the stored
   * columns and the first staged rows.
   */
  inspect(principal: Principal, batchId: string, input: { delimiter?: CsvDelimiter | undefined }) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'change', {
        forUpdate: true,
      });
      const fields = await domain.fields({ tx, ctx, services: this.services });
      if (batch.status === 'awaiting_file' || !batch.fileId) {
        throw new ConflictError('INVALID_STATE_TRANSITION', 'Upload the file first.');
      }
      const staged = (batch.summary as Record<string, unknown>).staged === true;
      if (staged || batch.status !== 'ready') {
        const rows = await listRows(tx, ctx.organizationId, batch.id, {
          after: 0,
          limit: SAMPLE_ROWS,
        });
        return {
          batch: batchView(batch, domain),
          columns: batch.columns ?? [],
          sample: rows.map((r) => r.raw ?? []),
          suggestedMapping: batch.mapping ?? suggestMapping(fields, batch.columns ?? []),
          fields,
        };
      }
      const chosen =
        input.delimiter ?? (batch.options.delimiter === 'auto' ? null : batch.options.delimiter);
      const delimiter =
        chosen ?? (await this.detectFileDelimiter(tx, ctx.organizationId, batch.fileId));
      const { columns, sample } = await this.readHead(
        tx,
        ctx.organizationId,
        batch.fileId,
        delimiter,
      );
      const suggested = suggestMapping(fields, columns);
      const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
        columns,
        options: { ...batch.options, delimiter },
      });
      return {
        batch: batchView(updated, domain),
        columns,
        sample,
        suggestedMapping: suggested,
        fields,
      };
    });
  }

  private async detectFileDelimiter(tx: Transaction, organizationId: string, fileId: string) {
    const { stream } = await this.files.openStreamInTransaction(tx, organizationId, fileId);
    let head = '';
    try {
      for await (const chunk of stream) {
        head += (chunk as Buffer).toString('utf8');
        if (head.length > 65_536 || /[\r\n]/.test(head)) break;
      }
    } finally {
      stream.destroy();
    }
    return detectDelimiter(head.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)[0] ?? '');
  }

  private csvOptions(delimiter: CsvDelimiter) {
    return {
      delimiter,
      maxColumns: IMPORT_LIMITS.maxColumns,
      maxRecordChars: IMPORT_LIMITS.maxRecordChars,
    };
  }

  private fileError(error: unknown): string {
    if (error instanceof CsvError) return error.message;
    if (error instanceof AppError) return error.message;
    throw error;
  }

  private validateHeader(header: string[]): string[] {
    const columns = header.map((h) => h.trim());
    if (columns.length === 0) {
      throw new AppError('VALIDATION_FAILED', 400, 'The file has no header row.');
    }
    if (columns.some((c) => c === '')) {
      throw new AppError(
        'VALIDATION_FAILED',
        400,
        'Every column needs a header; one header is blank.',
      );
    }
    const keys = columns.map((c) => normalize.matchKey(c) || c.toLowerCase());
    if (new Set(keys).size !== keys.length) {
      throw new AppError('VALIDATION_FAILED', 400, 'Two columns have the same header.');
    }
    return columns;
  }

  private async readHead(
    tx: Transaction,
    organizationId: string,
    fileId: string,
    delimiter: CsvDelimiter,
  ) {
    const { stream } = await this.files.openStreamInTransaction(tx, organizationId, fileId);
    let columns: string[] | null = null;
    const sample: string[][] = [];
    try {
      for await (const record of readCsv(stream, this.csvOptions(delimiter))) {
        if (record.cells.length === 0) continue;
        if (!columns) {
          columns = this.validateHeader(record.cells);
          continue;
        }
        sample.push(record.cells);
        if (sample.length >= SAMPLE_ROWS) break;
      }
    } catch (error) {
      throw new AppError('VALIDATION_FAILED', 400, this.fileError(error));
    } finally {
      stream.destroy();
    }
    if (!columns) throw new AppError('VALIDATION_FAILED', 400, 'The file is empty.');
    return { columns, sample };
  }

  /**
   * Sets the mapping and options and starts validation of every row (L-1). Field keys map to
   * column indexes; required fields must be mapped and a column feeds one field only.
   */
  setMapping(
    principal: Principal,
    batchId: string,
    input: {
      version: number;
      mapping: Record<string, number | null>;
      options: Pick<ImportOptionsInput, 'dateFormat' | 'decimalSeparator'>;
    },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'change', {
        forUpdate: true,
      });
      this.assertVersion(batch, input.version);
      if (!['ready', 'validated', 'needs_review'].includes(batch.status) || !batch.columns) {
        throw new ConflictError('INVALID_STATE_TRANSITION', 'Inspect the file before mapping it.');
      }
      const fields = await domain.fields({ tx, ctx, services: this.services });
      const known = new Map(fields.map((f) => [f.key, f]));
      const issues: { path: string; message: string }[] = [];
      const usedColumns = new Map<number, string>();
      for (const [key, column] of Object.entries(input.mapping)) {
        if (!known.has(key)) {
          issues.push({ path: `mapping.${key}`, message: 'Unknown field.' });
          continue;
        }
        if (column === null) continue;
        if (column < 0 || column >= batch.columns.length) {
          issues.push({ path: `mapping.${key}`, message: 'Unknown column.' });
        } else if (usedColumns.has(column)) {
          issues.push({
            path: `mapping.${key}`,
            message: 'This column is already mapped to another field.',
          });
        } else usedColumns.set(column, key);
      }
      for (const f of fields) {
        if (f.required && (input.mapping[f.key] === undefined || input.mapping[f.key] === null)) {
          issues.push({
            path: `mapping.${f.key}`,
            message: `${f.label} must be mapped to a column.`,
          });
        }
      }
      if (issues.length) throw new ValidationError(issues);
      await this.assertCapacity(tx, ctx.organizationId);
      const mappingVersion = batch.mappingVersion + 1;
      const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
        mapping: input.mapping,
        options: { ...batch.options, ...definedOptions(input.options) },
        mappingVersion,
        status: 'validating',
      });
      return this.enqueueValidation(tx, ctx, updated, domain);
    });
  }

  private async enqueueValidation(
    tx: Transaction,
    ctx: AuthorizationContext,
    batch: ImportBatch,
    domain: ImportDomain,
  ) {
    const { job } = await this.jobs.enqueue(tx, {
      organizationId: ctx.organizationId,
      type: IMPORT_VALIDATE_JOB,
      jobKey: `${IMPORT_VALIDATE_JOB}:${batch.id}:${batch.mappingVersion}`,
      payload: { batchId: batch.id, userId: ctx.userId, mappingVersion: batch.mappingVersion },
      requiredPermission: domain.permission,
      createdByUserId: ctx.userId,
    });
    const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
      summary: { ...batch.summary, validateJobId: job.id, lastError: undefined },
    });
    return { batch: batchView(updated, domain), jobId: job.id };
  }

  /**
   * Excludes or re-includes rows (S6-13). A journal is excluded or included whole. Validation
   * re-runs because an exclusion can affect other rows (for example a parent account).
   */
  setExclusions(
    principal: Principal,
    batchId: string,
    input: { version: number; exclude: number[]; include: number[] },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'change', {
        forUpdate: true,
      });
      this.assertVersion(batch, input.version);
      if (!['validated', 'needs_review'].includes(batch.status)) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'Rows can be excluded once validation has finished.',
        );
      }
      const expand = async (numbers: number[]) => {
        if (!domain.groupsRows || numbers.length === 0) return numbers;
        const rows = await loadRows(tx, ctx.organizationId, batch.id);
        const keys = new Set(
          rows.filter((r) => numbers.includes(r.rowNumber)).map((r) => r.groupKey),
        );
        return rows
          .filter((r) => keys.has(r.groupKey) || numbers.includes(r.rowNumber))
          .map((r) => r.rowNumber);
      };
      await setRowsExcluded(tx, ctx.organizationId, batch.id, await expand(input.exclude), true);
      await setRowsExcluded(tx, ctx.organizationId, batch.id, await expand(input.include), false);
      await this.assertCapacity(tx, ctx.organizationId);
      const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
        mappingVersion: batch.mappingVersion + 1,
        status: 'validating',
      });
      return this.enqueueValidation(tx, ctx, updated, domain);
    });
  }

  rows(
    principal: Principal,
    batchId: string,
    query: { status?: ImportRowStatus | 'excluded' | undefined; after: number; limit: number },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch } = await this.loadBatch(tx, ctx, batchId, 'view');
      const rows = await listRows(tx, ctx.organizationId, batch.id, {
        statuses: query.status && query.status !== 'excluded' ? [query.status] : undefined,
        excluded: query.status === 'excluded' ? true : query.status ? false : undefined,
        after: query.after,
        limit: Math.min(query.limit, this.limits.previewRows),
      });
      const columns = batch.columns ?? [];
      return {
        columns,
        rows: rows.map((r: ImportRow) => ({
          rowNumber: r.rowNumber,
          status: r.status,
          excluded: r.excluded,
          groupKey: r.groupKey,
          cells: r.raw ? columns.map((_, i) => r.raw![i] ?? '') : null,
          messages: r.messages,
          recordId: r.recordId,
        })),
        nextAfter:
          rows.length === Math.min(query.limit, this.limits.previewRows)
            ? rows.at(-1)!.rowNumber
            : null,
      };
    });
  }

  /**
   * Starts the commit (S6-12..S6-14): no errors among included rows, warnings and a
   * same-content earlier import acknowledged, and the reviewed version.
   */
  commit(
    principal: Principal,
    batchId: string,
    input: { version: number; acknowledgeWarnings: boolean; acknowledgeDuplicateFile: boolean },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'change', {
        forUpdate: true,
      });
      this.assertVersion(batch, input.version);
      if (batch.status !== 'validated' || batch.validatedMappingVersion !== batch.mappingVersion) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'Only a validated import can be committed.',
        );
      }
      const notReady = (message: string) => new AppError('IMPORT_NOT_READY', 422, message);
      if (batch.errorCount > 0) throw notReady('Fix or exclude the rows with errors first.');
      if (batch.validCount + batch.warningCount === 0)
        throw notReady('There are no rows to import.');
      if (batch.warningCount > 0 && !input.acknowledgeWarnings) {
        throw notReady('Review and acknowledge the warnings first.');
      }
      if (batch.fileSha256) {
        const earlier = await findCommittedBatchWithFile(
          tx,
          ctx.organizationId,
          batch.domain,
          batch.fileSha256,
          batch.id,
        );
        if (earlier && !input.acknowledgeDuplicateFile) {
          throw notReady(
            'A file with the same content was already imported. Confirm to import it again.',
          );
        }
      }
      await this.assertCapacity(tx, ctx.organizationId);
      const { job } = await this.jobs.enqueue(tx, {
        organizationId: ctx.organizationId,
        type: IMPORT_COMMIT_JOB,
        jobKey: `${IMPORT_COMMIT_JOB}:${batch.id}`,
        payload: { batchId: batch.id, userId: ctx.userId },
        requiredPermission: domain.permission,
        createdByUserId: ctx.userId,
      });
      const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
        status: 'committing',
        summary: { ...batch.summary, commitJobId: job.id, lastError: undefined },
      });
      return { batch: batchView(updated, domain), jobId: job.id };
    });
  }

  cancel(principal: Principal, batchId: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'change', {
        forUpdate: true,
      });
      this.assertVersion(batch, input.version);
      if (!['awaiting_file', 'ready', 'validated', 'needs_review'].includes(batch.status)) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'This import can no longer be cancelled.',
        );
      }
      const updated = await this.finish(tx, ctx.organizationId, batch, 'cancelled', origin);
      await this.audit(tx, ctx, 'import.cancelled', batch, {}, origin);
      return batchView(updated, domain);
    });
  }

  /** Terminal transition: the source file is soft-deleted (S5 retention then applies). */
  private async finish(
    tx: Transaction,
    organizationId: string,
    batch: ImportBatch,
    status: 'cancelled' | 'expired' | 'failed_file' | 'committed',
    origin: EventOrigin,
    extra: Partial<ImportBatch> = {},
  ) {
    const updated = await updateBatch(tx, organizationId, batch.id, {
      ...extra,
      status,
      finishedAt: this.now,
    });
    if (batch.fileId)
      await this.files.systemDeleteInTransaction(tx, organizationId, batch.fileId, origin);
    return updated;
  }

  /**
   * L-9: discards the never-submitted drafts a journal import created. Each journal is kept as
   * DISCARDED (never deleted); journals already submitted or posted are left untouched.
   */
  discardDrafts(principal: Principal, batchId: string, origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const { batch, domain } = await this.loadBatch(tx, ctx, batchId, 'view', { forUpdate: true });
      if (batch.domain !== 'manual_journals' || batch.status !== 'committed') {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'Only a committed journal import has drafts to discard.',
        );
      }
      let discarded = 0;
      let kept = 0;
      for (const journal of await journalsCreatedByImport(tx, ctx.organizationId, batch.id)) {
        const done = await this.services.journals.discardImportedDraftInTransaction(
          tx,
          ctx,
          journal.id,
          origin,
          { quiet: true },
        );
        if (done) discarded += 1;
        else if (journal.status !== 'DISCARDED') kept += 1;
      }
      const summary = batch.summary as Record<string, unknown>;
      const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
        summary: {
          ...summary,
          discardedDrafts: ((summary.discardedDrafts as number | undefined) ?? 0) + discarded,
        },
      });
      await this.audit(tx, ctx, 'import.drafts_discarded', batch, { discarded, kept }, origin);
      return { batch: batchView(updated, domain), discarded, kept };
    });
  }

  // ---------------------------------------------------------------------------
  // Background work (S6-10; acting-user context, L-6)
  // ---------------------------------------------------------------------------

  /** import.validate: stage the file (first run), then validate every included row. */
  async runValidation(job: JobContext) {
    const payload = job.job.payload as { batchId: string; userId: string; mappingVersion: number };
    const outcome = await job.run(async (tx) => {
      const batch = await getBatch(tx, job.organizationId, payload.batchId, { forUpdate: true });
      if (
        !batch ||
        batch.status !== 'validating' ||
        batch.mappingVersion !== payload.mappingVersion
      ) {
        return { skipped: true };
      }
      const domain = this.domain(batch.domain);
      let ctx: AuthorizationContext;
      try {
        ctx = await resolveActingUserContext(tx, payload.userId, job.organizationId);
        requirePermission(ctx, domain.permission);
      } catch (error) {
        return this.validationProblem(tx, batch, error);
      }
      let current = batch;
      if ((batch.summary as Record<string, unknown>).staged !== true) {
        const staged = await this.stage(tx, ctx, batch);
        if ('failed' in staged) {
          await this.finish(tx, job.organizationId, batch, 'failed_file', importOrigin(batch.id), {
            summary: { ...batch.summary, lastError: staged.failed },
          });
          return { status: 'failed_file' };
        }
        current = staged.batch;
      }
      await job.progress(30, 'Validating rows');
      const rows = await loadRows(tx, job.organizationId, batch.id);
      let outcomes: RowOutcome[];
      try {
        outcomes = await this.validateRows(
          tx,
          ctx,
          current,
          domain,
          rows.filter((r) => !r.excluded),
        );
      } catch (error) {
        return this.validationProblem(tx, current, error);
      }
      await writeRowResults(
        tx,
        job.organizationId,
        batch.id,
        outcomes.map((o) => ({
          rowNumber: o.rowNumber,
          normalized: o.normalized,
          status: statusOf(o),
          messages: o.messages,
          groupKey: o.groupKey,
        })),
      );
      const counts = await rowCounts(tx, job.organizationId, batch.id);
      const duplicate = current.fileSha256
        ? await findCommittedBatchWithFile(
            tx,
            job.organizationId,
            batch.domain,
            current.fileSha256,
            batch.id,
          )
        : undefined;
      await updateBatch(tx, job.organizationId, batch.id, {
        status: 'validated',
        validatedMappingVersion: payload.mappingVersion,
        validCount: counts.valid,
        warningCount: counts.warning,
        errorCount: counts.error,
        excludedCount: counts.excluded,
        summary: { ...current.summary, duplicateOfBatchId: duplicate?.id, lastError: undefined },
      });
      return { status: 'validated', ...counts };
    });
    return outcome;
  }

  /** A batch-level problem (no permission any more, accounting not set up): back to ready. */
  private async validationProblem(tx: Transaction, batch: ImportBatch, error: unknown) {
    if (!(error instanceof AppError)) throw error;
    await updateBatch(tx, batch.organizationId, batch.id, {
      status: 'ready',
      summary: { ...batch.summary, lastError: error.message },
    });
    return { status: 'ready', error: error.message };
  }

  /** Parses the whole file into staged rows (S6-04), enforcing the file limits (S6-40). */
  private async stage(
    tx: Transaction,
    ctx: AuthorizationContext,
    batch: ImportBatch,
  ): Promise<{ batch: ImportBatch } | { failed: string }> {
    const delimiter: CsvDelimiter =
      batch.options.delimiter === 'auto'
        ? await this.detectFileDelimiter(tx, ctx.organizationId, batch.fileId!)
        : batch.options.delimiter;
    const { file, stream } = await this.files.openStreamInTransaction(
      tx,
      ctx.organizationId,
      batch.fileId!,
    );
    let columns: string[] | null = null;
    const rows: { rowNumber: number; raw: string[] }[] = [];
    try {
      for await (const record of readCsv(stream, this.csvOptions(delimiter))) {
        if (record.cells.length === 0) continue;
        if (!columns) {
          columns = this.validateHeader(record.cells);
          continue;
        }
        if (rows.length >= this.limits.maxRows) {
          return {
            failed: `The file has more than ${this.limits.maxRows.toLocaleString('en')} data rows.`,
          };
        }
        rows.push({ rowNumber: rows.length + 1, raw: record.cells });
      }
    } catch (error) {
      return { failed: this.fileError(error) };
    } finally {
      stream.destroy();
    }
    if (!columns) return { failed: 'The file is empty.' };
    if (rows.length === 0) return { failed: 'The file has a header but no data rows.' };
    await insertRows(tx, ctx.organizationId, batch.id, rows);
    const updated = await updateBatch(tx, ctx.organizationId, batch.id, {
      columns,
      rowCount: rows.length,
      options: { ...batch.options, delimiter },
      fileSha256: file.sha256,
      summary: { ...batch.summary, staged: true, fileName: file.originalName },
    });
    return { batch: updated };
  }

  /** Maps staged cells to fields and runs the domain's validation (never writes domain data). */
  private async validateRows(
    tx: Transaction,
    ctx: AuthorizationContext,
    batch: ImportBatch,
    domain: ImportDomain,
    rows: readonly ImportRow[],
  ): Promise<RowOutcome[]> {
    const mapping = batch.mapping ?? {};
    const tooLong: RowOutcome[] = [];
    const mapped: MappedRow[] = [];
    for (const row of rows) {
      const values: Record<string, string | null> = {};
      const messages: RowMessage[] = [];
      if (row.raw && batch.columns && row.raw.length !== batch.columns.length) {
        messages.push(
          normalize.rowError(
            'COLUMN_COUNT',
            null,
            `This row has ${row.raw.length} cells; the header has ${batch.columns.length}.`,
          ),
        );
      }
      for (const [key, column] of Object.entries(mapping)) {
        const cell = column === null ? null : (row.raw?.[column] ?? null);
        if (cell !== null && cell.length > IMPORT_LIMITS.maxCellChars) {
          messages.push(
            normalize.rowError(
              'TOO_LONG',
              key,
              `Cells are at most ${IMPORT_LIMITS.maxCellChars} characters.`,
            ),
          );
        }
        values[key] = cell;
      }
      if (messages.length)
        tooLong.push({ rowNumber: row.rowNumber, normalized: null, messages, groupKey: null });
      else mapped.push({ rowNumber: row.rowNumber, values });
    }
    const outcomes = await domain.validate(
      { tx, ctx, options: batch.options, services: this.services },
      mapped,
    );
    return [...outcomes, ...tooLong].sort((a, b) => a.rowNumber - b.rowNumber);
  }

  /**
   * import.commit (S6-11, S6-12): one transaction. Included rows are re-validated against
   * current data inside it; any error rolls everything back and the batch returns to review.
   */
  async runCommit(job: JobContext) {
    const payload = job.job.payload as { batchId: string; userId: string };
    try {
      return await job.run(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${String(this.limits.commitStatementTimeoutMs)}, true),
                     set_config('lock_timeout', ${String(this.limits.commitLockTimeoutMs)}, true)`,
        );
        const batch = await getBatch(tx, job.organizationId, payload.batchId, { forUpdate: true });
        if (!batch || batch.status !== 'committing') return { skipped: true };
        const domain = this.domain(batch.domain);
        const ctx = await resolveActingUserContext(tx, payload.userId, job.organizationId);
        requirePermission(ctx, domain.permission);
        const included = (await loadRows(tx, job.organizationId, batch.id)).filter(
          (r) => !r.excluded,
        );
        await job.progress(10, 'Checking rows again');
        const outcomes = await this.validateRows(tx, ctx, batch, domain, included);
        if (outcomes.some((o) => statusOf(o) === 'error'))
          throw new CommitValidationFailed(outcomes);
        await job.progress(40, 'Creating records');
        const origin = importOrigin(batch.id);
        const created = await domain.commit(
          { tx, ctx, options: batch.options, services: this.services },
          outcomes.map((o) => ({
            rowNumber: o.rowNumber,
            normalized: o.normalized!,
            groupKey: o.groupKey,
          })),
          { batchId: batch.id, origin },
        );
        await writeRecordIds(tx, job.organizationId, batch.id, created);
        const records = new Set(created.map((c) => c.recordId)).size;
        await this.finish(tx, job.organizationId, batch, 'committed', origin, {
          committedAt: this.now,
          committedByUserId: ctx.userId,
          summary: { ...batch.summary, created: records },
        });
        await this.audit(
          tx,
          ctx,
          'import.committed',
          batch,
          {
            rows: created.length,
            records,
            excluded: batch.excludedCount,
            fileSha256: batch.fileSha256,
          },
          origin,
        );
        return { status: 'committed', records };
      });
    } catch (error) {
      const message = this.commitFailure(error);
      if (message === null) throw error; // transient: the job runner retries (S5-14)
      await job.run(async (tx) => {
        const batch = await getBatch(tx, job.organizationId, payload.batchId, { forUpdate: true });
        if (!batch || batch.status !== 'committing') return;
        if (error instanceof CommitValidationFailed) {
          await writeRowResults(
            tx,
            job.organizationId,
            batch.id,
            error.outcomes.map((o) => ({
              rowNumber: o.rowNumber,
              normalized: o.normalized,
              status: statusOf(o),
              messages: o.messages,
              groupKey: o.groupKey,
            })),
          );
        }
        const counts = await rowCounts(tx, job.organizationId, batch.id);
        await updateBatch(tx, job.organizationId, batch.id, {
          status: 'needs_review',
          validCount: counts.valid,
          warningCount: counts.warning,
          errorCount: counts.error,
          excludedCount: counts.excluded,
          summary: { ...batch.summary, lastError: message },
        });
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: job.organizationId,
          actorUserId: payload.userId,
          action: 'import.needs_review',
          resourceType: 'import_batch',
          resourceId: batch.id,
          metadata: { domain: batch.domain, reason: message },
          origin: importOrigin(batch.id),
        });
      });
      return { status: 'needs_review' };
    }
  }

  /** A user-facing reason for a failed commit, or null for transient errors (retried). */
  private commitFailure(error: unknown): string | null {
    if (error instanceof CommitValidationFailed) {
      return 'Some rows are no longer valid (the data changed since validation). Review them and try again.';
    }
    if (error instanceof AppError) return error.message;
    const code =
      (error as { code?: string; cause?: { code?: string } }).code ??
      (error as { cause?: { code?: string } }).cause?.code;
    if (code === '23505' || code === '23503' || code === '23514') {
      return 'Records changed while the import was committing. Review it and try again.';
    }
    if (code === '57014')
      return 'The import took too long to commit. Try again, or split the file.';
    return null;
  }
}
