import { NotFoundError, ValidationError, type ValidationIssue } from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { getItem } from '../modules/catalog/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  bundleComponentsOf,
  getTrackedItems,
  InventoryPermissions,
  listBundles,
  replaceBundleComponents,
} from '../modules/inventory/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Sales bundles (kits; FP-29 A7, migration 0077). A bundle is a catalog item that is not stock
 * tracked and lists tracked component items with a quantity each. Issuing an invoice with a bundle
 * line takes the components out of stock at their own average cost (see the inventory service);
 * revenue is the bundle line as invoiced. Bundles cannot nest. Editing a bundle affects future
 * invoices only.
 */

const MAX_COMPONENTS = 50;

export class InventoryBundleService {
  constructor(private readonly deps: AppDependencies) {}

  private async view(tx: Transaction, organizationId: string, bundleItemIds: readonly string[]) {
    const components = await bundleComponentsOf(tx, organizationId, bundleItemIds);
    const ids = new Set<string>(bundleItemIds);
    for (const list of components.values()) for (const c of list) ids.add(c.componentItemId);
    const names = new Map<string, string>();
    for (const id of ids) {
      const item = await getItem(tx, organizationId, id);
      if (item) names.set(id, item.name);
    }
    return bundleItemIds
      .filter((id) => components.has(id))
      .map((id) => ({
        bundleItemId: id,
        name: names.get(id) ?? '',
        components: components.get(id)!.map((c) => ({
          itemId: c.componentItemId,
          name: names.get(c.componentItemId) ?? '',
          quantity: decimal(c.quantity).toFixed(),
        })),
      }));
  }

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listBundles(tx, ctx.organizationId);
        return this.view(tx, ctx.organizationId, [...new Set(rows.map((r) => r.bundleItemId))]);
      },
    );
  }

  get(principal: Principal, bundleItemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const [bundle] = await this.view(tx, ctx.organizationId, [bundleItemId]);
        if (!bundle) throw new NotFoundError('Bundle not found.');
        return bundle;
      },
    );
  }

  /** Creates or replaces the component list of a bundle. */
  set(
    principal: Principal,
    bundleItemId: string,
    input: { components: { itemId: string; quantity: string }[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        const item = await getItem(tx, ctx.organizationId, bundleItemId, { forUpdate: true });
        if (!item) throw new NotFoundError('Item not found.');
        const issues: ValidationIssue[] = [];
        if (item.status !== 'ACTIVE')
          issues.push({ path: 'itemId', message: 'The item is archived.' });
        if ((await getTrackedItems(tx, ctx.organizationId, [bundleItemId])).size > 0) {
          issues.push({ path: 'itemId', message: 'A stock-tracked item cannot be a bundle.' });
        }
        if (input.components.length === 0 || input.components.length > MAX_COMPONENTS) {
          issues.push({
            path: 'components',
            message: `A bundle needs between 1 and ${MAX_COMPONENTS} components.`,
          });
        }
        const ids = input.components.map((c) => c.itemId);
        if (new Set(ids).size !== ids.length) {
          issues.push({ path: 'components', message: 'List each component item once.' });
        }
        const tracked = await getTrackedItems(tx, ctx.organizationId, ids);
        input.components.forEach((c, i) => {
          if (c.itemId === bundleItemId) {
            issues.push({
              path: `components.${i}.itemId`,
              message: 'A bundle cannot contain itself.',
            });
          } else if (!tracked.has(c.itemId)) {
            issues.push({
              path: `components.${i}.itemId`,
              message: 'A component must be an item that is tracked in stock.',
            });
          }
          if (!decimal(c.quantity).gt(0)) {
            issues.push({
              path: `components.${i}.quantity`,
              message: 'Enter a quantity above zero.',
            });
          }
        });
        if (issues.length) throw new ValidationError(issues);
        const before = (await this.view(tx, ctx.organizationId, [bundleItemId]))[0];
        try {
          await replaceBundleComponents(
            tx,
            ctx.organizationId,
            bundleItemId,
            input.components.map((c) => ({
              componentItemId: c.itemId,
              quantity: decimal(c.quantity).toFixed(6),
            })),
          );
        } catch (error) {
          // The database refuses nesting (a component that is a bundle, or a bundle that is a component).
          if (
            /bundles cannot nest/.test(
              String((error as { cause?: { message?: string } }).cause?.message ?? error),
            )
          ) {
            throw new ValidationError([
              { path: 'components', message: 'Bundles cannot contain other bundles.' },
            ]);
          }
          throw error;
        }
        const after = (await this.view(tx, ctx.organizationId, [bundleItemId]))[0]!;
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: before ? 'inventory.bundle_updated' : 'inventory.bundle_created',
          resourceType: 'inventory_item',
          resourceId: bundleItemId,
          metadata: {
            before: before?.components ?? null,
            after: after.components.map((c) => ({ itemId: c.itemId, quantity: c.quantity })),
          },
          origin,
        });
        return after;
      },
    );
  }

  remove(principal: Principal, bundleItemId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        const before = (await this.view(tx, ctx.organizationId, [bundleItemId]))[0];
        if (!before) throw new NotFoundError('Bundle not found.');
        await replaceBundleComponents(tx, ctx.organizationId, bundleItemId, []);
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'inventory.bundle_removed',
          resourceType: 'inventory_item',
          resourceId: bundleItemId,
          metadata: { before: before.components },
          origin,
        });
        return { bundleItemId };
      },
    );
  }
}
