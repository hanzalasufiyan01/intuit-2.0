import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

/**
 * Open AP positions as of a date (Phase 4B-5; the Phase 3B AR model, ADR 0004 PD5). Everything
 * derives from posted documents, allocations and refunds — no second source of truth:
 *
 * - a bill's open balance is its total less the allocations dated on or before the date;
 * - a vendor credit's unapplied balance is its total less what was applied or refunded by then;
 * - a payment's prepayment is its amount less what was allocated or refunded by then.
 *
 * Voided documents drop out entirely: every Purchases void reverses its journal on the original
 * document date and adds negated allocation rows on the original allocation dates, so the GL and
 * these positions agree at every date. Bases are historical: what the AP control account carries.
 */

export interface OpenBill {
  id: string;
  number: string;
  vendorId: string;
  vendorReference: string | null;
  currencyCode: string;
  billDate: string;
  dueDate: string;
  total: string;
  baseTotal: string;
  openAmount: string;
  openBase: string;
}

export interface OpenVendorCredit {
  /** `vendor_credit` (supplier credit notes and debit notes) or `payment` (prepayments). */
  type: 'vendor_credit' | 'payment';
  id: string;
  number: string;
  /** The vendor-credit origin; null for prepayments. */
  origin: string | null;
  vendorId: string;
  currencyCode: string;
  date: string;
  openAmount: string;
  openBase: string;
}

interface Filter {
  organizationId: string;
  asOf: string;
  vendorId?: string | null;
}

export async function openBillsAsOf(tx: Transaction, input: Filter): Promise<OpenBill[]> {
  const result = await tx.execute<{
    id: string;
    number: string;
    vendor_id: string;
    vendor_reference: string | null;
    currency_code: string;
    bill_date: string;
    due_date: string;
    total: string;
    base_total: string;
    open_amount: string;
    open_base: string;
  }>(sql`
    SELECT b.id, b.number, b.vendor_id, b.vendor_reference, b.currency_code,
           b.bill_date::text AS bill_date, b.due_date::text AS due_date,
           b.total::text, b.base_total::text,
           (b.total - coalesce(sum(a.amount), 0))::text AS open_amount,
           (b.base_total - coalesce(sum(a.base_relieved), 0))::text AS open_base
      FROM purchases_bills b
      LEFT JOIN purchases_allocations a
        ON a.bill_id = b.id AND a.organization_id = b.organization_id
       AND a.allocation_date <= ${input.asOf}::date
     WHERE b.organization_id = ${input.organizationId}
       AND b.status = 'POSTED'
       AND b.bill_date <= ${input.asOf}::date
       ${input.vendorId ? sql`AND b.vendor_id = ${input.vendorId}` : sql``}
     GROUP BY b.id
    HAVING b.total - coalesce(sum(a.amount), 0) <> 0
        OR b.base_total - coalesce(sum(a.base_relieved), 0) <> 0
     ORDER BY b.due_date, b.number`);
  return result.rows.map((r) => ({
    id: r.id,
    number: r.number,
    vendorId: r.vendor_id,
    vendorReference: r.vendor_reference,
    currencyCode: r.currency_code,
    billDate: r.bill_date,
    dueDate: r.due_date,
    total: r.total,
    baseTotal: r.base_total,
    openAmount: r.open_amount,
    openBase: r.open_base,
  }));
}

