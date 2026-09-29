import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  dataExports,
  importBatches,
  importMappings,
  importRows,
  type ExportDomainKey,
  type ExportStatus,
  type ImportDomainKey,
  type ImportOptions,
  type ImportRowStatus,
  type RowMessage,
} from './schema.js';

/** Persistence for import batches, staged rows, saved mappings and exports (S6-02). */

export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportRow = typeof importRows.$inferSelect;
export type ImportMapping = typeof importMappings.$inferSelect;
export type DataExport = typeof dataExports.$inferSelect;

const CHUNK = 1000;

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export async function insertBatch(
  tx: Transaction,
  input: {
    organizationId: string;
    domain: ImportDomainKey;
    options: ImportOptions;
    userId: string;
    expiresAt: Date;
  },
): Promise<ImportBatch> {
  const [row] = await tx
    .insert(importBatches)
    .values({
      organizationId: input.organizationId,
      domain: input.domain,
      options: input.options,
      createdByUserId: input.userId,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row!;
}

export async function getBatch(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  options: { forUpdate?: boolean } = {},
): Promise<ImportBatch | undefined> {
  const query = tx
    .select()
    .from(importBatches)
    .where(and(eq(importBatches.organizationId, organizationId), eq(importBatches.id, batchId)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** Applies changes and bumps the optimistic-concurrency version. */
export async function updateBatch(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  changes: Partial<Omit<ImportBatch, 'id' | 'organizationId' | 'version' | 'createdAt'>>,
): Promise<ImportBatch> {
  const [row] = await tx
    .update(importBatches)
    .set({ ...changes, version: sql`${importBatches.version} + 1`, updatedAt: sql`now()` })
    .where(and(eq(importBatches.organizationId, organizationId), eq(importBatches.id, batchId)))
    .returning();
  return row!;
}

export async function listBatches(
  tx: Transaction,
  organizationId: string,
  query: { limit: number; before?: Date | undefined; domain?: ImportDomainKey | undefined },
): Promise<ImportBatch[]> {
  return tx
    .select()
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, organizationId),
        query.domain ? eq(importBatches.domain, query.domain) : undefined,
        query.before ? lt(importBatches.createdAt, query.before) : undefined,
      ),
    )
    .orderBy(desc(importBatches.createdAt))
    .limit(query.limit);
}

/** Batches validating or committing right now (S6-35: limited per organization). */
export async function countActiveBatches(tx: Transaction, organizationId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, organizationId),
        inArray(importBatches.status, ['validating', 'committing']),
      ),
    );
  return row?.n ?? 0;
}

/** An earlier committed batch of the same domain from a file with the same content (S6-22). */
export async function findCommittedBatchWithFile(
  tx: Transaction,
  organizationId: string,
  domain: ImportDomainKey,
  sha256: string,
  exceptBatchId: string,
): Promise<ImportBatch | undefined> {
  const [row] = await tx
    .select()
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, organizationId),
        eq(importBatches.domain, domain),
        eq(importBatches.fileSha256, sha256),
        eq(importBatches.status, 'committed'),
        sql`${importBatches.id} <> ${exceptBatchId}`,
      ),
    )
    .orderBy(desc(importBatches.committedAt))
    .limit(1);
  return row;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export async function insertRows(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  rows: readonly { rowNumber: number; raw: string[] }[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(importRows).values(
      rows.slice(i, i + CHUNK).map((r) => ({
        batchId,
        organizationId,
        rowNumber: r.rowNumber,
        raw: r.raw,
      })),
    );
  }
}

