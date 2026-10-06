import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { decimal } from '../../domain/money.js';
import { attributePurchaseDocument } from '../documents/index.js';

/**
 * Purchase-analysis lines for the 4B-6 reports (ADR 0004 P4-49; PD2, PD4, PD5, PD10, PD12):
 * POSTED standard bills and POSTED vendor credits (supplier credit notes and debit notes) dated in
 * a period, one row per document line. Base values come from the document's canonical purchase
 * journal, rebuilt from its stored snapshots and rate, with the Canonical Group Base Attribution
 * for per-line presentation (reporting only). Vendor credits are signed negative. Voided
 * documents drop out (their journals are reversed on the same date). Opening bills are excluded.
 */

export interface PurchaseLine {
  documentType: 'bill' | 'vendor_credit';
  documentId: string;
  number: string;
  origin: string | null;
  vendorId: string;
  date: string;
  currencyCode: string;
  lineNo: number;
  itemId: string | null;
  accountId: string | null;
  taxCodeId: string | null;
  /** The snapshotted rate (Decision 15). */
  taxRate: string | null;
  quantity: string;
  /** Signed document-currency amounts. */
  netAmount: string;
  recoverableTax: string;
  nonRecoverableTax: string;
  /** Signed base amounts (canonical group bases, attributed). */
  netBase: string;
  recoverableTaxBase: string;
  nonRecoverableTaxBase: string;
  costBase: string;
}

export interface PurchaseDocumentTotal {
  documentType: 'bill' | 'vendor_credit';
  documentId: string;
  vendorId: string;
  /** Signed: the canonical journal's base total (the AP line). */
  baseTotal: string;
}

interface DocRow {
  document_type: 'bill' | 'vendor_credit';
  id: string;
  number: string;
  origin: string | null;
  vendor_id: string;
  date: string;
  currency_code: string;
  exchange_rate: string;
  dimension_value_ids: string[];
  [key: string]: unknown;
}

interface LineRow {
  document_id: string;
  line_no: number;
  item_id: string | null;
  account_id: string | null;
  dimension_value_ids: string[];
  tax_code_id: string | null;
  tax_rate: string | null;
  quantity: string;
  net_amount: string;
  recoverable_tax: string;
  non_recoverable_tax: string;
  input_tax_account_id: string | null;
  [key: string]: unknown;
}

