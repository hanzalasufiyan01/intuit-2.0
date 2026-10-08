import { sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';

/**
 * Read queries for the Public API (ADR 0011). They run inside the integration's transaction
 * (RLS organization and service-principal context), additionally filter by the organization, and
 * SELECT EXPLICIT COLUMNS ONLY: nothing is selected that a public DTO does not map, so internal
 * columns (journal ids, base amounts, exchange-rate mechanics, snapshots, audit, dimensions,
 * account ids, creator ids) never leave the database layer. Rows are ordered by (created_at, id)
 * and paged by keyset; the cursor timestamp is selected as text with full precision.
 */

type Row = { id: unknown; cursor_ts: unknown; [column: string]: unknown };

/** The position after which a keyset page continues (full-precision creation time and id). */
export interface CursorPosition {
  /** `YYYY-MM-DDTHH:MM:SS.UUUUUUZ`, as returned by the read query (`cursor_ts`). */
  timestamp: string;
  id: string;
}

/** A timestamp column as an ISO 8601 UTC string (no driver-dependent date parsing). */
const ts = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${column.split('.')[1]}`;

const CURSOR_TS = (alias: string) =>
  sql.raw(
    `to_char(${alias}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts`,
  );

interface ListSpec {
  alias: string;
  columns: SQL;
  from: SQL;
  where: SQL[];
}

async function list(
  tx: Transaction,
  spec: ListSpec,
  organizationId: string,
  after: CursorPosition | null,
  limit: number,
): Promise<Row[]> {
  const a = sql.raw(spec.alias);
  const conditions: SQL[] = [sql`${a}.organization_id = ${organizationId}::uuid`, ...spec.where];
  if (after) {
    conditions.push(
      sql`(${a}.created_at, ${a}.id) > (${after.timestamp}::timestamptz, ${after.id}::uuid)`,
    );
  }
  const result = await tx.execute<Row>(sql`
    SELECT ${spec.columns}, ${CURSOR_TS(spec.alias)}
      FROM ${spec.from}
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${a}.created_at, ${a}.id
     LIMIT ${limit}`);
  return result.rows;
}

async function one(
  tx: Transaction,
  spec: ListSpec,
  organizationId: string,
  id: string,
): Promise<Row | undefined> {
  const a = sql.raw(spec.alias);
  const result = await tx.execute<Row>(sql`
    SELECT ${spec.columns}, ${CURSOR_TS(spec.alias)}
      FROM ${spec.from}
     WHERE ${a}.organization_id = ${organizationId}::uuid AND ${a}.id = ${id}::uuid
     LIMIT 1`);
  return result.rows[0];
}

export interface CommonFilters {
  status?: string | undefined;
  updatedSince?: string | undefined;
}

const common = (alias: string, f: CommonFilters): SQL[] => {
  const a = sql.raw(alias);
  const out: SQL[] = [];
  if (f.status) out.push(sql`${a}.status = ${f.status}`);
  if (f.updatedSince) out.push(sql`${a}.updated_at >= ${f.updatedSince}::timestamptz`);
  return out;
};

const CUSTOMER: Omit<ListSpec, 'where'> = {
  alias: 'c',
  columns: sql`c.id, p.display_name, p.company_name, p.kind, p.reference, p.tin, p.email, p.phone,
    p.website, c.currency_code, c.payment_terms_days, c.credit_limit, c.status, c.version,
    ${sql.raw(ts('c.created_at'))}, ${sql.raw(ts('c.updated_at'))}`,
  from: sql`customers c JOIN parties p ON p.id = c.party_id AND p.organization_id = c.organization_id`,
};

const VENDOR: Omit<ListSpec, 'where'> = {
  alias: 'v',
  columns: sql`v.id, p.display_name, p.company_name, p.kind, p.reference, p.tin, p.email, p.phone,
    p.website, v.currency_code, v.payment_terms_days, v.credit_limit, v.account_number, v.status,
    v.version, ${sql.raw(ts('v.created_at'))}, ${sql.raw(ts('v.updated_at'))}`,
  from: sql`vendors v JOIN parties p ON p.id = v.party_id AND p.organization_id = v.organization_id`,
};

const INVOICE: Omit<ListSpec, 'where'> = {
  alias: 'n',
  columns: sql`n.id, n.number, n.status, n.customer_id, n.invoice_date::text AS invoice_date, n.due_date::text AS due_date, n.currency_code,
    n.tax_treatment, n.subtotal, n.discount_total, n.tax_total, n.total, n.amount_due, n.reference,
    n.memo, ${sql.raw(ts('n.issued_at'))}, ${sql.raw(ts('n.voided_at'))}, n.version, ${sql.raw(ts('n.created_at'))}, ${sql.raw(ts('n.updated_at'))}`,
  from: sql`sales_invoices n`,
};

const BILL: Omit<ListSpec, 'where'> = {
  alias: 'b',
  columns: sql`b.id, b.number, b.status, b.vendor_id, b.vendor_reference, b.bill_date::text AS bill_date, b.due_date::text AS due_date,
    b.currency_code, b.tax_treatment, b.subtotal, b.discount_total, b.tax_total, b.total,
    b.amount_due, b.memo, ${sql.raw(ts('b.posted_at'))}, ${sql.raw(ts('b.voided_at'))}, b.version, ${sql.raw(ts('b.created_at'))}, ${sql.raw(ts('b.updated_at'))}`,
  from: sql`purchases_bills b`,
};

const ACCOUNT: Omit<ListSpec, 'where'> = {
  alias: 'a',
  columns: sql`a.id, a.code, a.name, a.description, a.account_type, a.subtype, a.parent_id,
    a.currency_code, a.status, ${sql.raw(ts('a.created_at'))}, ${sql.raw(ts('a.updated_at'))}`,
  from: sql`accounting_accounts a`,
};

const LINE_COLUMNS = sql`l.line_no, l.item_id, l.description, l.quantity, l.unit_price, l.discount_type,
  l.discount_value, l.net_amount, l.tax_rate, l.tax_amount, l.total`;

export class PublicApiReadService {
  // customers -----------------------------------------------------------------------------
  listCustomers(
    tx: Transaction,
    org: string,
    f: CommonFilters,
    after: CursorPosition | null,
    limit: number,
  ) {
    return list(tx, { ...CUSTOMER, where: common('c', f) }, org, after, limit);
  }
  getCustomer(tx: Transaction, org: string, id: string) {
    return one(tx, { ...CUSTOMER, where: [] }, org, id);
  }

  // vendors -------------------------------------------------------------------------------
  listVendors(
    tx: Transaction,
    org: string,
    f: CommonFilters,
    after: CursorPosition | null,
    limit: number,
  ) {
    return list(tx, { ...VENDOR, where: common('v', f) }, org, after, limit);
  }
  getVendor(tx: Transaction, org: string, id: string) {
    return one(tx, { ...VENDOR, where: [] }, org, id);
  }

  // invoices ------------------------------------------------------------------------------
  listInvoices(
    tx: Transaction,
    org: string,
    f: CommonFilters & {
      customerId?: string | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
    },
    after: CursorPosition | null,
    limit: number,
  ) {
    const where = common('n', f);
    if (f.customerId) where.push(sql`n.customer_id = ${f.customerId}::uuid`);
    if (f.dateFrom) where.push(sql`n.invoice_date >= ${f.dateFrom}::date`);
    if (f.dateTo) where.push(sql`n.invoice_date <= ${f.dateTo}::date`);
    return list(tx, { ...INVOICE, where }, org, after, limit);
  }
  async getInvoice(tx: Transaction, org: string, id: string) {
    const row = await one(tx, { ...INVOICE, where: [] }, org, id);
    if (!row) return undefined;
    const lines = await tx.execute<Row>(sql`
      SELECT ${LINE_COLUMNS} FROM sales_invoice_lines l
       WHERE l.organization_id = ${org}::uuid AND l.invoice_id = ${id}::uuid ORDER BY l.line_no`);
    return { row, lines: lines.rows };
  }

  // bills ---------------------------------------------------------------------------------
  listBills(
    tx: Transaction,
    org: string,
    f: CommonFilters & {
      vendorId?: string | undefined;
      dateFrom?: string | undefined;
      dateTo?: string | undefined;
    },
    after: CursorPosition | null,
    limit: number,
  ) {
    const where = common('b', f);
    if (f.vendorId) where.push(sql`b.vendor_id = ${f.vendorId}::uuid`);
    if (f.dateFrom) where.push(sql`b.bill_date >= ${f.dateFrom}::date`);
    if (f.dateTo) where.push(sql`b.bill_date <= ${f.dateTo}::date`);
    return list(tx, { ...BILL, where }, org, after, limit);
  }
  async getBill(tx: Transaction, org: string, id: string) {
    const row = await one(tx, { ...BILL, where: [] }, org, id);
    if (!row) return undefined;
    const lines = await tx.execute<Row>(sql`
      SELECT ${LINE_COLUMNS} FROM purchases_bill_lines l
       WHERE l.organization_id = ${org}::uuid AND l.bill_id = ${id}::uuid ORDER BY l.line_no`);
    return { row, lines: lines.rows };
  }

  // accounts ------------------------------------------------------------------------------
  listAccounts(
    tx: Transaction,
    org: string,
    f: CommonFilters & { type?: string | undefined },
    after: CursorPosition | null,
    limit: number,
  ) {
    const where = common('a', f);
    if (f.type) where.push(sql`a.account_type = ${f.type}`);
    return list(tx, { ...ACCOUNT, where }, org, after, limit);
  }
  getAccount(tx: Transaction, org: string, id: string) {
    return one(tx, { ...ACCOUNT, where: [] }, org, id);
  }
}
