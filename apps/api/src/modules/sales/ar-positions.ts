import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

/**
 * Open AR positions as of a date (Phase 3B step 16; Decision 45: derived from issued documents,
 * no second source of truth). An invoice's open balance is its total less the allocations dated on
 * or before the date; customer credit is a receipt's or credit note's amount less what was applied
 * by then. Voided documents drop out entirely, like their reversed journals (dated on the original
 * date). Bases are historical: what the AR control account carries for each document.
 */

export interface OpenInvoice {
  id: string;
  number: string;
  kind: string;
  customerId: string;
  currencyCode: string;
  invoiceDate: string;
  dueDate: string;
  total: string;
  baseTotal: string;
  openAmount: string;
  openBase: string;
}

export interface OpenCredit {
  type: 'receipt' | 'credit_note';
  id: string;
  number: string;
  customerId: string;
  currencyCode: string;
  date: string;
  openAmount: string;
  openBase: string;
}

export async function openInvoicesAsOf(
  tx: Transaction,
  input: { organizationId: string; asOf: string; customerId?: string | null },
): Promise<OpenInvoice[]> {
  const result = await tx.execute<{
    id: string;
    number: string;
    kind: string;
    customer_id: string;
    currency_code: string;
    invoice_date: string;
    due_date: string;
    total: string;
    base_total: string;
    open_amount: string;
    open_base: string;
  }>(sql`
    SELECT i.id, i.number, i.kind, i.customer_id, i.currency_code,
           i.invoice_date::text AS invoice_date, i.due_date::text AS due_date,
           i.total::text, i.base_total::text,
           (i.total - coalesce(sum(a.amount), 0))::text AS open_amount,
           (i.base_total - coalesce(sum(a.base_relieved), 0))::text AS open_base
      FROM sales_invoices i
      LEFT JOIN sales_allocations a
        ON a.invoice_id = i.id AND a.organization_id = i.organization_id
       AND a.allocation_date <= ${input.asOf}::date
     WHERE i.organization_id = ${input.organizationId}
       AND i.status = 'ISSUED'
       AND i.invoice_date <= ${input.asOf}::date
       ${input.customerId ? sql`AND i.customer_id = ${input.customerId}` : sql``}
     GROUP BY i.id
    HAVING i.total - coalesce(sum(a.amount), 0) <> 0
        OR i.base_total - coalesce(sum(a.base_relieved), 0) <> 0
     ORDER BY i.due_date, i.number`);
  return result.rows.map((r) => ({
    id: r.id,
    number: r.number,
    kind: r.kind,
    customerId: r.customer_id,
    currencyCode: r.currency_code,
    invoiceDate: r.invoice_date,
    dueDate: r.due_date,
    total: r.total,
    baseTotal: r.base_total,
    openAmount: r.open_amount,
    openBase: r.open_base,
  }));
}

export async function openCreditsAsOf(
  tx: Transaction,
  input: { organizationId: string; asOf: string; customerId?: string | null },
): Promise<OpenCredit[]> {
  const customer = input.customerId ? sql`AND customer_id = ${input.customerId}` : sql``;
  const result = await tx.execute<{
    type: 'receipt' | 'credit_note';
    id: string;
    number: string;
    customer_id: string;
    currency_code: string;
    date: string;
    open_amount: string;
    open_base: string;
  }>(sql`
    SELECT * FROM (
      SELECT 'receipt' AS type, r.id, r.number, r.customer_id, r.currency_code,
             r.receipt_date::text AS date,
             (r.amount - coalesce(sum(a.amount), 0))::text AS open_amount,
             (r.base_amount - coalesce(sum(a.source_base), 0))::text AS open_base
        FROM sales_receipts r
        LEFT JOIN sales_allocations a
          ON a.receipt_id = r.id AND a.organization_id = r.organization_id
         AND a.allocation_date <= ${input.asOf}::date
       WHERE r.organization_id = ${input.organizationId} AND r.status = 'RECORDED'
         AND r.receipt_date <= ${input.asOf}::date
       GROUP BY r.id
      UNION ALL
      SELECT 'credit_note' AS type, n.id, n.number, n.customer_id, n.currency_code,
             n.credit_date::text AS date,
             (n.total - coalesce(sum(a.amount), 0))::text AS open_amount,
             (n.base_total - coalesce(sum(a.source_base), 0))::text AS open_base
        FROM sales_credit_notes n
        LEFT JOIN sales_allocations a
          ON a.credit_note_id = n.id AND a.organization_id = n.organization_id
         AND a.allocation_date <= ${input.asOf}::date
       WHERE n.organization_id = ${input.organizationId} AND n.status = 'ISSUED'
         AND n.credit_date <= ${input.asOf}::date
       GROUP BY n.id
    ) credits
    WHERE (open_amount::numeric <> 0 OR open_base::numeric <> 0) ${customer}
    ORDER BY date, number`);
  return result.rows.map((r) => ({
    type: r.type,
    id: r.id,
    number: r.number,
    customerId: r.customer_id,
    currencyCode: r.currency_code,
    date: r.date,
    openAmount: r.open_amount,
    openBase: r.open_base,
  }));
}