export async function purchaseLines(
  tx: Transaction,
  input: {
    organizationId: string;
    from: string;
    to: string;
    baseCurrency: string;
    vendorId?: string | null;
  },
): Promise<{ lines: PurchaseLine[]; documents: PurchaseDocumentTotal[] }> {
  const vendor = (column: string) =>
    input.vendorId ? sql`AND ${sql.raw(column)} = ${input.vendorId}` : sql``;
  const docs = await tx.execute<DocRow>(sql`
    SELECT 'bill' AS document_type, b.id, b.number, NULL AS origin, b.vendor_id,
           b.bill_date::text AS date, b.currency_code, b.exchange_rate::text, b.dimension_value_ids
      FROM purchases_bills b
     WHERE b.organization_id = ${input.organizationId} AND b.status = 'POSTED' AND b.kind = 'standard'
       AND b.bill_date BETWEEN ${input.from}::date AND ${input.to}::date ${vendor('b.vendor_id')}
    UNION ALL
    SELECT 'vendor_credit', c.id, c.number, c.origin, c.vendor_id,
           c.credit_date::text, c.currency_code, c.exchange_rate::text, c.dimension_value_ids
      FROM purchases_vendor_credits c
     WHERE c.organization_id = ${input.organizationId} AND c.status = 'POSTED'
       AND c.credit_date BETWEEN ${input.from}::date AND ${input.to}::date ${vendor('c.vendor_id')}
     ORDER BY date, number`);
  if (docs.rows.length === 0) return { lines: [], documents: [] };
  // One parameter: the document ids as a uuid array literal.
  const ids = `{${docs.rows.map((d) => d.id).join(',')}}`;
  const lines = await tx.execute<LineRow>(sql`
    SELECT bill_id AS document_id, line_no, item_id, account_id, dimension_value_ids, tax_code_id,
           tax_rate::text, quantity::text, net_amount::text, recoverable_tax::text,
           non_recoverable_tax::text, input_tax_account_id
      FROM purchases_bill_lines
     WHERE organization_id = ${input.organizationId}
       AND bill_id = ANY(${ids}::uuid[])
    UNION ALL
    SELECT vendor_credit_id, line_no, item_id, account_id, dimension_value_ids, tax_code_id,
           tax_rate::text, quantity::text, net_amount::text, recoverable_tax::text,
           non_recoverable_tax::text, input_tax_account_id
      FROM purchases_vendor_credit_lines
     WHERE organization_id = ${input.organizationId}
       AND vendor_credit_id = ANY(${ids}::uuid[])`);
  const byDocument = new Map<string, LineRow[]>();
  for (const l of lines.rows) {
    byDocument.set(l.document_id, [...(byDocument.get(l.document_id) ?? []), l]);
  }
  const dimensionIds = [
    ...docs.rows.flatMap((d) => d.dimension_value_ids ?? []),
    ...lines.rows.flatMap((l) => l.dimension_value_ids ?? []),
  ];
  // Dimension value → type, read-only (the D10 merge in the canonical builder needs it).
  const types = dimensionIds.length
    ? await tx.execute<{ id: string; dimension_type_id: string }>(sql`
        SELECT id, dimension_type_id FROM accounting_dimension_values
         WHERE organization_id = ${input.organizationId}
           AND id = ANY(${`{${[...new Set(dimensionIds)].join(',')}}`}::uuid[])`)
    : { rows: [] };
  const typeOf = new Map(types.rows.map((r) => [r.id, r.dimension_type_id]));

  const out: PurchaseLine[] = [];
  const documents: PurchaseDocumentTotal[] = [];
  for (const d of docs.rows) {
    const docLines = byDocument.get(d.id) ?? [];
    const attributed = attributePurchaseDocument({
      direction: d.document_type,
      currency: d.currency_code,
      baseCurrency: input.baseCurrency,
      rate: decimal(d.exchange_rate ?? '1'),
      documentDimensionValueIds: d.dimension_value_ids ?? [],
      typeOf,
      lines: docLines.map((l) => ({
        lineNo: l.line_no,
        accountId: l.account_id,
        dimensionValueIds: l.dimension_value_ids ?? [],
        netAmount: decimal(l.net_amount),
        nonRecoverableTax: decimal(l.non_recoverable_tax),
        recoverableTax: decimal(l.recoverable_tax),
        taxCodeId: l.tax_code_id,
        inputTaxAccountId: l.input_tax_account_id,
      })),
    });
    const sign = d.document_type === 'bill' ? 1 : -1;
    const signed = (v: string | { times: (n: number) => { toFixed: () => string } }) =>
      typeof v === 'string' ? decimal(v).times(sign).toFixed() : v.times(sign).toFixed();
    documents.push({
      documentType: d.document_type,
      documentId: d.id,
      vendorId: d.vendor_id,
      baseTotal: signed(attributed.groups.baseTotal),
    });
    const shares = new Map(attributed.lines.map((a) => [a.lineNo, a]));
    for (const l of docLines) {
      const a = shares.get(l.line_no)!;
      out.push({
        documentType: d.document_type,
        documentId: d.id,
        number: d.number,
        origin: d.origin,
        vendorId: d.vendor_id,
        date: d.date,
        currencyCode: d.currency_code,
        lineNo: l.line_no,
        itemId: l.item_id,
        accountId: l.account_id,
        taxCodeId: l.tax_code_id,
        taxRate: l.tax_rate,
        quantity: signed(l.quantity),
        netAmount: signed(l.net_amount),
        recoverableTax: signed(l.recoverable_tax),
        nonRecoverableTax: signed(l.non_recoverable_tax),
        netBase: signed(a.netBase),
        recoverableTaxBase: signed(a.recoverableTaxBase),
        nonRecoverableTaxBase: signed(a.nonRecoverableTaxBase),
        costBase: signed(a.costBase),
      });
    }
  }
  return { lines: out, documents };
}

// ---------------------------------------------------------------------------
// Payment register (PD6–PD8, PD11)
// ---------------------------------------------------------------------------

