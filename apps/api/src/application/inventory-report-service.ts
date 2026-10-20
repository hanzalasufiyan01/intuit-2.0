import { sql } from 'drizzle-orm';
import { ValidationError, PermissionDeniedError } from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { InventoryPermissions, listTrackedItems } from '../modules/inventory/index.js';
import { PurchaseOrderPermissions } from '../modules/purchase-orders/index.js';
import { salesByItem, SalesPermissions } from '../modules/sales/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { reservedQuantityOf } from './delivery-service.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Inventory management reports (FP-22), all derived from the stock ledger and the sales ledger and
 * never a second source of truth:
 *  - low stock: tracked items at or below their reorder point;
 *  - slow-moving stock: days since the last sale and the last receipt (average costing keeps no
 *    cost layers, so this is an activity age, not a FIFO layer age);
 *  - COGS and item profitability: net sales (invoices minus credit notes) against the cost taken
 *    out of stock (sales, their voids and customer returns) in a period. Needs
 *    `inventory.view` and `sales.reports.view` because it joins both.
 */

const SLOW_BUCKETS = ['days0to30', 'days31to60', 'days61to90', 'over90', 'neverSold'] as const;
type SlowBucket = (typeof SLOW_BUCKETS)[number];

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function requireDate(value: string, path: string) {
  if (!isValidIsoDate(value)) {
    throw new ValidationError([{ path, message: 'Enter a valid date (YYYY-MM-DD).' }]);
  }
}

export class InventoryReportService {
  constructor(private readonly deps: AppDependencies) {}

