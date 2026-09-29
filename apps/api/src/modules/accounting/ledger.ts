import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

/**
 * The General Ledger is a query over journal lines of POSTED journals (including journals
 * later REVERSED: they were posted, and their reversal journals carry the offsetting lines).
 * It is not a second store of accounting data. All sums are PostgreSQL numeric (exact).
 */
export interface LedgerRow {
  journalId: string;
  journalNumber: number;
  entryDate: string;
  journalDescription: string;
  lineNumber: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  lineDescription: string;
  currency: string;
  debit: string | null;
  credit: string | null;
  exchangeRate: string;
  baseDebit: string | null;
  baseCredit: string | null;
  runningBalance: string | null;
}

/**
 * Reusable reporting filter (Decision 16): keeps journal lines (alias `l`) tagged with every
 * given dimension value. Results filtered this way show tagged activity only.
 */
export function dimensionFilterSql(valueIds: readonly string[] | null) {
  if (!valueIds?.length) return sql``;
  return sql.join(
    valueIds.map(
      (id) => sql`AND EXISTS (SELECT 1 FROM accounting_journal_line_dimensions ld
        WHERE ld.journal_line_id = l.id AND ld.organization_id = l.organization_id
          AND ld.dimension_value_id = ${id}::uuid)`,
    ),
    sql` `,
  );
}

export interface LedgerQuery {
  organizationId: string;
  accountIds: string[] | null;
  /** Lines must carry every value (values of different dimension types). */
  dimensionValueIds?: string[] | null;
  /** Opening balance counts only lines dated on or after this date (fiscal-year basis). */
  openingFrom?: string | null;
  fromDate: string | null;
  toDate: string | null;
  limit: number;
}

const POSTED = sql`j.status IN ('POSTED', 'REVERSED')`;

export async function queryLedger(
  tx: Transaction,
  query: LedgerQuery,
): Promise<{
  openingBalance: string | null;
  totals: { baseDebit: string; baseCredit: string };
  rows: LedgerRow[];
  truncated: boolean;
}> {
  // One parameter holding the id list (a raw JS array would be expanded into separate params).
  const accountFilter = query.accountIds
    ? sql`AND l.account_id = ANY(string_to_array(${query.accountIds.join(',')}, ',')::uuid[])`
    : sql``;
  const fromFilter = query.fromDate ? sql`AND j.entry_date >= ${query.fromDate}::date` : sql``;
  const toFilter = query.toDate ? sql`AND j.entry_date <= ${query.toDate}::date` : sql``;
  const dimensionFilter = dimensionFilterSql(query.dimensionValueIds ?? null);

  // Opening balance (debit minus credit, base currency) only makes sense for an account view.
  let opening: string | null = null;
  if (query.accountIds) {
    const result = await tx.execute<{ balance: string }>(sql`
      SELECT (coalesce(sum(l.base_debit), 0) - coalesce(sum(l.base_credit), 0))::text AS balance
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = ${query.organizationId} AND ${POSTED} ${accountFilter} ${dimensionFilter}
        ${query.fromDate ? sql`AND j.entry_date < ${query.fromDate}::date` : sql`AND false`}
        ${query.openingFrom ? sql`AND j.entry_date >= ${query.openingFrom}::date` : sql``}`);
    opening = result.rows[0]?.balance ?? '0';
  }

  const totals = await tx.execute<{ base_debit: string; base_credit: string }>(sql`
    SELECT coalesce(sum(l.base_debit), 0)::text AS base_debit, coalesce(sum(l.base_credit), 0)::text AS base_credit
    FROM accounting_journal_lines l
    JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
    WHERE l.organization_id = ${query.organizationId} AND ${POSTED} ${accountFilter} ${dimensionFilter} ${fromFilter} ${toFilter}`);

  const running = query.accountIds
    ? sql`(${opening ?? '0'}::numeric + sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))
          OVER (ORDER BY j.entry_date, j.journal_number, l.line_number))::text`
    : sql`NULL::text`;
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT j.id AS journal_id, j.journal_number, j.entry_date::text AS entry_date,
           j.description AS journal_description, l.line_number, l.account_id,
           a.code AS account_code, a.name AS account_name, l.description AS line_description,
           j.currency, l.debit::text AS debit, l.credit::text AS credit,
           j.exchange_rate::text AS exchange_rate, l.base_debit::text AS base_debit,
           l.base_credit::text AS base_credit, ${running} AS running_balance
    FROM accounting_journal_lines l
    JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
    JOIN accounting_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
    WHERE l.organization_id = ${query.organizationId} AND ${POSTED} ${accountFilter} ${dimensionFilter} ${fromFilter} ${toFilter}
    ORDER BY j.entry_date, j.journal_number, l.line_number
    LIMIT ${query.limit + 1}`);

  const mapped = rows.rows.slice(0, query.limit).map((r) => ({
    journalId: String(r.journal_id),
    journalNumber: Number(r.journal_number),
    entryDate: String(r.entry_date),
    journalDescription: String(r.journal_description),
    lineNumber: Number(r.line_number),
    accountId: String(r.account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    lineDescription: String(r.line_description),
    currency: String(r.currency),
    debit: (r.debit as string | null) ?? null,
    credit: (r.credit as string | null) ?? null,
    exchangeRate: String(r.exchange_rate),
    baseDebit: (r.base_debit as string | null) ?? null,
    baseCredit: (r.base_credit as string | null) ?? null,
    runningBalance: (r.running_balance as string | null) ?? null,
  }));
  return {
    openingBalance: opening,
    totals: { baseDebit: totals.rows[0]!.base_debit, baseCredit: totals.rows[0]!.base_credit },
    rows: mapped,
    truncated: rows.rows.length > query.limit,
  };
}
