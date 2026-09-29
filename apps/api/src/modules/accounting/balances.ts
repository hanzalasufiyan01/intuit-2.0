import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { dimensionFilterSql } from './ledger.js';
import type { AccountSubtype, AccountType } from './schema.js';

/**
 * Ledger aggregation for financial reporting (S3-04, S3-05). The accounting module owns this
 * SQL; the reports module composes statements from its results without touching tables.
 *
 * Source data: journals in status POSTED or REVERSED (a reversal is its own offsetting journal),
 * using the stored base amounts. Nothing is converted or rounded here (S3-22): every figure is an
 * exact PostgreSQL numeric sum of stored amounts.
 */

export interface AccountBalanceQuery {
  organizationId: string;
  /** Start of the reporting fiscal year (virtual year-end boundary). */
  fiscalYearStart: string;
  /** Start of the reporting range (inclusive). */
  from: string;
  /** End of the reporting range (inclusive). */
  to: string;
  /** Lines must carry every value (tagged activity only). */
  dimensionValueIds: readonly string[] | null;
}

/** Decimal strings (net = debit - credit, debit-positive). */
export interface AccountBalances {
  /** Base net dated before the fiscal-year start. */
  netBeforeFiscalYear: string;
  /** Base net from the fiscal-year start to the day before `from`. */
  netFiscalYearBeforeFrom: string;
  /** Base net dated before `from` (all history). */
  netBeforeFrom: string;
  /** Base gross debits and credits within [from, to]. */
  debitInRange: string;
  creditInRange: string;
  /**
   * Transaction-currency nets of NORMAL lines only (Decision 71: base-only lines never change
   * the account-currency balance). Meaningful for foreign-currency accounts, whose normal lines
   * are always in the account currency (Decision 11).
   */
  txnNetBeforeFrom: string;
  txnNetFiscalYearBeforeFrom: string;
  txnNetInRange: string;
}

export interface ReportAccount {
  id: string;
  code: string;
  name: string;
  accountType: AccountType;
  subtype: AccountSubtype | null;
  parentId: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  currencyCode: string;
  isLeaf: boolean;
  balances: AccountBalances;
}

const ZERO: AccountBalances = {
  netBeforeFiscalYear: '0',
  netFiscalYearBeforeFrom: '0',
  netBeforeFrom: '0',
  debitInRange: '0',
  creditInRange: '0',
  txnNetBeforeFrom: '0',
  txnNetFiscalYearBeforeFrom: '0',
  txnNetInRange: '0',
};

/**
 * Every account of the organization with its aggregated balances, in ONE statement so the
 * chart and the figures come from the same snapshot. Accounts without activity get zeros.
 */
export async function queryAccountBalances(
  tx: Transaction,
  query: AccountBalanceQuery,
): Promise<ReportAccount[]> {
  const net = sql`coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)`;
  const txnNet = sql`coalesce(l.debit, 0) - coalesce(l.credit, 0)`;
  const fy = sql`${query.fiscalYearStart}::date`;
  const from = sql`${query.from}::date`;
  const result = await tx.execute<Record<string, string | boolean | null>>(sql`
    WITH balances AS (
      SELECT l.account_id,
        coalesce(sum(${net}) FILTER (WHERE j.entry_date < ${fy}), 0)::text AS net_before_fy,
        coalesce(sum(${net}) FILTER (WHERE j.entry_date >= ${fy} AND j.entry_date < ${from}), 0)::text AS net_fy_before_from,
        coalesce(sum(${net}) FILTER (WHERE j.entry_date < ${from}), 0)::text AS net_before_from,
        coalesce(sum(l.base_debit) FILTER (WHERE j.entry_date >= ${from}), 0)::text AS debit_in_range,
        coalesce(sum(l.base_credit) FILTER (WHERE j.entry_date >= ${from}), 0)::text AS credit_in_range,
        coalesce(sum(${txnNet}) FILTER (WHERE l.line_kind = 'normal' AND j.entry_date < ${from}), 0)::text AS txn_net_before_from,
        coalesce(sum(${txnNet}) FILTER (WHERE l.line_kind = 'normal' AND j.entry_date >= ${fy} AND j.entry_date < ${from}), 0)::text AS txn_net_fy_before_from,
        coalesce(sum(${txnNet}) FILTER (WHERE l.line_kind = 'normal' AND j.entry_date >= ${from}), 0)::text AS txn_net_in_range
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = ${query.organizationId}
        AND j.status IN ('POSTED', 'REVERSED')
        AND j.entry_date <= ${query.to}::date
        ${dimensionFilterSql(query.dimensionValueIds)}
      GROUP BY l.account_id
    )
    SELECT a.id, a.code, a.name, a.account_type, a.subtype, a.parent_id, a.status, a.currency_code,
           NOT EXISTS (SELECT 1 FROM accounting_accounts c
                        WHERE c.parent_id = a.id AND c.organization_id = a.organization_id) AS is_leaf,
           b.net_before_fy, b.net_fy_before_from, b.net_before_from, b.debit_in_range,
           b.credit_in_range, b.txn_net_before_from, b.txn_net_fy_before_from, b.txn_net_in_range
      FROM accounting_accounts a
      LEFT JOIN balances b ON b.account_id = a.id
     WHERE a.organization_id = ${query.organizationId}
     ORDER BY a.code`);
  return result.rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    name: String(r.name),
    accountType: r.account_type as AccountType,
    subtype: (r.subtype as AccountSubtype | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    status: r.status as 'ACTIVE' | 'ARCHIVED',
    currencyCode: String(r.currency_code),
    isLeaf: r.is_leaf === true,
    balances:
      r.net_before_fy === null
        ? ZERO
        : {
            netBeforeFiscalYear: String(r.net_before_fy),
            netFiscalYearBeforeFrom: String(r.net_fy_before_from),
            netBeforeFrom: String(r.net_before_from),
            debitInRange: String(r.debit_in_range),
            creditInRange: String(r.credit_in_range),
            txnNetBeforeFrom: String(r.txn_net_before_from),
            txnNetFiscalYearBeforeFrom: String(r.txn_net_fy_before_from),
            txnNetInRange: String(r.txn_net_in_range),
          },
  }));
}