/** Customer activity in a period, per document (statement lines), oldest first. */
export async function customerActivity(
  tx: Transaction,
  input: { organizationId: string; customerId: string; to: string },
) {
  const result = await tx.execute<{
    type: 'invoice' | 'credit_note' | 'receipt';
    id: string;
    number: string;
    date: string;
    currency_code: string;
    amount: string;
    reference: string | null;
  }>(sql`
    SELECT 'invoice' AS type, id, number, invoice_date::text AS date, currency_code,
           total::text AS amount, reference
      FROM sales_invoices
     WHERE organization_id = ${input.organizationId} AND customer_id = ${input.customerId}
       AND status = 'ISSUED' AND invoice_date <= ${input.to}::date
    UNION ALL
    SELECT 'credit_note', id, number, credit_date::text, currency_code, (-total)::text, reference
      FROM sales_credit_notes
     WHERE organization_id = ${input.organizationId} AND customer_id = ${input.customerId}
       AND status = 'ISSUED' AND credit_date <= ${input.to}::date
    UNION ALL
    SELECT 'receipt', id, number, receipt_date::text, currency_code, (-amount)::text, reference
      FROM sales_receipts
     WHERE organization_id = ${input.organizationId} AND customer_id = ${input.customerId}
       AND status = 'RECORDED' AND receipt_date <= ${input.to}::date
     ORDER BY date, type, number`);
  return result.rows.map((r) => ({
    type: r.type,
    id: r.id,
    number: r.number,
    date: r.date,
    currencyCode: r.currency_code,
    amount: r.amount,
    reference: r.reference,
  }));
}

/**
 * The AR control account's GL balance (base, debit-positive) as of a date, split into the Sales
 * postings and the unrealized-FX revaluation adjustments S9 posts to it (reversed the next day).
 */
export async function arControlBalance(
  tx: Transaction,
  input: { organizationId: string; accountId: string; asOf: string },
): Promise<{ total: string; revaluation: string; other: string }> {
  const result = await tx.execute<{ total: string; revaluation: string; other: string }>(sql`
    SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::text AS total,
           coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))
             FILTER (WHERE j.source = 'system' AND j.source_type IN ('revaluation', 'revaluation_reversal')), 0)::text AS revaluation,
           coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0))
             FILTER (WHERE coalesce(j.source_module, '') <> 'sales'
                       AND NOT (j.source = 'system' AND j.source_type IN ('revaluation', 'revaluation_reversal'))
                       AND NOT (j.source = 'reversal' AND EXISTS (
                         SELECT 1 FROM accounting_journal_reversals rv
                           JOIN accounting_journal_entries o ON o.id = rv.original_journal_id
                                                            AND o.organization_id = rv.organization_id
                          WHERE rv.reversal_journal_id = j.id AND rv.organization_id = j.organization_id
                            AND o.source_module = 'sales'))), 0)::text AS other
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = ${input.organizationId}
       AND l.account_id = ${input.accountId}
       AND j.status IN ('POSTED', 'REVERSED')
       AND j.entry_date <= ${input.asOf}::date`);
  return result.rows[0]!;
}