/**
 * PD8: the register returns at most 2,000 rows — payments and refunds combined. The rows are
 * taken in one deterministic order (`compareRegisterRows`): date, then payments before refunds
 * on the same date, then document number, then id. Each query fetches at most limit + 1 rows in
 * that order, so the merged first rows are exact; `truncated` says more rows match.
 */
export const PAYMENT_REGISTER_LIMIT = 2000;

export interface RegisterRowKey {
  date: string;
  kind: 'payment' | 'refund';
  number: string;
  id: string;
}

const KIND_ORDER = { payment: 0, refund: 1 } as const;

export function compareRegisterRows(a: RegisterRowKey, b: RegisterRowKey): number {
  return (
    a.date.localeCompare(b.date) ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (a.number < b.number ? -1 : a.number > b.number ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Applies the combined cap: merges payment and refund rows in register order, keeps the first
 * `limit`, and splits them back into the two sections (each still in register order).
 */
export function limitRegister<
  P extends { id: string; number: string; paymentDate: string },
  R extends { id: string; number: string; refundDate: string },
>(
  payments: readonly P[],
  refunds: readonly R[],
  limit: number,
): { payments: P[]; refunds: R[]; truncated: boolean } {
  const rows = [
    ...payments.map((row) => ({
      key: { date: row.paymentDate, kind: 'payment' as const, number: row.number, id: row.id },
      payment: row,
    })),
    ...refunds.map((row) => ({
      key: { date: row.refundDate, kind: 'refund' as const, number: row.number, id: row.id },
      refund: row,
    })),
  ].sort((a, b) => compareRegisterRows(a.key, b.key));
  const kept = rows.slice(0, limit);
  return {
    payments: kept.flatMap((r) => ('payment' in r && r.payment ? [r.payment] : [])),
    refunds: kept.flatMap((r) => ('refund' in r && r.refund ? [r.refund] : [])),
    truncated: rows.length > limit,
  };
}

export interface RegisterFilter {
  organizationId: string;
  from: string;
  to: string;
  vendorId?: string | null;
  paymentAccountId?: string | null;
  currencyCode?: string | null;
}

export interface RegisterPayment {
  id: string;
  number: string;
  status: 'RECORDED' | 'VOID';
  paymentDate: string;
  vendorId: string;
  paymentAccountId: string;
  paymentBatchId: string | null;
  currencyCode: string;
  amount: string;
  exchangeRate: string;
  exchangeRateSource: string;
  baseAmount: string;
  /** Applied to bills by the payment itself (its own allocations, as recorded). */
  appliedToBills: string;
  /** The prepayment it created: amount − appliedToBills. */
  prepayment: string;
  /** The net realized FX of the payment's own allocations (C1); later applications excluded. */
  realizedFx: string;
  voidedAt: string | null;
}

const filters = (f: RegisterFilter, alias: string, accountColumn: string) => sql`
  ${f.vendorId ? sql`AND ${sql.raw(alias)}.vendor_id = ${f.vendorId}` : sql``}
  ${f.paymentAccountId ? sql`AND ${sql.raw(`${alias}.${accountColumn}`)} = ${f.paymentAccountId}` : sql``}
  ${f.currencyCode ? sql`AND ${sql.raw(alias)}.currency_code = ${f.currencyCode}` : sql``}`;

/** RECORDED and VOID payments in a period, oldest first, at most the limit plus one. */
export async function registerPayments(
  tx: Transaction,
  f: RegisterFilter,
  limit: number,
): Promise<RegisterPayment[]> {
  const result = await tx.execute<{
    id: string;
    number: string;
    status: 'RECORDED' | 'VOID';
    payment_date: string;
    vendor_id: string;
    payment_account_id: string;
    payment_batch_id: string | null;
    currency_code: string;
    amount: string;
    exchange_rate: string;
    exchange_rate_source: string;
    base_amount: string;
    applied: string;
    fx: string;
    voided_at: string | null;
  }>(sql`
    SELECT p.id, p.number, p.status, p.payment_date::text AS payment_date, p.vendor_id,
           p.payment_account_id, p.payment_batch_id, p.currency_code, p.amount::text,
           p.exchange_rate::text, p.exchange_rate_source, p.base_amount::text,
           coalesce(own.applied, 0)::text AS applied, coalesce(own.fx, 0)::text AS fx,
           p.voided_at::text AS voided_at
      FROM purchases_payments p
      LEFT JOIN LATERAL (
        SELECT sum(a.amount) AS applied, sum(a.fx_difference) AS fx
          FROM purchases_allocations a
         WHERE a.payment_id = p.id AND a.organization_id = p.organization_id
           AND a.mode = 'payment' AND a.reverses_allocation_id IS NULL) own ON true
     WHERE p.organization_id = ${f.organizationId} AND p.status IN ('RECORDED', 'VOID')
       AND p.payment_date BETWEEN ${f.from}::date AND ${f.to}::date
       ${filters(f, 'p', 'payment_account_id')}
     ORDER BY p.payment_date, p.number, p.id
     LIMIT ${limit + 1}`);
  return result.rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    paymentDate: r.payment_date,
    vendorId: r.vendor_id,
    paymentAccountId: r.payment_account_id,
    paymentBatchId: r.payment_batch_id,
    currencyCode: r.currency_code,
    amount: r.amount,
    exchangeRate: r.exchange_rate,
    exchangeRateSource: r.exchange_rate_source,
    baseAmount: r.base_amount,
    appliedToBills: r.applied,
    prepayment: decimal(r.amount).minus(decimal(r.applied)).toFixed(),
    realizedFx: r.fx,
    voidedAt: r.voided_at,
  }));
}

