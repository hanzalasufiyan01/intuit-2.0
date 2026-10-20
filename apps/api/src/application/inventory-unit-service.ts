import { sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  getTrackedItem,
  InventoryPermissions,
  updateTrackedItem,
} from '../modules/inventory/index.js';
import type { Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Units of measure (FP-29 A2, migration 0082, ADR 0014 AI-09). Stock is held in the item's base
 * unit; an item may have a purchase unit and a sales unit with a factor to the base unit. A change
 * is refused while any draft or pending document carries the item (its quantities would silently
 * change meaning); posted documents are unaffected because stock was recorded in base units.
 */

const FACTOR = /^(0|[1-9]\d{0,21})(\.\d{1,6})?$/;
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The item changed; reload it and try again.');

export interface UnitRef {
  unit: string;
  factor: string;
}
export interface UnitsInput {
  version: number;
  baseUnit?: string | undefined;
  purchaseUnit?: UnitRef | null | undefined;
  salesUnit?: UnitRef | null | undefined;
}

export class InventoryUnitService {
  constructor(private readonly deps: AppDependencies) {}

  private async openDocumentsWith(tx: Transaction, organizationId: string, itemId: string) {
    const result = await tx.execute<{ document: string }>(sql`
      SELECT 'invoice' AS document FROM sales_invoice_lines l
        JOIN sales_invoices d ON d.id = l.invoice_id AND d.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId} AND l.item_id = ${itemId}
         AND d.status IN ('DRAFT', 'PENDING_APPROVAL')
      UNION ALL
      SELECT 'credit note' FROM sales_credit_note_lines l
        JOIN sales_credit_notes d ON d.id = l.credit_note_id AND d.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId} AND l.item_id = ${itemId}
         AND d.status IN ('DRAFT', 'PENDING_APPROVAL')
      UNION ALL
      SELECT 'bill' FROM purchases_bill_lines l
        JOIN purchases_bills d ON d.id = l.bill_id AND d.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId} AND l.item_id = ${itemId}
         AND d.status IN ('DRAFT', 'PENDING_APPROVAL')
      UNION ALL
      SELECT 'vendor credit' FROM purchases_vendor_credit_lines l
        JOIN purchases_vendor_credits d ON d.id = l.vendor_credit_id AND d.organization_id = l.organization_id
       WHERE l.organization_id = ${organizationId} AND l.item_id = ${itemId}
         AND d.status IN ('DRAFT', 'PENDING_APPROVAL')
      LIMIT 1`);
    return result.rows[0]?.document ?? null;
  }

  private view(row: NonNullable<Awaited<ReturnType<typeof getTrackedItem>>>) {
    return {
      itemId: row.itemId,
      baseUnit: row.baseUnit,
      purchaseUnit:
        row.purchaseUnit === null
          ? null
          : { unit: row.purchaseUnit, factor: decimal(row.purchaseFactor!).toFixed() },
      salesUnit:
        row.salesUnit === null
          ? null
          : { unit: row.salesUnit, factor: decimal(row.salesFactor!).toFixed() },
      version: row.version,
    };
  }

  get(principal: Principal, itemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const row = await getTrackedItem(tx, ctx.organizationId, itemId);
        if (!row) throw new NotFoundError('Tracked item not found.');
        return this.view(row);
      },
    );
  }

  set(principal: Principal, itemId: string, input: UnitsInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.ItemsManage },
      async (tx, ctx) => {
        const current = await getTrackedItem(tx, ctx.organizationId, itemId);
        if (!current) throw new NotFoundError('Tracked item not found.');
        if (current.version !== input.version) throw versionConflict();
        const issues: ValidationIssue[] = [];
        const check = (path: string, ref: UnitRef | null | undefined) => {
          if (!ref) return;
          if (!ref.unit.trim() || ref.unit.trim().length > 20) {
            issues.push({ path: `${path}.unit`, message: 'A unit is 1 to 20 characters.' });
          }
          if (!FACTOR.test(ref.factor) || !decimal(ref.factor).gt(0)) {
            issues.push({
              path: `${path}.factor`,
              message: 'The factor is a number above zero with up to 6 decimals.',
            });
          }
        };
        check('purchaseUnit', input.purchaseUnit);
        check('salesUnit', input.salesUnit);
        if (
          input.baseUnit !== undefined &&
          (!input.baseUnit.trim() || input.baseUnit.trim().length > 20)
        ) {
          issues.push({ path: 'baseUnit', message: 'A unit is 1 to 20 characters.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const blocking = await this.openDocumentsWith(tx, ctx.organizationId, itemId);
        if (blocking) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `A draft ${blocking} still uses this item: post or delete it before changing its units, because its quantities would change meaning.`,
          );
        }
        const set: Parameters<typeof updateTrackedItem>[1]['set'] = {
          updatedByUserId: ctx.userId,
          updatedAt: this.deps.clock.now(),
        };
        if (input.baseUnit !== undefined) set.baseUnit = input.baseUnit.trim();
        if (input.purchaseUnit !== undefined) {
          set.purchaseUnit = input.purchaseUnit ? input.purchaseUnit.unit.trim() : null;
          set.purchaseFactor = input.purchaseUnit
            ? decimal(input.purchaseUnit.factor).toFixed(6)
            : null;
        }
        if (input.salesUnit !== undefined) {
          set.salesUnit = input.salesUnit ? input.salesUnit.unit.trim() : null;
          set.salesFactor = input.salesUnit ? decimal(input.salesUnit.factor).toFixed(6) : null;
        }
        const updated = await updateTrackedItem(tx, {
          organizationId: ctx.organizationId,
          itemId,
          version: input.version,
          set,
        });
        if (!updated) throw versionConflict();
        await recordAuditEvent(tx, {
          occurredAt: this.deps.clock.now(),
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'inventory.item_units_updated',
          resourceType: 'inventory_item',
          resourceId: itemId,
          metadata: {
            before: {
              baseUnit: current.baseUnit,
              purchaseUnit: current.purchaseUnit,
              purchaseFactor: current.purchaseFactor,
              salesUnit: current.salesUnit,
              salesFactor: current.salesFactor,
            },
            after: {
              baseUnit: updated.baseUnit,
              purchaseUnit: updated.purchaseUnit,
              purchaseFactor: updated.purchaseFactor,
              salesUnit: updated.salesUnit,
              salesFactor: updated.salesFactor,
            },
          },
          origin,
        });
        return this.view(updated);
      },
    );
  }
}