export async function loadRows(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<ImportRow[]> {
  return tx
    .select()
    .from(importRows)
    .where(and(eq(importRows.organizationId, organizationId), eq(importRows.batchId, batchId)))
    .orderBy(asc(importRows.rowNumber));
}

export interface RowResultUpdate {
  rowNumber: number;
  normalized: Record<string, unknown> | null;
  status: ImportRowStatus;
  messages: RowMessage[];
  groupKey: string | null;
}

/** Writes validation results in chunks (one statement per chunk). */
export async function writeRowResults(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  results: readonly RowResultUpdate[],
): Promise<void> {
  for (let i = 0; i < results.length; i += CHUNK) {
    const chunk = results.slice(i, i + CHUNK).map((r) => ({
      row_number: r.rowNumber,
      normalized: r.normalized,
      status: r.status,
      messages: r.messages,
      group_key: r.groupKey,
    }));
    await tx.execute(sql`
      UPDATE import_rows AS r
         SET normalized = v.normalized, status = v.status, messages = v.messages,
             group_key = v.group_key
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
             AS v(row_number int, normalized jsonb, status text, messages jsonb, group_key text)
       WHERE r.organization_id = ${organizationId} AND r.batch_id = ${batchId}
         AND r.row_number = v.row_number`);
  }
}

export async function writeRecordIds(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  records: readonly { rowNumber: number; recordId: string }[],
): Promise<void> {
  for (let i = 0; i < records.length; i += CHUNK) {
    const chunk = records
      .slice(i, i + CHUNK)
      .map((r) => ({ row_number: r.rowNumber, record_id: r.recordId }));
    await tx.execute(sql`
      UPDATE import_rows AS r SET record_id = v.record_id
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(row_number int, record_id uuid)
       WHERE r.organization_id = ${organizationId} AND r.batch_id = ${batchId}
         AND r.row_number = v.row_number`);
  }
}

export async function setRowsExcluded(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  rowNumbers: readonly number[],
  excluded: boolean,
): Promise<void> {
  if (rowNumbers.length === 0) return;
  await tx
    .update(importRows)
    .set({ excluded })
    .where(
      and(
        eq(importRows.organizationId, organizationId),
        eq(importRows.batchId, batchId),
        inArray(importRows.rowNumber, [...rowNumbers]),
      ),
    );
}

export async function listRows(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  query: {
    statuses?: readonly ImportRowStatus[] | undefined;
    excluded?: boolean | undefined;
    after: number;
    limit: number;
  },
): Promise<ImportRow[]> {
  return tx
    .select()
    .from(importRows)
    .where(
      and(
        eq(importRows.organizationId, organizationId),
        eq(importRows.batchId, batchId),
        gt(importRows.rowNumber, query.after),
        query.statuses?.length ? inArray(importRows.status, [...query.statuses]) : undefined,
        query.excluded === undefined ? undefined : eq(importRows.excluded, query.excluded),
      ),
    )
    .orderBy(asc(importRows.rowNumber))
    .limit(query.limit);
}

export async function rowCounts(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<{ valid: number; warning: number; error: number; excluded: number; total: number }> {
  const [row] = await tx
    .select({
      valid: sql<number>`count(*) FILTER (WHERE status = 'valid' AND NOT excluded)::int`,
      warning: sql<number>`count(*) FILTER (WHERE status = 'warning' AND NOT excluded)::int`,
      error: sql<number>`count(*) FILTER (WHERE status = 'error' AND NOT excluded)::int`,
      excluded: sql<number>`count(*) FILTER (WHERE excluded)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(importRows)
    .where(and(eq(importRows.organizationId, organizationId), eq(importRows.batchId, batchId)));
  return row!;
}

/** L-11: removes source cells and typed values; codes and generic messages remain. */
export async function redactRows(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<void> {
  await tx
    .update(importRows)
    .set({ raw: null, normalized: null, groupKey: null })
    .where(and(eq(importRows.organizationId, organizationId), eq(importRows.batchId, batchId)));
}

// ---------------------------------------------------------------------------
// Saved mappings
// ---------------------------------------------------------------------------

export async function insertMapping(
  tx: Transaction,
  input: {
    organizationId: string;
    domain: ImportDomainKey;
    name: string;
    mapping: Record<string, string>;
    options: Partial<ImportOptions>;
    userId: string;
  },
): Promise<ImportMapping | undefined> {
  const [row] = await tx
    .insert(importMappings)
    .values({
      organizationId: input.organizationId,
      domain: input.domain,
      name: input.name,
      mapping: input.mapping,
      options: input.options,
      createdByUserId: input.userId,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function listMappings(
  tx: Transaction,
  organizationId: string,
  domain: ImportDomainKey | undefined,
): Promise<ImportMapping[]> {
  return tx
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.organizationId, organizationId),
        isNull(importMappings.deletedAt),
        domain ? eq(importMappings.domain, domain) : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${importMappings.name})`));
}

export async function getMapping(
  tx: Transaction,
  organizationId: string,
  mappingId: string,
): Promise<ImportMapping | undefined> {
  const [row] = await tx
    .select()
    .from(importMappings)
    .where(
      and(
        eq(importMappings.organizationId, organizationId),
        eq(importMappings.id, mappingId),
        isNull(importMappings.deletedAt),
      ),
    );
  return row;
}

export async function softDeleteMapping(
  tx: Transaction,
  organizationId: string,
  mappingId: string,
): Promise<void> {
  await tx
    .update(importMappings)
    .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(eq(importMappings.organizationId, organizationId), eq(importMappings.id, mappingId)),
    );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export async function insertExport(
  tx: Transaction,
  input: {
    organizationId: string;
    domain: ExportDomainKey;
    params: Record<string, unknown>;
    requiredPermission: string;
    userId: string;
    expiresAt: Date;
  },
): Promise<DataExport> {
  const [row] = await tx
    .insert(dataExports)
    .values({
      organizationId: input.organizationId,
      domain: input.domain,
      params: input.params,
      requiredPermission: input.requiredPermission,
      createdByUserId: input.userId,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row!;
}

export async function getExport(
  tx: Transaction,
  organizationId: string,
  exportId: string,
  options: { forUpdate?: boolean } = {},
): Promise<DataExport | undefined> {
  const query = tx
    .select()
    .from(dataExports)
    .where(and(eq(dataExports.organizationId, organizationId), eq(dataExports.id, exportId)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function updateExport(
  tx: Transaction,
  organizationId: string,
  exportId: string,
  changes: Partial<Pick<DataExport, 'status' | 'fileId' | 'rowCount' | 'error' | 'finishedAt'>> & {
    status?: ExportStatus;
  },
): Promise<DataExport | undefined> {
  const [row] = await tx
    .update(dataExports)
    .set(changes)
    .where(and(eq(dataExports.organizationId, organizationId), eq(dataExports.id, exportId)))
    .returning();
  return row;
}

export async function listExports(
  tx: Transaction,
  organizationId: string,
  query: { limit: number; before?: Date | undefined },
): Promise<DataExport[]> {
  return tx
    .select()
    .from(dataExports)
    .where(
      and(
        eq(dataExports.organizationId, organizationId),
        query.before ? lt(dataExports.createdAt, query.before) : undefined,
      ),
    )
    .orderBy(desc(dataExports.createdAt))
    .limit(query.limit);
}

// ---------------------------------------------------------------------------
// Housekeeping (S6-27, S6-36)
// ---------------------------------------------------------------------------

/** Organizations with cleanup due, through the narrow SECURITY DEFINER function. */
export async function organizationsWithDataExchangeWork(
  tx: Transaction,
  redactBefore: Date,
): Promise<string[]> {
  const result = await tx.execute<{ organization_id: string }>(
    sql`SELECT organization_id FROM app_organizations_with_data_exchange_work(${redactBefore.toISOString()}::timestamptz)`,
  );
  return result.rows.map((r) => r.organization_id);
}

export async function listBatchesForCleanup(
  tx: Transaction,
  organizationId: string,
  redactBefore: Date,
): Promise<{ expired: ImportBatch[]; toRedact: ImportBatch[]; stale: ImportBatch[] }> {
  const all = await tx
    .select()
    .from(importBatches)
    .where(
      and(
        eq(importBatches.organizationId, organizationId),
        sql`(
          (${importBatches.status} IN ('awaiting_file', 'ready', 'validated', 'needs_review')
            AND ${importBatches.expiresAt} <= now())
          OR (${importBatches.redactedAt} IS NULL AND ${importBatches.finishedAt} IS NOT NULL
            AND ${importBatches.finishedAt} <= ${redactBefore.toISOString()}::timestamptz)
          OR (${importBatches.status} IN ('validating', 'committing')
            AND ${importBatches.updatedAt} <= now() - interval '15 minutes'))`,
      ),
    )
    .for('update', { skipLocked: true });
  const open = ['awaiting_file', 'ready', 'validated', 'needs_review'];
  return {
    expired: all.filter((b) => open.includes(b.status) && b.finishedAt === null),
    toRedact: all.filter((b) => b.finishedAt !== null && b.redactedAt === null),
    stale: all.filter((b) => b.status === 'validating' || b.status === 'committing'),
  };
}

export async function listExportsForCleanup(
  tx: Transaction,
  organizationId: string,
): Promise<{ expired: DataExport[]; stale: DataExport[] }> {
  const all = await tx
    .select()
    .from(dataExports)
    .where(
      and(
        eq(dataExports.organizationId, organizationId),
        sql`((${dataExports.status} = 'ready' AND ${dataExports.expiresAt} <= now())
          OR (${dataExports.status} IN ('queued', 'running')
            AND ${dataExports.createdAt} <= now() - interval '15 minutes'))`,
      ),
    )
    .for('update', { skipLocked: true });
  return {
    expired: all.filter((e) => e.status === 'ready'),
    stale: all.filter((e) => e.status === 'queued' || e.status === 'running'),
  };
}