  /** Tracked items whose quantity is at or below the reorder point (items without one are not listed). */
  lowStock(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listTrackedItems(tx, ctx.organizationId);
        const items = rows
          .filter((r) => r.reorderPoint !== null && decimal(r.quantity).lte(r.reorderPoint))
          .map((r) => ({
            itemId: r.itemId,
            sku: r.sku,
            name: r.name,
            quantity: decimal(r.quantity).toFixed(),
            reorderPoint: decimal(r.reorderPoint!).toFixed(),
            shortfall: decimal(r.reorderPoint!).minus(r.quantity).toFixed(),
          }))
          .sort(
            (a, b) => decimal(b.shortfall).comparedTo(a.shortfall) || a.name.localeCompare(b.name),
          );
        return { items };
      },
    );
  }

  /**
   * Purchase suggestions (specification section 18, reorder points). READ-ONLY: it creates no
   * purchase order, moves no stock and posts nothing; a person decides what to buy.
   *
   * For each tracked item with a reorder point: available = on hand - reserved + on order, and the
   * suggestion is what would bring `available` back up to the reorder point (listed only when that
   * is above zero). "Reserved" is the advisory reservation figure the availability screen shows.
   * "On order" is the unbilled remainder of approved, part-received and received purchase orders,
   * in base units (the stock enters on the bill); draft, pending, closed and cancelled orders count
   * for nothing. No lead time, safety stock or reorder quantity is modelled: the reorder point is
   * the only number the organization has defined. Needs `inventory.view` and `purchase_orders.view`
   * because it joins both.
   */
  purchaseSuggestions(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!hasPermission(ctx, PurchaseOrderPermissions.View)) throw new PermissionDeniedError();
        const tracked = (await listTrackedItems(tx, ctx.organizationId)).filter(
          (r) => r.reorderPoint !== null,
        );
        const open = await tx.execute<{ item_id: string; open_quantity: string }>(sql`
          SELECT l.item_id, sum(GREATEST(l.quantity - l.billed_quantity, 0))::text AS open_quantity
            FROM purchase_order_lines l
            JOIN purchase_orders o ON o.id = l.order_id AND o.organization_id = l.organization_id
           WHERE l.organization_id = ${ctx.organizationId} AND l.item_id IS NOT NULL
             AND o.status IN ('APPROVED', 'PARTIALLY_RECEIVED', 'RECEIVED')
           GROUP BY l.item_id`);
        const onOrderOf = new Map(open.rows.map((r) => [r.item_id, decimal(r.open_quantity)]));
        const reserving = await tx.execute<{ item_id: string }>(sql`
          SELECT DISTINCT item_id FROM stock_reservations
           WHERE organization_id = ${ctx.organizationId} AND status = 'ACTIVE'`);
        const today = this.deps.clock.now().toISOString().slice(0, 10);
        const reservedOf = new Map<string, ReturnType<typeof decimal>>();
        for (const r of reserving.rows) {
          reservedOf.set(
            r.item_id,
            await reservedQuantityOf(tx, ctx.organizationId, r.item_id, today),
          );
        }
        const items = [];
        for (const r of tracked) {
          const onHand = decimal(r.quantity);
          const reserved = reservedOf.get(r.itemId) ?? decimal(0);
          // Purchase orders are written in the purchase unit; stock is counted in the base unit.
          const onOrder = (onOrderOf.get(r.itemId) ?? decimal(0)).times(
            r.purchaseFactor === null ? 1 : r.purchaseFactor,
          );
          const available = onHand.minus(reserved).plus(onOrder);
          const suggested = decimal(r.reorderPoint!).minus(available);
          if (!suggested.gt(0)) continue;
          items.push({
            itemId: r.itemId,
            sku: r.sku,
            name: r.name,
            baseUnit: r.baseUnit,
            onHand: onHand.toFixed(),
            reserved: reserved.toFixed(),
            onOrder: onOrder.toFixed(),
            available: available.toFixed(),
            reorderPoint: decimal(r.reorderPoint!).toFixed(),
            suggestedQuantity: suggested.toFixed(),
          });
        }
        items.sort(
          (a, b) =>
            decimal(b.suggestedQuantity).comparedTo(a.suggestedQuantity) ||
            a.name.localeCompare(b.name),
        );
        return {
          items,
          note: 'A suggestion only: nothing is ordered, received or posted. Available is on hand minus reservations plus the unbilled quantity of approved purchase orders; the suggestion brings it back to the reorder point.',
        };
      },
    );
  }

  /** Stock on hand by days since its last sale, as of a date. */
  slowMoving(principal: Principal, input: { asOf: string }) {
    requireDate(input.asOf, 'asOf');
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const tracked = await listTrackedItems(tx, ctx.organizationId);
        const dates = await tx.execute<{
          item_id: string;
          last_sale: string | null;
          last_receipt: string | null;
        }>(sql`
          SELECT m.item_id,
                 max(m.movement_date) FILTER (WHERE m.kind = 'sale'
                   AND NOT EXISTS (SELECT 1 FROM inventory_movements v
                                    WHERE v.organization_id = m.organization_id AND v.reverses_id = m.id))::text AS last_sale,
                 max(m.movement_date) FILTER (WHERE m.kind IN ('purchase', 'sales_return')
                   AND NOT EXISTS (SELECT 1 FROM inventory_movements v
                                    WHERE v.organization_id = m.organization_id AND v.reverses_id = m.id))::text AS last_receipt
            FROM inventory_movements m
           WHERE m.organization_id = ${ctx.organizationId} AND m.movement_date <= ${input.asOf}::date
           GROUP BY m.item_id`);
        const byItem = new Map(dates.rows.map((r) => [r.item_id, r]));
        const totals = Object.fromEntries(SLOW_BUCKETS.map((b) => [b, decimal(0)])) as Record<
          SlowBucket,
          ReturnType<typeof decimal>
        >;
        const items = tracked
          .filter((r) => decimal(r.quantity).gt(0))
          .map((r) => {
            const d = byItem.get(r.itemId);
            const lastSale = d?.last_sale ?? null;
            const days = lastSale === null ? null : daysBetween(lastSale, input.asOf);
            const bucket: SlowBucket =
              days === null
                ? 'neverSold'
                : days <= 30
                  ? 'days0to30'
                  : days <= 60
                    ? 'days31to60'
                    : days <= 90
                      ? 'days61to90'
                      : 'over90';
            totals[bucket] = totals[bucket].plus(r.value);
            return {
              itemId: r.itemId,
              sku: r.sku,
              name: r.name,
              quantity: decimal(r.quantity).toFixed(),
              value: decimal(r.value).toFixed(places),
              lastSale,
              lastReceipt: d?.last_receipt ?? null,
              daysSinceLastSale: days,
              bucket,
            };
          })
          .sort(
            (a, b) =>
              (b.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER) -
                (a.daysSinceLastSale ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name),
          );
        return {
          asOf: input.asOf,
          baseCurrency: accounting.baseCurrency,
          note: 'Activity age: average costing keeps no cost layers, so this is the time since the last sale, not the age of each unit.',
          items,
          totals: Object.fromEntries(SLOW_BUCKETS.map((b) => [b, totals[b].toFixed(places)])),
        };
      },
    );
  }

  /** Net sales, cost of goods sold and gross margin per tracked item for a period. */
  cogsProfitability(principal: Principal, input: { from: string; to: string }) {
    requireDate(input.from, 'from');
    requireDate(input.to, 'to');
    if (input.from > input.to) {
      throw new ValidationError([
        { path: 'from', message: 'The start date is after the end date.' },
      ]);
    }
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.ReportsView)) throw new PermissionDeniedError();
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const tracked = await listTrackedItems(tx, ctx.organizationId);
        const cost = await tx.execute<{ item_id: string; quantity: string; value: string }>(sql`
          SELECT item_id, (-sum(quantity))::text AS quantity, (-sum(value))::text AS value
            FROM inventory_movements
           WHERE organization_id = ${ctx.organizationId}
             AND kind IN ('sale', 'sale_void', 'sales_return', 'sales_return_void')
             AND movement_date BETWEEN ${input.from}::date AND ${input.to}::date
           GROUP BY item_id`);
        const revenue = new Map(
          (await salesByItem(tx, { organizationId: ctx.organizationId, ...input, places })).map(
            (r) => [r.item_id, r],
          ),
        );
        const costOf = new Map(cost.rows.map((r) => [r.item_id, r]));
        const totals = { netSales: decimal(0), cogs: decimal(0) };
        const items = tracked
          .map((t) => {
            const sales = revenue.get(t.itemId);
            const c = costOf.get(t.itemId);
            if (!sales && !c) return null;
            const netSales = decimal(sales?.net ?? 0);
            const cogs = decimal(c?.value ?? 0);
            totals.netSales = totals.netSales.plus(netSales);
            totals.cogs = totals.cogs.plus(cogs);
            const margin = netSales.minus(cogs);
            return {
              itemId: t.itemId,
              sku: t.sku,
              name: t.name,
              quantitySold: decimal(c?.quantity ?? 0).toFixed(),
              netSales: netSales.toFixed(places),
              cogs: cogs.toFixed(places),
              grossMargin: margin.toFixed(places),
              marginPercent: netSales.isZero() ? null : margin.div(netSales).times(100).toFixed(2),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .sort((a, b) => decimal(b.grossMargin).comparedTo(a.grossMargin));
        const margin = totals.netSales.minus(totals.cogs);
        return {
          ...input,
          baseCurrency: accounting.baseCurrency,
          note: 'Sales are invoices minus credit notes at document rates; cost is stock taken out for sales, net of voids and customer returns.',
          items,
          totals: {
            netSales: totals.netSales.toFixed(places),
            cogs: totals.cogs.toFixed(places),
            grossMargin: margin.toFixed(places),
            marginPercent: totals.netSales.isZero()
              ? null
              : margin.div(totals.netSales).times(100).toFixed(2),
          },
        };
      },
    );
  }
}