export interface RegisterRefund {
  id: string;
  number: string;
  status: 'RECORDED' | 'VOID';
  refundDate: string;
  vendorId: string;
  refundAccountId: string;
  sourceType: 'payment' | 'vendor_credit';
  sourceId: string;
  sourceNumber: string | null;
  currencyCode: string;
  amount: string;
  exchangeRate: string;
  baseAmount: string;
  fxDifference: string;
  voidedAt: string | null;
}

/** RECORDED and VOID vendor refunds in a period (a separate section, PD7), at most the limit plus one. */
export async function registerRefunds(
  tx: Transaction,
  f: RegisterFilter,
  limit: number,
): Promise<RegisterRefund[]> {
  const result = await tx.execute<{
    id: string;
    number: string;
    status: 'RECORDED' | 'VOID';
    refund_date: string;
    vendor_id: string;
    refund_account_id: string;
    source_type: 'payment' | 'vendor_credit';
    source_id: string;
    source_number: string | null;
    currency_code: string;
    amount: string;
    exchange_rate: string;
    base_amount: string;
    fx_difference: string;
    voided_at: string | null;
  }>(sql`
    SELECT r.id, r.number, r.status, r.refund_date::text AS refund_date, r.vendor_id,
           r.refund_account_id, r.source_type, coalesce(r.payment_id, r.vendor_credit_id) AS source_id,
           coalesce(p.number, c.number) AS source_number, r.currency_code, r.amount::text,
           r.exchange_rate::text, r.base_amount::text, r.fx_difference::text,
           r.voided_at::text AS voided_at
      FROM purchases_refunds r
      LEFT JOIN purchases_payments p ON p.id = r.payment_id AND p.organization_id = r.organization_id
      LEFT JOIN purchases_vendor_credits c ON c.id = r.vendor_credit_id AND c.organization_id = r.organization_id
     WHERE r.organization_id = ${f.organizationId}
       AND r.refund_date BETWEEN ${f.from}::date AND ${f.to}::date
       ${filters(f, 'r', 'refund_account_id')}
     ORDER BY r.refund_date, r.number, r.id
     LIMIT ${limit + 1}`);
  return result.rows.map((r) => ({
    id: r.id,
    number: r.number,
    status: r.status,
    refundDate: r.refund_date,
    vendorId: r.vendor_id,
    refundAccountId: r.refund_account_id,
    sourceType: r.source_type,
    sourceId: r.source_id,
    sourceNumber: r.source_number,
    currencyCode: r.currency_code,
    amount: r.amount,
    exchangeRate: r.exchange_rate,
    baseAmount: r.base_amount,
    fxDifference: r.fx_difference,
    voidedAt: r.voided_at,
  }));
}
