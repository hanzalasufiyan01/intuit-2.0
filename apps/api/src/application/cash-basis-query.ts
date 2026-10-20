import { sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import type { AccountSubtype, AccountType, ReportAccount } from '../modules/accounting/index.js';

/**
 * Cash-basis recognition for the profit and loss (FP-22). A policy-light, documented method (see
 * docs/design/cash-basis-reports.md); the accountant must confirm the policy before it is relied on.
 *
 * - Sales invoices, sales credit notes, purchase bills and vendor credits recognise their revenue
 *   and expense lines in proportion to what has been SETTLED, on the settlement dates:
 *   invoices and bills by the base amount relieved by receipts, payments and applied credits;
 *   credit notes and vendor credits by the base amount of the credit used. Reversals of
 *   settlements (voided receipts and payments) count negatively, so a voided payment un-recognises.
 * - The journals of those documents (and their void reversals) are NOT also counted as booked.
 * - Every other journal that touches a revenue or expense account (manual journals, direct
 *   expenses, expense claims, payroll, depreciation, inventory cost of sales, realised FX) is
 *   recognised as booked, on its own entry date. Whether any of those should be treated differently
 *   on a cash basis (depreciation, inventory) is an open accounting-policy decision.
 * - Tax lines, receivables, payables and bank accounts are balance sheet accounts and take no part.
 */

const ZERO_BALANCES = {
  netBeforeFiscalYear: '0',
  netFiscalYearBeforeFrom: '0',
  netBeforeFrom: '0',
  debitInRange: '0',
  creditInRange: '0',
  txnNetBeforeFrom: '0',
  txnNetFiscalYearBeforeFrom: '0',
  txnNetInRange: '0',
};

export interface CashBasisQuery {
  organizationId: string;
  from: string;
  to: string;
}

export async function queryCashBasisAccounts(
  tx: Transaction,
  query: CashBasisQuery,
): Promise<ReportAccount[]> {
  const org = query.organizationId;
  const result = await tx.execute<Record<string, string | boolean | null>>(sql`
    WITH settled AS (
      SELECT i.journal_id, sum(a.base_relieved) / i.base_total AS frac
        FROM sales_allocations a
        JOIN sales_invoices i ON i.id = a.invoice_id AND i.organization_id = a.organization_id
       WHERE a.organization_id = ${org} AND a.allocation_date BETWEEN ${query.from}::date AND ${query.to}::date
         AND i.journal_id IS NOT NULL AND i.base_total <> 0
       GROUP BY i.id
      UNION ALL
      SELECT c.journal_id, sum(a.source_base) / c.base_total
        FROM sales_allocations a
        JOIN sales_credit_notes c ON c.id = a.credit_note_id AND c.organization_id = a.organization_id
       WHERE a.organization_id = ${org} AND a.source_type = 'credit_note'
         AND a.allocation_date BETWEEN ${query.from}::date AND ${query.to}::date
         AND c.journal_id IS NOT NULL AND c.base_total <> 0
       GROUP BY c.id
      UNION ALL
      SELECT b.journal_id, sum(a.base_relieved) / b.base_total
        FROM purchases_allocations a
        JOIN purchases_bills b ON b.id = a.bill_id AND b.organization_id = a.organization_id
       WHERE a.organization_id = ${org} AND a.allocation_date BETWEEN ${query.from}::date AND ${query.to}::date
         AND b.journal_id IS NOT NULL AND b.base_total <> 0
       GROUP BY b.id
      UNION ALL
      SELECT v.journal_id, sum(a.source_base) / v.base_total
        FROM purchases_allocations a
        JOIN purchases_vendor_credits v ON v.id = a.vendor_credit_id AND v.organization_id = a.organization_id
       WHERE a.organization_id = ${org} AND a.source_type = 'vendor_credit'
         AND a.allocation_date BETWEEN ${query.from}::date AND ${query.to}::date
         AND v.journal_id IS NOT NULL AND v.base_total <> 0
       GROUP BY v.id
    ),
    document_lines AS (
      SELECT l.account_id,
             coalesce(l.base_debit, 0) * s.frac AS d,
             coalesce(l.base_credit, 0) * s.frac AS c,
             (coalesce(l.debit, 0) - coalesce(l.credit, 0)) * s.frac AS txn
        FROM settled s
        JOIN accounting_journal_lines l ON l.journal_id = s.journal_id AND l.organization_id = ${org}
    ),
    document_journals AS (
      SELECT journal_id AS id FROM sales_invoices WHERE organization_id = ${org} AND journal_id IS NOT NULL
      UNION SELECT void_journal_id FROM sales_invoices WHERE organization_id = ${org} AND void_journal_id IS NOT NULL
      UNION SELECT journal_id FROM sales_credit_notes WHERE organization_id = ${org} AND journal_id IS NOT NULL
      UNION SELECT journal_id FROM purchases_bills WHERE organization_id = ${org} AND journal_id IS NOT NULL
      UNION SELECT void_journal_id FROM purchases_bills WHERE organization_id = ${org} AND void_journal_id IS NOT NULL
      UNION SELECT journal_id FROM purchases_vendor_credits WHERE organization_id = ${org} AND journal_id IS NOT NULL
      UNION SELECT void_journal_id FROM purchases_vendor_credits WHERE organization_id = ${org} AND void_journal_id IS NOT NULL
    ),
    booked_lines AS (
      SELECT l.account_id, coalesce(l.base_debit, 0) AS d, coalesce(l.base_credit, 0) AS c,
             CASE WHEN l.line_kind = 'normal' THEN coalesce(l.debit, 0) - coalesce(l.credit, 0) ELSE 0 END AS txn
        FROM accounting_journal_lines l
        JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
       WHERE l.organization_id = ${org} AND j.status IN ('POSTED', 'REVERSED')
         AND j.entry_date BETWEEN ${query.from}::date AND ${query.to}::date
         AND j.id NOT IN (SELECT id FROM document_journals)
    ),
    movements AS (
      SELECT account_id, sum(d) AS d, sum(c) AS c, sum(txn) AS txn
        FROM (SELECT * FROM document_lines UNION ALL SELECT * FROM booked_lines) u
       GROUP BY account_id
    )
    SELECT a.id, a.code, a.name, a.account_type, a.subtype, a.parent_id, a.status, a.currency_code,
           NOT EXISTS (SELECT 1 FROM accounting_accounts c
                        WHERE c.parent_id = a.id AND c.organization_id = a.organization_id) AS is_leaf,
           m.d::text AS d, m.c::text AS c, m.txn::text AS txn
      FROM accounting_accounts a
      LEFT JOIN movements m ON m.account_id = a.id
     WHERE a.organization_id = ${org}
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
      r.d === null
        ? ZERO_BALANCES
        : {
            ...ZERO_BALANCES,
            debitInRange: String(r.d),
            creditInRange: String(r.c),
            txnNetInRange: String(r.txn),
          },
  }));
}
