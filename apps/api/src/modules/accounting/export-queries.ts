import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { dimensionFilterSql } from './ledger.js';
import type { JournalStatus } from './schema.js';

/**
 * Keyset-paged reads for exports (S6-30). Unlike the interactive ledger (limit + 1, truncated),
 * these walk the whole result in stable order, page by page. They read; they never write.
 */

export interface JournalExportLine {
  journalId: string;
  journalNumber: number | null;
  status: JournalStatus;
  entryDate: string | null;
  description: string;
  reference: string;
  currency: string;
  exchangeRate: string | null;
  createdAt: string;
  lineNumber: number;
  accountCode: string | null;
  accountName: string | null;
  lineDescription: string;
  debit: string | null;
  credit: string | null;
  baseDebit: string | null;
  baseCredit: string | null;
  /** "TYPE=VALUE; …" by code, or null when dimensions are not included. */
  dimensions: string | null;
}

export interface JournalExportCursor {
  createdAt: string;
  id: string;
  lineNumber: number;
}

export async function journalLinesPage(
  tx: Transaction,
  organizationId: string,
  query: {
    statuses: readonly JournalStatus[];
    fromDate: string | null;
    toDate: string | null;
    includeDimensions: boolean;
    after: JournalExportCursor | null;
    limit: number;
  },
): Promise<JournalExportLine[]> {
  const statuses = sql`string_to_array(${query.statuses.join(',')}, ',')`;
  const dimensions = query.includeDimensions
    ? sql`(SELECT string_agg(t.code || '=' || v.code, '; ' ORDER BY t.code)
             FROM accounting_journal_line_dimensions d
             JOIN accounting_dimension_types t ON t.id = d.dimension_type_id AND t.organization_id = d.organization_id
             JOIN accounting_dimension_values v ON v.id = d.dimension_value_id AND v.organization_id = d.organization_id
            WHERE d.journal_line_id = l.id AND d.organization_id = l.organization_id)`
    : sql`NULL::text`;
  const after = query.after
    ? sql`AND (j.created_at, j.id, coalesce(l.line_number, 0)) >
              (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid, ${query.after.lineNumber})`
    : sql``;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT j.id AS journal_id, j.journal_number, j.status, j.entry_date::text AS entry_date,
           j.description, j.reference, j.currency, j.exchange_rate::text AS exchange_rate,
           to_char(j.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           coalesce(l.line_number, 0) AS line_number, a.code AS account_code, a.name AS account_name,
           coalesce(l.description, '') AS line_description, l.debit::text AS debit,
           l.credit::text AS credit, l.base_debit::text AS base_debit,
           l.base_credit::text AS base_credit, ${dimensions} AS dimensions
      FROM accounting_journal_entries j
      LEFT JOIN accounting_journal_lines l ON l.journal_id = j.id AND l.organization_id = j.organization_id
      LEFT JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
     WHERE j.organization_id = ${organizationId}
       AND j.status = ANY(${statuses})
       ${query.fromDate ? sql`AND j.entry_date >= ${query.fromDate}::date` : sql``}
       ${query.toDate ? sql`AND j.entry_date <= ${query.toDate}::date` : sql``}
       ${after}
     ORDER BY j.created_at, j.id, coalesce(l.line_number, 0)
     LIMIT ${query.limit}`);
  return rows.rows.map((r) => ({
    journalId: String(r.journal_id),
    journalNumber: r.journal_number === null ? null : Number(r.journal_number),
    status: r.status as JournalStatus,
    entryDate: (r.entry_date as string | null) ?? null,
    description: String(r.description),
    reference: String(r.reference),
    currency: String(r.currency),
    exchangeRate: (r.exchange_rate as string | null) ?? null,
    createdAt: String(r.created_at),
    lineNumber: Number(r.line_number),
    accountCode: (r.account_code as string | null) ?? null,
    accountName: (r.account_name as string | null) ?? null,
    lineDescription: String(r.line_description),
    debit: (r.debit as string | null) ?? null,
    credit: (r.credit as string | null) ?? null,
    baseDebit: (r.base_debit as string | null) ?? null,
    baseCredit: (r.base_credit as string | null) ?? null,
    dimensions: (r.dimensions as string | null) ?? null,
  }));
}

export interface LedgerExportLine {
  journalNumber: number;
  entryDate: string;
  journalDescription: string;
  lineNumber: number;
  accountCode: string;
  accountName: string;
  lineDescription: string;
  currency: string;
  debit: string | null;
  credit: string | null;
  exchangeRate: string;
  baseDebit: string | null;
  baseCredit: string | null;
}

export interface LedgerExportCursor {
  entryDate: string;
  journalNumber: number;
  lineNumber: number;
}

/** Posted (and later reversed) journal lines, the same set and order as the ledger. */
export async function ledgerLinesPage(
  tx: Transaction,
  organizationId: string,
  query: {
    accountIds: string[] | null;
    dimensionValueIds: string[];
    fromDate: string | null;
    toDate: string | null;
    after: LedgerExportCursor | null;
    limit: number;
  },
): Promise<LedgerExportLine[]> {
  const accountFilter = query.accountIds
    ? sql`AND l.account_id = ANY(string_to_array(${query.accountIds.join(',')}, ',')::uuid[])`
    : sql``;
  const after = query.after
    ? sql`AND (j.entry_date, j.journal_number, l.line_number) >
              (${query.after.entryDate}::date, ${query.after.journalNumber}, ${query.after.lineNumber})`
    : sql``;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT j.journal_number, j.entry_date::text AS entry_date, j.description AS journal_description,
           l.line_number, a.code AS account_code, a.name AS account_name,
           l.description AS line_description, j.currency, l.debit::text AS debit,
           l.credit::text AS credit, j.exchange_rate::text AS exchange_rate,
           l.base_debit::text AS base_debit, l.base_credit::text AS base_credit
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND j.status IN ('POSTED', 'REVERSED')
       ${accountFilter} ${dimensionFilterSql(query.dimensionValueIds)}
       ${query.fromDate ? sql`AND j.entry_date >= ${query.fromDate}::date` : sql``}
       ${query.toDate ? sql`AND j.entry_date <= ${query.toDate}::date` : sql``}
       ${after}
     ORDER BY j.entry_date, j.journal_number, l.line_number
     LIMIT ${query.limit}`);
  return rows.rows.map((r) => ({
    journalNumber: Number(r.journal_number),
    entryDate: String(r.entry_date),
    journalDescription: String(r.journal_description),
    lineNumber: Number(r.line_number),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    lineDescription: String(r.line_description),
    currency: String(r.currency),
    debit: (r.debit as string | null) ?? null,
    credit: (r.credit as string | null) ?? null,
    exchangeRate: String(r.exchange_rate),
    baseDebit: (r.base_debit as string | null) ?? null,
    baseCredit: (r.base_credit as string | null) ?? null,
  }));
}

