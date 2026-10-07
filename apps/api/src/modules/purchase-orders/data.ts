import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { likeContains } from '../catalog/index.js';
import {
  purchaseBillMatches,
  purchaseOrderBillings,
  purchaseOrderBills,
  purchaseOrderLines,
  purchaseOrderNumberSequences,
  purchaseOrderSettings,
  purchaseOrders,
  purchaseReceiptLines,
  purchaseReceipts,
  type MatchIssue,
  type MatchMode,
  type OrderStatus,
} from './schema.js';

/** Purchase order data access. Rules live in the application services. */

export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type PurchaseOrderLine = typeof purchaseOrderLines.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;
export type PurchaseOrderLineValues = Omit<
  typeof purchaseOrderLines.$inferInsert,
  'id' | 'organizationId' | 'orderId' | 'receivedQuantity' | 'billedQuantity'
>;
export type PurchaseReceipt = typeof purchaseReceipts.$inferSelect;
export type PurchaseReceiptLine = typeof purchaseReceiptLines.$inferSelect;
export type OrderSettings = typeof purchaseOrderSettings.$inferSelect;
export type BillMatch = typeof purchaseBillMatches.$inferSelect;

const scoped = (organizationId: string, id: string) =>
  and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.id, id));

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getOrderSettings(
  tx: Transaction,
  organizationId: string,
): Promise<OrderSettings | undefined> {
  const [row] = await tx
    .select()
    .from(purchaseOrderSettings)
    .where(eq(purchaseOrderSettings.organizationId, organizationId));
  return row;
}