/** Unapplied vendor credits (supplier credit notes and debit notes) as of a date. */
export async function openVendorCreditsAsOf(
  tx: Transaction,
  input: Filter,
): Promise<OpenVendorCredit[]> {
  const result = await tx.execute<CreditRow>(sql`
    SELECT 'vendor_credit' AS type, c.id, c.number, c.origin, c.vendor_id, c.currency_code,
           c.credit_date::text AS date,
           (c.total - coalesce(al.amount, 0) - coalesce(rf.amount, 0))::text AS open_amount,
           (c.base_total - coalesce(al.base, 0) - coalesce(rf.base, 0))::text AS open_base
      FROM purchases_vendor_credits c
      LEFT JOIN LATERAL (
        SELECT sum(a.amount) AS amount, sum(a.source_base) AS base
          FROM purchases_allocations a
         WHERE a.vendor_credit_id = c.id AND a.organization_id = c.organization_id
           AND a.allocation_date <= ${input.asOf}::date) al ON true
      LEFT JOIN LATERAL (
        SELECT sum(r.amount) AS amount, sum(r.base_released) AS base
          FROM purchases_refunds r
         WHERE r.vendor_credit_id = c.id AND r.organization_id = c.organization_id
           AND r.status = 'RECORDED' AND r.refund_date <= ${input.asOf}::date) rf ON true
     WHERE c.organization_id = ${input.organizationId}
       AND c.status = 'POSTED'
       AND c.credit_date <= ${input.asOf}::date
       ${input.vendorId ? sql`AND c.vendor_id = ${input.vendorId}` : sql``}
       AND (c.total - coalesce(al.amount, 0) - coalesce(rf.amount, 0) <> 0
         OR c.base_total - coalesce(al.base, 0) - coalesce(rf.base, 0) <> 0)
     ORDER BY c.credit_date, c.number`);
  return result.rows.map(creditView);
}

/** Unallocated prepayments (the vendor debit balance of recorded payments) as of a date. */
export async function openPrepaymentsAsOf(
  tx: Transaction,
  input: Filter,
): Promise<OpenVendorCredit[]> {
  const result = await tx.execute<CreditRow>(sql`
    SELECT 'payment' AS type, p.id, p.number, NULL AS origin, p.vendor_id, p.currency_code,
           p.payment_date::text AS date,
           (p.amount - coalesce(al.amount, 0) - coalesce(rf.amount, 0))::text AS open_amount,
           (p.base_amount - coalesce(al.base, 0) - coalesce(rf.base, 0))::text AS open_base
      FROM purchases_payments p
      LEFT JOIN LATERAL (
        SELECT sum(a.amount) AS amount, sum(a.source_base) AS base
          FROM purchases_allocations a
         WHERE a.payment_id = p.id AND a.organization_id = p.organization_id
           AND a.allocation_date <= ${input.asOf}::date) al ON true
      LEFT JOIN LATERAL (
        SELECT sum(r.amount) AS amount, sum(r.base_released) AS base
          FROM purchases_refunds r
         WHERE r.payment_id = p.id AND r.organization_id = p.organization_id
           AND r.status = 'RECORDED' AND r.refund_date <= ${input.asOf}::date) rf ON true
     WHERE p.organization_id = ${input.organizationId}
       AND p.status = 'RECORDED'
       AND p.payment_date <= ${input.asOf}::date
       ${input.vendorId ? sql`AND p.vendor_id = ${input.vendorId}` : sql``}
       AND (p.amount - coalesce(al.amount, 0) - coalesce(rf.amount, 0) <> 0
         OR p.base_amount - coalesce(al.base, 0) - coalesce(rf.base, 0) <> 0)
     ORDER BY p.payment_date, p.number`);
  return result.rows.map(creditView);
}

interface CreditRow {
  type: 'vendor_credit' | 'payment';
  id: string;
  number: string;
  origin: string | null;
  vendor_id: string;
  currency_code: string;
  date: string;
  open_amount: string;
  open_base: string;
  [key: string]: unknown;
}

function creditView(r: CreditRow): OpenVendorCredit {
  return {
    type: r.type,
    id: r.id,
    number: r.number,
    origin: r.origin,
    vendorId: r.vendor_id,
    currencyCode: r.currency_code,
    date: r.date,
    openAmount: r.open_amount,
    openBase: r.open_base,
  };
}

export interface VendorActivity {
  type: 'bill' | 'vendor_credit' | 'payment' | 'refund';
  id: string;
  number: string;
  /** The vendor-credit origin (`supplier_credit_note`, `debit_note`); null otherwise. */
  origin: string | null;
  date: string;
  currencyCode: string;
  /** Signed as "what we owe the vendor" (ADR 0004 PD4): bills and refunds positive. */
  amount: string;
  reference: string | null;
}

