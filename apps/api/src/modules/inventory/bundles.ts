import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { numeric, pgTable, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';

/** Sales bundles (kits) that expand into tracked component items at issue (migration 0077, FP-29 A7). */

export const inventoryBundleComponents = pgTable('inventory_bundle_components', {
  organizationId: uuid('organization_id').notNull(),
  bundleItemId: uuid('bundle_item_id').notNull(),
  componentItemId: uuid('component_item_id').notNull(),
  quantity: numeric('quantity', { precision: 28, scale: 6 }).notNull(),
});

export type BundleComponent = typeof inventoryBundleComponents.$inferSelect;

/** The components of the given bundle items (items that are not bundles are simply absent). */
export async function bundleComponentsOf(
  tx: Transaction,
  organizationId: string,
  bundleItemIds: readonly string[],
): Promise<Map<string, BundleComponent[]>> {
  const unique = [...new Set(bundleItemIds)];
  const out = new Map<string, BundleComponent[]>();
  if (!unique.length) return out;
  const rows = await tx
    .select()
    .from(inventoryBundleComponents)
    .where(
      and(
        eq(inventoryBundleComponents.organizationId, organizationId),
        inArray(inventoryBundleComponents.bundleItemId, unique),
      ),
    )
    .orderBy(asc(inventoryBundleComponents.componentItemId));
  for (const row of rows) {
    const list = out.get(row.bundleItemId) ?? [];
    list.push(row);
    out.set(row.bundleItemId, list);
  }
  return out;
}

export async function listBundles(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(inventoryBundleComponents)
    .where(eq(inventoryBundleComponents.organizationId, organizationId))
    .orderBy(
      asc(inventoryBundleComponents.bundleItemId),
      asc(inventoryBundleComponents.componentItemId),
    );
}

export async function replaceBundleComponents(
  tx: Transaction,
  organizationId: string,
  bundleItemId: string,
  components: readonly { componentItemId: string; quantity: string }[],
) {
  await tx
    .delete(inventoryBundleComponents)
    .where(
      and(
        eq(inventoryBundleComponents.organizationId, organizationId),
        eq(inventoryBundleComponents.bundleItemId, bundleItemId),
      ),
    );
  if (components.length) {
    await tx
      .insert(inventoryBundleComponents)
      .values(components.map((c) => ({ organizationId, bundleItemId, ...c })));
  }
}

/** Bundles that use the item as a component. */
export async function bundlesUsingComponent(
  tx: Transaction,
  organizationId: string,
  componentItemId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: inventoryBundleComponents.bundleItemId })
    .from(inventoryBundleComponents)
    .where(
      and(
        eq(inventoryBundleComponents.organizationId, organizationId),
        eq(inventoryBundleComponents.componentItemId, componentItemId),
      ),
    );
  return rows.map((r) => r.id);
}

export async function isBundle(tx: Transaction, organizationId: string, itemId: string) {
  const result = await tx.execute<{ n: number }>(
    sql`SELECT 1 AS n FROM inventory_bundle_components WHERE organization_id = ${organizationId} AND bundle_item_id = ${itemId} LIMIT 1`,
  );
  return result.rows.length > 0;
}