export async function saveOrderSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    matchMode: MatchMode;
    quantityTolerancePct: string;
    priceTolerancePct: string;
    userId: string;
    at: Date;
  },
): Promise<OrderSettings | undefined> {
  const values = {
    matchMode: input.matchMode,
    quantityTolerancePct: input.quantityTolerancePct,
    priceTolerancePct: input.priceTolerancePct,
    updatedByUserId: input.userId,
    updatedAt: input.at,
  };
  if (input.version === 0) {
    const [row] = await tx
      .insert(purchaseOrderSettings)
      .values({ organizationId: input.organizationId, ...values })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(purchaseOrderSettings)
    .set({ ...values, version: sql`${purchaseOrderSettings.version} + 1` })
    .where(
      and(
        eq(purchaseOrderSettings.organizationId, input.organizationId),
        eq(purchaseOrderSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export async function getOrder(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchaseOrder | undefined> {
  const query = tx.select().from(purchaseOrders).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getOrderLines(
  tx: Transaction,
  organizationId: string,
  orderId: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchaseOrderLine[]> {
  const query = tx
    .select()
    .from(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.organizationId, organizationId),
        eq(purchaseOrderLines.orderId, orderId),
      ),
    )
    .orderBy(asc(purchaseOrderLines.lineNo));
  return options.forUpdate ? query.for('update') : query;
}

export async function insertOrder(
  tx: Transaction,
  values: NewPurchaseOrder,
): Promise<PurchaseOrder> {
  const [row] = await tx.insert(purchaseOrders).values(values).returning();
  return row!;
}

export async function updateOrder(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    from: OrderStatus | readonly OrderStatus[];
    version?: number | undefined;
    set: Partial<NewPurchaseOrder>;
  },
): Promise<PurchaseOrder | undefined> {
  const from = typeof input.from === 'string' ? [input.from] : [...input.from];
  const [row] = await tx
    .update(purchaseOrders)
    .set({ ...input.set, version: sql`${purchaseOrders.version} + 1` })
    .where(
      and(
        scoped(input.organizationId, input.id),
        inArray(purchaseOrders.status, from),
        input.version === undefined ? undefined : eq(purchaseOrders.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function replaceOrderLines(
  tx: Transaction,
  organizationId: string,
  orderId: string,
  lines: readonly PurchaseOrderLineValues[],
): Promise<PurchaseOrderLine[]> {
  await tx
    .delete(purchaseOrderLines)
    .where(
      and(
        eq(purchaseOrderLines.organizationId, organizationId),
        eq(purchaseOrderLines.orderId, orderId),
      ),
    );
  if (lines.length === 0) return [];
  return tx
    .insert(purchaseOrderLines)
    .values(lines.map((l) => ({ ...l, organizationId, orderId })))
    .returning();
}

export async function deleteOrder(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .delete(purchaseOrders)
    .where(and(scoped(organizationId, id), eq(purchaseOrders.status, 'DRAFT')))
    .returning({ id: purchaseOrders.id });
  return row !== undefined;
}

/** Adds to the received or billed quantity of an order line (the line guard allows only these). */
export async function addLineQuantity(
  tx: Transaction,
  organizationId: string,
  lineId: string,
  column: 'receivedQuantity' | 'billedQuantity',
  delta: string,
) {
  const target = purchaseOrderLines[column];
  await tx
    .update(purchaseOrderLines)
    .set({ [column]: sql`${target} + ${delta}::numeric` })
    .where(
      and(eq(purchaseOrderLines.organizationId, organizationId), eq(purchaseOrderLines.id, lineId)),
    );
}

export interface OrderListQuery {
  organizationId: string;
  statuses: readonly OrderStatus[] | null;
  vendorId: string | null;
  search: string | null;
  vendorIdsIn?: SQL | undefined;
  from: string | null;
  to: string | null;
  limit: number;
  after: { date: string; id: string } | null;
}

export async function listOrders(tx: Transaction, query: OrderListQuery) {
  const t = purchaseOrders;
  const conditions: (SQL | undefined)[] = [eq(t.organizationId, query.organizationId)];
  if (query.statuses) conditions.push(inArray(t.status, [...query.statuses]));
  if (query.vendorId) conditions.push(eq(t.vendorId, query.vendorId));
  if (query.from) conditions.push(sql`${t.orderDate} >= ${query.from}`);
  if (query.to) conditions.push(sql`${t.orderDate} <= ${query.to}`);
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(t.number, pattern),
        query.vendorIdsIn ? sql`${t.vendorId} IN (${query.vendorIdsIn})` : undefined,
      ),
    );
  }
  if (query.after) {
    conditions.push(
      sql`(${t.orderDate}, ${t.id}) < (${query.after.date}::date, ${query.after.id}::uuid)`,
    );
  }
  const rows = await tx
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.orderDate), desc(t.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

export async function orderNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: purchaseOrders.id })
    .from(purchaseOrders)
    .where(
      and(eq(purchaseOrders.organizationId, organizationId), eq(purchaseOrders.number, number)),
    )
    .limit(1);
  return row !== undefined;
}

export async function receiptNumberExists(tx: Transaction, organizationId: string, number: string) {
  const [row] = await tx
    .select({ id: purchaseReceipts.id })
    .from(purchaseReceipts)
    .where(
      and(eq(purchaseReceipts.organizationId, organizationId), eq(purchaseReceipts.number, number)),
    )
    .limit(1);
  return row !== undefined;
}

export async function takeNextOrderNumber(
  tx: Transaction,
  organizationId: string,
  documentType: 'order' | 'receipt',
): Promise<string> {
  await tx
    .insert(purchaseOrderNumberSequences)
    .values({ organizationId, documentType, prefix: documentType === 'order' ? 'PO-' : 'GR-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(purchaseOrderNumberSequences)
    .set({ nextNumber: sql`${purchaseOrderNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(purchaseOrderNumberSequences.organizationId, organizationId),
        eq(purchaseOrderNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// ---------------------------------------------------------------------------
// Receipts
// ---------------------------------------------------------------------------

export async function insertReceipt(
  tx: Transaction,
  values: typeof purchaseReceipts.$inferInsert,
  lines: readonly { orderLineId: string; quantity: string }[],
): Promise<PurchaseReceipt> {
  const [row] = await tx.insert(purchaseReceipts).values(values).returning();
  await tx.insert(purchaseReceiptLines).values(
    lines.map((l, i) => ({
      organizationId: values.organizationId,
      receiptId: row!.id,
      lineNo: i + 1,
      orderLineId: l.orderLineId,
      quantity: l.quantity,
    })),
  );
  return row!;
}

export async function getReceipt(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<PurchaseReceipt | undefined> {
  const query = tx
    .select()
    .from(purchaseReceipts)
    .where(and(eq(purchaseReceipts.organizationId, organizationId), eq(purchaseReceipts.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getReceiptLines(
  tx: Transaction,
  organizationId: string,
  receiptId: string,
): Promise<PurchaseReceiptLine[]> {
  return tx
    .select()
    .from(purchaseReceiptLines)
    .where(
      and(
        eq(purchaseReceiptLines.organizationId, organizationId),
        eq(purchaseReceiptLines.receiptId, receiptId),
      ),
    )
    .orderBy(asc(purchaseReceiptLines.lineNo));
}

export async function listReceipts(
  tx: Transaction,
  organizationId: string,
  orderId: string | null,
  limit: number,
): Promise<PurchaseReceipt[]> {
  return tx
    .select()
    .from(purchaseReceipts)
    .where(
      and(
        eq(purchaseReceipts.organizationId, organizationId),
        orderId ? eq(purchaseReceipts.orderId, orderId) : undefined,
      ),
    )
    .orderBy(desc(purchaseReceipts.receiptDate), desc(purchaseReceipts.id))
    .limit(limit);
}

export async function voidReceipt(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    userId: string;
    reason: string;
    at: Date;
  },
): Promise<PurchaseReceipt | undefined> {
  const [row] = await tx
    .update(purchaseReceipts)
    .set({
      status: 'VOID',
      voidedByUserId: input.userId,
      voidedAt: input.at,
      voidReason: input.reason,
      updatedByUserId: input.userId,
      updatedAt: input.at,
      version: sql`${purchaseReceipts.version} + 1`,
    })
    .where(
      and(
        eq(purchaseReceipts.organizationId, input.organizationId),
        eq(purchaseReceipts.id, input.id),
        eq(purchaseReceipts.version, input.version),
        eq(purchaseReceipts.status, 'POSTED'),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Bill links, billings and matches
// ---------------------------------------------------------------------------

export async function getBillLink(tx: Transaction, organizationId: string, billId: string) {
  const [row] = await tx
    .select()
    .from(purchaseOrderBills)
    .where(
      and(
        eq(purchaseOrderBills.organizationId, organizationId),
        eq(purchaseOrderBills.billId, billId),
      ),
    );
  return row;
}

export async function listOrderBills(tx: Transaction, organizationId: string, orderId: string) {
  return tx
    .select()
    .from(purchaseOrderBills)
    .where(
      and(
        eq(purchaseOrderBills.organizationId, organizationId),
        eq(purchaseOrderBills.orderId, orderId),
      ),
    )
    .orderBy(asc(purchaseOrderBills.linkedAt));
}

export async function insertBillLink(
  tx: Transaction,
  values: typeof purchaseOrderBills.$inferInsert,
) {
  await tx.insert(purchaseOrderBills).values(values);
}

export async function insertBilling(
  tx: Transaction,
  values: typeof purchaseOrderBillings.$inferInsert,
) {
  await tx.insert(purchaseOrderBillings).values(values);
}

export async function listActiveBillings(tx: Transaction, organizationId: string, billId: string) {
  return tx
    .select()
    .from(purchaseOrderBillings)
    .where(
      and(
        eq(purchaseOrderBillings.organizationId, organizationId),
        eq(purchaseOrderBillings.billId, billId),
        isNull(purchaseOrderBillings.reversedAt),
      ),
    );
}

export async function reverseBilling(
  tx: Transaction,
  organizationId: string,
  id: string,
  at: Date,
) {
  await tx
    .update(purchaseOrderBillings)
    .set({ reversedAt: at })
    .where(
      and(
        eq(purchaseOrderBillings.organizationId, organizationId),
        eq(purchaseOrderBillings.id, id),
      ),
    );
}

export async function insertBillMatch(
  tx: Transaction,
  values: {
    organizationId: string;
    billId: string;
    orderId: string;
    mode: MatchMode;
    status: 'matched' | 'warning';
    issues: MatchIssue[];
    createdAt: Date;
  },
) {
  await tx.insert(purchaseBillMatches).values(values);
}

export async function getBillMatch(
  tx: Transaction,
  organizationId: string,
  billId: string,
): Promise<BillMatch | undefined> {
  const [row] = await tx
    .select()
    .from(purchaseBillMatches)
    .where(
      and(
        eq(purchaseBillMatches.organizationId, organizationId),
        eq(purchaseBillMatches.billId, billId),
      ),
    );
  return row;
}

/** Open commitments: what is still to be billed on live orders, by vendor and currency. */
export async function commitmentsByVendor(tx: Transaction, organizationId: string) {
  const { rows } = await tx.execute<{
    vendor_id: string;
    currency_code: string;
    order_count: string;
    ordered: string;
    open_value: string;
  }>(sql`
    SELECT o.vendor_id, o.currency_code, count(DISTINCT o.id)::text AS order_count,
           sum(l.total)::text AS ordered,
           sum(CASE WHEN l.quantity > 0
                    THEN round(l.total * greatest(l.quantity - l.billed_quantity, 0) / l.quantity, 4)
                    ELSE 0 END)::text AS open_value
      FROM purchase_orders o
      JOIN purchase_order_lines l ON l.order_id = o.id AND l.organization_id = o.organization_id
     WHERE o.organization_id = ${organizationId}
       AND o.status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED')
     GROUP BY o.vendor_id, o.currency_code
     ORDER BY o.vendor_id, o.currency_code`);
  return rows.map((r) => ({
    vendorId: r.vendor_id,
    currencyCode: r.currency_code,
    orderCount: Number(r.order_count),
    ordered: r.ordered,
    openValue: r.open_value,
  }));
}
