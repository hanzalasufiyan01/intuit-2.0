import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';

/**
 * Sales reports (Phase 3B step 17; Decision 45): derived from issued invoices and credit notes,
 * never a second source of truth. Amounts are in the base currency at each document's rate,
 * rounded per line; credit notes count negatively. Opening invoices are excluded (they are
 * balances, not sales). Voided invoices drop out.
 */

/** Issued sales lines in a period, signed, with their base values. */
const salesLines = (organizationId: string, from: string, to: string, places: number) => sql`
  SELECT i.customer_id, i.id AS document_id, 'invoice' AS document_type, l.item_id,
         l.tax_code_id, l.tax_rate, l.quantity AS quantity,
         round(l.net_amount * i.exchange_rate, ${places}::int) AS net_base,
         round(l.tax_amount * i.exchange_rate, ${places}::int) AS tax_base
    FROM sales_invoices i
    JOIN sales_invoice_lines l ON l.invoice_id = i.id AND l.organization_id = i.organization_id
   WHERE i.organization_id = ${organizationId} AND i.status = 'ISSUED' AND i.kind = 'standard'
     AND i.invoice_date BETWEEN ${from}::date AND ${to}::date
  UNION ALL
  SELECT n.customer_id, n.id, 'credit_note', l.item_id, l.tax_code_id, l.tax_rate, -l.quantity,
         -round(l.net_amount * n.exchange_rate, ${places}::int), -round(l.tax_amount * n.exchange_rate, ${places}::int)
    FROM sales_credit_notes n
    JOIN sales_credit_note_lines l ON l.credit_note_id = n.id AND l.organization_id = n.organization_id
   WHERE n.organization_id = ${organizationId} AND n.status = 'ISSUED'
     AND n.credit_date BETWEEN ${from}::date AND ${to}::date`;

export async function salesByCustomer(
  tx: Transaction,
  input: { organizationId: string; from: string; to: string; places: number },
) {
  const result = await tx.execute<{
    customer_id: string;
    invoices: number;
    credit_notes: number;
    net: string;
    tax: string;
  }>(sql`
    SELECT customer_id,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'invoice')::int AS invoices,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'credit_note')::int AS credit_notes,
           sum(net_base)::text AS net, sum(tax_base)::text AS tax
      FROM (${salesLines(input.organizationId, input.from, input.to, input.places)}) s
     GROUP BY customer_id
     ORDER BY sum(net_base) DESC`);
  return result.rows;
}

export async function salesByItem(
  tx: Transaction,
  input: { organizationId: string; from: string; to: string; places: number },
) {
  const result = await tx.execute<{
    item_id: string | null;
    quantity: string;
    net: string;
    lines: number;
  }>(sql`
    SELECT item_id, sum(quantity)::text AS quantity, sum(net_base)::text AS net, count(*)::int AS lines
      FROM (${salesLines(input.organizationId, input.from, input.to, input.places)}) s
     GROUP BY item_id
     ORDER BY sum(net_base) DESC`);
  return result.rows;
}

/** Taxable amounts and tax per code and rate (a summary for review; not a tax return, R31). */
export async function taxSummary(
  tx: Transaction,
  input: { organizationId: string; from: string; to: string; places: number },
) {
  const result = await tx.execute<{
    tax_code_id: string | null;
    tax_rate: string | null;
    taxable: string;
    tax: string;
  }>(sql`
    SELECT tax_code_id, tax_rate::text, sum(net_base)::text AS taxable, sum(tax_base)::text AS tax
      FROM (${salesLines(input.organizationId, input.from, input.to, input.places)}) s
     GROUP BY tax_code_id, tax_rate
     ORDER BY tax_code_id NULLS LAST, tax_rate`);
  return result.rows;
}
