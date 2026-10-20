import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  customerStatementLinks,
  invoiceShareLinks,
  paymentReminders,
  paymentReminderSettings,
  salesOrderInvoiceLines,
  salesOrderLines,
  salesOrderNumberSequences,
  salesOrders,
  type OrderStatus,
} from './schema.js';

export type ReminderSettings = typeof paymentReminderSettings.$inferSelect;
export type Reminder = typeof paymentReminders.$inferSelect;
export type SalesOrder = typeof salesOrders.$inferSelect;
export type SalesOrderLine = typeof salesOrderLines.$inferSelect;
export type ShareLink = typeof invoiceShareLinks.$inferSelect;

// Reminders ------------------------------------------------------------------

export async function getReminderSettings(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select()
    .from(paymentReminderSettings)
    .where(eq(paymentReminderSettings.organizationId, organizationId));
  return row;
}

export async function saveReminderSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    version: number;
    values: Omit<typeof paymentReminderSettings.$inferInsert, 'organizationId' | 'version'>;
  },
) {
  if (input.version === 0) {
    const [row] = await tx
      .insert(paymentReminderSettings)
      .values({ organizationId: input.organizationId, ...input.values })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(paymentReminderSettings)
    .set({ ...input.values, version: sql`${paymentReminderSettings.version} + 1` })
    .where(
      and(
        eq(paymentReminderSettings.organizationId, input.organizationId),
        eq(paymentReminderSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function insertReminder(
  tx: Transaction,
  values: typeof paymentReminders.$inferInsert,
) {
  const [row] = await tx.insert(paymentReminders).values(values).onConflictDoNothing().returning();
  return row;
}

export async function remindersOfInvoices(
  tx: Transaction,
  organizationId: string,
  invoiceIds: readonly string[],
) {
  if (!invoiceIds.length) return [];
  return tx
    .select()
    .from(paymentReminders)
    .where(
      and(
        eq(paymentReminders.organizationId, organizationId),
        sql`${paymentReminders.invoiceId} IN (${sql.join(
          invoiceIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(paymentReminders.sentAt));
}

export async function organizationsWithAutoReminders(tx: Transaction): Promise<string[]> {
  const result = await tx.execute<{ organization_id: string }>(
    sql`SELECT organization_id FROM app_organizations_with_auto_reminders()`,
  );
  return result.rows.map((r) => r.organization_id);
}

// Sales orders -----------------------------------------------------------------

export async function takeNextOrderNumber(tx: Transaction, organizationId: string) {
  await tx
    .insert(salesOrderNumberSequences)
    .values({ organizationId, documentType: 'order', prefix: 'SO-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(salesOrderNumberSequences)
    .set({ nextNumber: sql`${salesOrderNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(salesOrderNumberSequences.organizationId, organizationId),
        eq(salesOrderNumberSequences.documentType, 'order'),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

export async function insertOrder(tx: Transaction, values: typeof salesOrders.$inferInsert) {
  const [row] = await tx.insert(salesOrders).values(values).returning();
  return row!;
}

export async function getOrder(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(salesOrders)
    .where(and(eq(salesOrders.organizationId, organizationId), eq(salesOrders.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listOrders(
  tx: Transaction,
  organizationId: string,
  filter: { status?: OrderStatus | undefined; customerId?: string | undefined; limit: number },
) {
  return tx
    .select()
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.organizationId, organizationId),
        filter.status ? eq(salesOrders.status, filter.status) : sql`true`,
        filter.customerId ? eq(salesOrders.customerId, filter.customerId) : sql`true`,
      ),
    )
    .orderBy(desc(salesOrders.orderDate), desc(salesOrders.id))
    .limit(filter.limit);
}

export async function updateOrder(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof salesOrders.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(salesOrders)
    .set({ ...input.set, version: sql`${salesOrders.version} + 1` })
    .where(
      and(
        eq(salesOrders.organizationId, input.organizationId),
        eq(salesOrders.id, input.id),
        eq(salesOrders.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function deleteOrder(tx: Transaction, organizationId: string, id: string) {
  await tx
    .delete(salesOrderLines)
    .where(
      and(eq(salesOrderLines.organizationId, organizationId), eq(salesOrderLines.orderId, id)),
    );
  await tx
    .delete(salesOrders)
    .where(and(eq(salesOrders.organizationId, organizationId), eq(salesOrders.id, id)));
}

export async function replaceOrderLines(
  tx: Transaction,
  organizationId: string,
  orderId: string,
  lines: readonly Omit<
    typeof salesOrderLines.$inferInsert,
    'organizationId' | 'orderId' | 'lineNo'
  >[],
) {
  await tx
    .delete(salesOrderLines)
    .where(
      and(eq(salesOrderLines.organizationId, organizationId), eq(salesOrderLines.orderId, orderId)),
    );
  if (lines.length) {
    await tx
      .insert(salesOrderLines)
      .values(lines.map((l, i) => ({ organizationId, orderId, lineNo: i + 1, ...l })));
  }
}

export async function getOrderLines(tx: Transaction, organizationId: string, orderId: string) {
  return tx
    .select()
    .from(salesOrderLines)
    .where(
      and(eq(salesOrderLines.organizationId, organizationId), eq(salesOrderLines.orderId, orderId)),
    )
    .orderBy(asc(salesOrderLines.lineNo));
}

export async function insertOrderInvoiceLines(
  tx: Transaction,
  values: (typeof salesOrderInvoiceLines.$inferInsert)[],
) {
  if (values.length) await tx.insert(salesOrderInvoiceLines).values(values);
}

/**
 * Quantity invoiced per order line: only invoices that still exist and are not void count, so a
 * deleted draft (or a voided invoice) releases its quantity.
 */
export async function invoicedQuantities(tx: Transaction, organizationId: string, orderId: string) {
  const result = await tx.execute<{ line_no: number; quantity: string }>(sql`
    SELECT l.line_no, sum(l.quantity)::text AS quantity
      FROM sales_order_invoice_lines l
      JOIN sales_invoices i ON i.id = l.invoice_id AND i.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.order_id = ${orderId} AND i.status <> 'VOID'
     GROUP BY l.line_no`);
  return new Map(result.rows.map((r) => [r.line_no, r.quantity]));
}

export async function invoicesOfOrder(tx: Transaction, organizationId: string, orderId: string) {
  const result = await tx.execute<{ invoice_id: string; status: string }>(sql`
    SELECT DISTINCT l.invoice_id, i.status
      FROM sales_order_invoice_lines l
      JOIN sales_invoices i ON i.id = l.invoice_id AND i.organization_id = l.organization_id
     WHERE l.organization_id = ${organizationId} AND l.order_id = ${orderId}`);
  return result.rows.map((r) => ({ invoiceId: r.invoice_id, status: r.status }));
}

// Share links --------------------------------------------------------------------

export async function insertShareLink(
  tx: Transaction,
  values: typeof invoiceShareLinks.$inferInsert,
) {
  const [row] = await tx.insert(invoiceShareLinks).values(values).returning();
  return row!;
}

export async function listShareLinks(tx: Transaction, organizationId: string, invoiceId: string) {
  return tx
    .select()
    .from(invoiceShareLinks)
    .where(
      and(
        eq(invoiceShareLinks.organizationId, organizationId),
        eq(invoiceShareLinks.invoiceId, invoiceId),
      ),
    )
    .orderBy(desc(invoiceShareLinks.createdAt));
}

export async function getShareLink(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(invoiceShareLinks)
    .where(and(eq(invoiceShareLinks.organizationId, organizationId), eq(invoiceShareLinks.id, id)));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function revokeShareLink(
  tx: Transaction,
  organizationId: string,
  id: string,
  userId: string,
  at: Date,
) {
  const [row] = await tx
    .update(invoiceShareLinks)
    .set({ revokedAt: at, revokedByUserId: userId })
    .where(and(eq(invoiceShareLinks.organizationId, organizationId), eq(invoiceShareLinks.id, id)))
    .returning();
  return row;
}

/** Resolves a token hash to the invoice it opens (a live link only) and counts the view. */
export async function openShareLink(tx: Transaction, hash: string, at: Date) {
  const result = await tx.execute<{ organization_id: string; invoice_id: string; link_id: string }>(
    sql`SELECT organization_id, invoice_id, link_id FROM app_open_invoice_share_link(${hash}, ${at.toISOString()}::timestamptz)`,
  );
  const row = result.rows[0];
  return row
    ? { organizationId: row.organization_id, invoiceId: row.invoice_id, linkId: row.link_id }
    : null;
}

// Customer statement links -------------------------------------------------------------

export type StatementLink = typeof customerStatementLinks.$inferSelect;

export async function insertStatementLink(
  tx: Transaction,
  values: typeof customerStatementLinks.$inferInsert,
) {
  const [row] = await tx.insert(customerStatementLinks).values(values).returning();
  return row!;
}

export async function listStatementLinks(
  tx: Transaction,
  organizationId: string,
  customerId: string,
) {
  return tx
    .select()
    .from(customerStatementLinks)
    .where(
      and(
        eq(customerStatementLinks.organizationId, organizationId),
        eq(customerStatementLinks.customerId, customerId),
      ),
    )
    .orderBy(desc(customerStatementLinks.createdAt));
}

export async function getStatementLink(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(customerStatementLinks)
    .where(
      and(
        eq(customerStatementLinks.organizationId, organizationId),
        eq(customerStatementLinks.id, id),
      ),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function revokeStatementLink(
  tx: Transaction,
  organizationId: string,
  id: string,
  userId: string,
  at: Date,
) {
  const [row] = await tx
    .update(customerStatementLinks)
    .set({ revokedAt: at, revokedByUserId: userId })
    .where(
      and(
        eq(customerStatementLinks.organizationId, organizationId),
        eq(customerStatementLinks.id, id),
      ),
    )
    .returning();
  return row;
}

/** Resolves a statement token hash to its customer (a live link only); optionally counts a view. */
export async function openStatementLink(
  tx: Transaction,
  hash: string,
  at: Date,
  countView: boolean,
) {
  const result = await tx.execute<{
    organization_id: string;
    customer_id: string;
    link_id: string;
  }>(
    sql`SELECT organization_id, customer_id, link_id FROM app_open_statement_link(${hash}, ${at.toISOString()}::timestamptz, ${countView})`,
  );
  const row = result.rows[0];
  return row
    ? { organizationId: row.organization_id, customerId: row.customer_id, linkId: row.link_id }
    : null;
}