/** Journals an import batch created (L-8 provenance), for the batch-level discard (L-9). */
export async function journalsCreatedByImport(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<{ id: string; status: JournalStatus; submittedAt: Date | null }[]> {
  const rows = await tx.execute<{
    id: string;
    status: JournalStatus;
    submitted_at: Date | null;
  }>(sql`
    SELECT id, status, submitted_at FROM accounting_journal_entries
     WHERE organization_id = ${organizationId} AND source_module = 'data_exchange'
       AND source_type = 'import_batch' AND source_id = ${batchId}::uuid
     ORDER BY created_at, id`);
  return rows.rows.map((r) => ({ id: r.id, status: r.status, submittedAt: r.submitted_at }));
}

/** Existing rate keys `${from}|${date}` against the base currency (import duplicate check). */
export async function exchangeRateKeys(
  tx: Transaction,
  organizationId: string,
  toCurrency: string,
): Promise<Set<string>> {
  const rows = await tx.execute<{ k: string }>(sql`
    SELECT from_currency || '|' || rate_date::text AS k FROM accounting_exchange_rates
     WHERE organization_id = ${organizationId} AND to_currency = ${toCurrency}`);
  return new Set(rows.rows.map((r) => r.k));
}

/**
 * Duplicate keys `${lower(reference)}|${date}|${debit total}` of existing, non-discarded journals
 * carrying one of the given references (import duplicate warning).
 */
export async function journalDuplicateKeys(
  tx: Transaction,
  organizationId: string,
  references: readonly string[],
): Promise<Set<string>> {
  if (references.length === 0) return new Set();
  const rows = await tx.execute<{ k: string }>(sql`
    SELECT lower(j.reference) || '|' || coalesce(j.entry_date::text, '') || '|' ||
           coalesce(sum(l.debit), 0)::numeric(28, 4)::text AS k
      FROM accounting_journal_entries j
      LEFT JOIN accounting_journal_lines l ON l.journal_id = j.id AND l.organization_id = j.organization_id
     WHERE j.organization_id = ${organizationId} AND j.status <> 'DISCARDED'
       AND lower(j.reference) IN (
         SELECT jsonb_array_elements_text(${JSON.stringify(references.map((r) => r.toLowerCase()))}::jsonb))
     GROUP BY j.id`);
  return new Set(rows.rows.map((r) => r.k));
}
