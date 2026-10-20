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
         l.dimension_value_ids AS line_dims, i.dimension_value_ids AS doc_dims,
         round(l.net_amount * i.exchange_rate, ${places}::int) AS net_base,
         round(l.tax_amount * i.exchange_rate, ${places}::int) AS tax_base
    FROM sales_invoices i
    JOIN sales_invoice_lines l ON l.invoice_id = i.id AND l.organization_id = i.organization_id
   WHERE i.organization_id = ${organizationId} AND i.status = 'ISSUED' AND i.kind = 'standard'
     AND i.invoice_date BETWEEN ${from}::date AND ${to}::date
  UNION ALL
  SELECT n.customer_id, n.id, 'credit_note', l.item_id, l.tax_code_id, l.tax_rate, -l.quantity,
         l.dimension_value_ids, n.dimension_value_ids,
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

/**
 * Net sales and tax per value of ONE dimension type (for example per branch), from the same
 * issued lines as the other sales reports. A line's own value of the type wins, else the
 * document's (the same merge the posting uses, D10); lines with neither are "unassigned".
 */
export async function salesByDimension(
  tx: Transaction,
  input: {
    organizationId: string;
    from: string;
    to: string;
    places: number;
    dimensionTypeId: string;
  },
) {
  const result = await tx.execute<{
    value_id: string | null;
    invoices: number;
    credit_notes: number;
    net: string;
    tax: string;
  }>(sql`
    SELECT value_id,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'invoice')::int AS invoices,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'credit_note')::int AS credit_notes,
           sum(net_base)::text AS net, sum(tax_base)::text AS tax
      FROM (
        SELECT s.*,
               coalesce(
                 (SELECT v.id FROM accounting_dimension_values v
                   WHERE v.id = ANY(s.line_dims) AND v.dimension_type_id = ${input.dimensionTypeId} LIMIT 1),
                 (SELECT v.id FROM accounting_dimension_values v
                   WHERE v.id = ANY(s.doc_dims) AND v.dimension_type_id = ${input.dimensionTypeId} LIMIT 1)
               ) AS value_id
          FROM (${salesLines(input.organizationId, input.from, input.to, input.places)}) s
      ) t
     GROUP BY value_id
     ORDER BY sum(net_base) DESC`);
  return result.rows;
}

/**
 * Net sales and tax per item category (migration 0088): items with no category and lines with no
 * item are "uncategorized". Same issued lines as the other sales reports.
 */
export async function salesByCategory(
  tx: Transaction,
  input: { organizationId: string; from: string; to: string; places: number },
) {
  const result = await tx.execute<{
    category_id: string | null;
    quantity: string;
    net: string;
    tax: string;
    lines: number;
  }>(sql`
    SELECT a.category_id, sum(s.quantity)::text AS quantity, sum(s.net_base)::text AS net,
           sum(s.tax_base)::text AS tax, count(*)::int AS lines
      FROM (${salesLines(input.organizationId, input.from, input.to, input.places)}) s
      LEFT JOIN item_category_assignments a
        ON a.item_id = s.item_id AND a.organization_id = ${input.organizationId}
     GROUP BY a.category_id
     ORDER BY sum(s.net_base) DESC`);
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

/**
 * Net sales and tax per day, week or month (credit notes count negatively), with document counts.
 * The same line source and rounding as the other sales reports, so the totals agree with them.
 */
export async function salesTrend(
  tx: Transaction,
  input: {
    organizationId: string;
    from: string;
    to: string;
    places: number;
    granularity: 'day' | 'week' | 'month';
  },
) {
  const result = await tx.execute<{
    period: string;
    invoices: number;
    credit_notes: number;
    net: string;
    tax: string;
  }>(sql`
    SELECT to_char(date_trunc(${input.granularity}, d), 'YYYY-MM-DD') AS period,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'invoice')::int AS invoices,
           count(DISTINCT document_id) FILTER (WHERE document_type = 'credit_note')::int AS credit_notes,
           sum(net_base)::text AS net, sum(tax_base)::text AS tax
      FROM (
        SELECT i.id AS document_id, 'invoice' AS document_type, i.invoice_date AS d,
               round(l.net_amount * i.exchange_rate, ${input.places}::int) AS net_base,
               round(l.tax_amount * i.exchange_rate, ${input.places}::int) AS tax_base
          FROM sales_invoices i
          JOIN sales_invoice_lines l ON l.invoice_id = i.id AND l.organization_id = i.organization_id
         WHERE i.organization_id = ${input.organizationId} AND i.status = 'ISSUED' AND i.kind = 'standard'
           AND i.invoice_date BETWEEN ${input.from}::date AND ${input.to}::date
        UNION ALL
        SELECT n.id, 'credit_note', n.credit_date,
               -round(l.net_amount * n.exchange_rate, ${input.places}::int),
               -round(l.tax_amount * n.exchange_rate, ${input.places}::int)
          FROM sales_credit_notes n
          JOIN sales_credit_note_lines l ON l.credit_note_id = n.id AND l.organization_id = n.organization_id
         WHERE n.organization_id = ${input.organizationId} AND n.status = 'ISSUED'
           AND n.credit_date BETWEEN ${input.from}::date AND ${input.to}::date
      ) s
     GROUP BY 1
     ORDER BY 1`);
  return result.rows;
}