/**
 * A vendor's posted and recorded documents up to a date, oldest first (statement lines). Applications
 * move value between documents and are not lines; voided documents are omitted (PD4, PD5).
 */
export async function vendorActivity(
  tx: Transaction,
  input: { organizationId: string; vendorId: string; to: string },
): Promise<VendorActivity[]> {
  const result = await tx.execute<{
    type: VendorActivity['type'];
    id: string;
    number: string;
    origin: string | null;
    date: string;
    currency_code: string;
    amount: string;
    reference: string | null;
  }>(sql`
    SELECT 'bill' AS type, id, number, NULL AS origin, bill_date::text AS date, currency_code,
           total::text AS amount, vendor_reference AS reference
      FROM purchases_bills
     WHERE organization_id = ${input.organizationId} AND vendor_id = ${input.vendorId}
       AND status = 'POSTED' AND bill_date <= ${input.to}::date
    UNION ALL
    SELECT 'vendor_credit', id, number, origin, credit_date::text, currency_code, (-total)::text,
           vendor_reference
      FROM purchases_vendor_credits
     WHERE organization_id = ${input.organizationId} AND vendor_id = ${input.vendorId}
       AND status = 'POSTED' AND credit_date <= ${input.to}::date
    UNION ALL
    SELECT 'payment', id, number, NULL, payment_date::text, currency_code, (-amount)::text,
           reference
      FROM purchases_payments
     WHERE organization_id = ${input.organizationId} AND vendor_id = ${input.vendorId}
       AND status = 'RECORDED' AND payment_date <= ${input.to}::date
    UNION ALL
    SELECT 'refund', id, number, NULL, refund_date::text, currency_code, amount::text, reference
      FROM purchases_refunds
     WHERE organization_id = ${input.organizationId} AND vendor_id = ${input.vendorId}
       AND status = 'RECORDED' AND refund_date <= ${input.to}::date
     ORDER BY date, type, number`);
  return result.rows.map((r) => ({
    type: r.type,
    id: r.id,
    number: r.number,
    origin: r.origin,
    date: r.date,
    currencyCode: r.currency_code,
    amount: r.amount,
    reference: r.reference,
  }));
}

/**
 * The AP control account's GL balance (base, credit-positive: what the ledger says is owed) as of a
 * date, split into the S9 unrealized-FX revaluation adjustments posted to it (reversed the next
 * day) and postings from outside Purchases (there should be none: the account is a control account).
 */
export async function apControlBalance(
  tx: Transaction,
  input: { organizationId: string; accountId: string; asOf: string },
): Promise<{ total: string; revaluation: string; other: string }> {
  const result = await tx.execute<{ total: string; revaluation: string; other: string }>(sql`
    SELECT coalesce(sum(coalesce(l.base_credit, 0) - coalesce(l.base_debit, 0)), 0)::text AS total,
           coalesce(sum(coalesce(l.base_credit, 0) - coalesce(l.base_debit, 0))
             FILTER (WHERE j.source = 'system' AND j.source_type IN ('revaluation', 'revaluation_reversal')), 0)::text AS revaluation,
           coalesce(sum(coalesce(l.base_credit, 0) - coalesce(l.base_debit, 0))
             FILTER (WHERE coalesce(j.source_module, '') <> 'purchases'
                       AND NOT (j.source = 'system' AND j.source_type IN ('revaluation', 'revaluation_reversal'))
                       AND NOT (j.source = 'reversal' AND EXISTS (
                         SELECT 1 FROM accounting_journal_reversals rv
                           JOIN accounting_journal_entries o ON o.id = rv.original_journal_id
                                                            AND o.organization_id = rv.organization_id
                          WHERE rv.reversal_journal_id = j.id AND rv.organization_id = j.organization_id
                            AND o.source_module = 'purchases'))), 0)::text AS other
      FROM accounting_journal_lines l
      JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
     WHERE l.organization_id = ${input.organizationId}
       AND l.account_id = ${input.accountId}
       AND j.status IN ('POSTED', 'REVERSED')
       AND j.entry_date <= ${input.asOf}::date`);
  return result.rows[0]!;
}
