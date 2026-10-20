import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  ConflictError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getItem } from '../modules/catalog/index.js';
import {
  BillPermissions,
  getBill,
  getVendorCredit,
  VendorCreditPermissions,
} from '../modules/purchases/index.js';
import {
  documentLotsOf,
  expiringLots,
  getBalance,
  getTrackedItems,
  InventoryPermissions,
  listWarehouses,
  lotLevelsOfItem,
  replaceDocumentLots,
  type LotDocumentType,
} from '../modules/inventory/index.js';
import { hasPermission, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Lots, serials and expiry (FP-29 A6, migration 0079, ADR 0014 AI-07): the lots a draft bill brings
 * in or a draft vendor credit takes out, the lots of an item with their stock per warehouse, and the
 * expiry report. Stock itself is placed by the inventory service when the document posts.
 */

const QUANTITY = /^(0|[1-9]\d{0,21})(\.\d{1,6})?$/;
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface DocumentLotInput {
  itemId: string;
  lotCode: string;
  expiryDate?: string | null | undefined;
  quantity: string;
}

export class InventoryLotService {
  constructor(private readonly deps: AppDependencies) {}

  getDocumentLots(principal: Principal, type: LotDocumentType, documentId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) =>
        (await documentLotsOf(tx, ctx.organizationId, type, documentId)).map((r) => ({
          itemId: r.itemId,
          lotCode: r.lotCode,
          expiryDate: r.expiryDate,
          quantity: decimal(r.quantity).toFixed(),
        })),
    );
  }

  /** Replaces the lots of a DRAFT bill (lots coming in) or vendor credit (lots going back). */
  setDocumentLots(
    principal: Principal,
    type: LotDocumentType,
    documentId: string,
    lots: DocumentLotInput[],
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const needed = type === 'bill' ? BillPermissions.Create : VendorCreditPermissions.Create;
      if (!hasPermission(ctx, needed)) throw new PermissionDeniedError();
      const document =
        type === 'bill'
          ? await getBill(tx, ctx.organizationId, documentId)
          : await getVendorCredit(tx, ctx.organizationId, documentId);
      if (!document) throw new NotFoundError('Document not found.');
      if (document.status !== 'DRAFT') {
        throw invalidState('Lots can only be set while the document is a draft.');
      }
      const issues: ValidationIssue[] = [];
      const tracked = await getTrackedItems(
        tx,
        ctx.organizationId,
        lots.map((l) => l.itemId),
      );
      const seen = new Set<string>();
      lots.forEach((l, i) => {
        const item = tracked.get(l.itemId);
        if (!item || item.trackingMode === 'none') {
          issues.push({
            path: `lots.${i}.itemId`,
            message: 'This item is not tracked by lot or serial number.',
          });
        }
        const code = l.lotCode.trim();
        if (!code || code.length > 60)
          issues.push({
            path: `lots.${i}.lotCode`,
            message: 'A lot or serial number is 1 to 60 characters.',
          });
        const key = `${l.itemId}|${code.toLowerCase()}`;
        if (seen.has(key))
          issues.push({ path: `lots.${i}.lotCode`, message: 'List each lot once per item.' });
        seen.add(key);
        if (!QUANTITY.test(l.quantity) || !decimal(l.quantity).gt(0)) {
          issues.push({ path: `lots.${i}.quantity`, message: 'Enter a quantity above zero.' });
        } else if (item?.trackingMode === 'serial' && !decimal(l.quantity).eq(1)) {
          issues.push({ path: `lots.${i}.quantity`, message: 'A serial number is one unit.' });
        }
        if (l.expiryDate && !isValidIsoDate(l.expiryDate)) {
          issues.push({
            path: `lots.${i}.expiryDate`,
            message: 'Enter a valid date (YYYY-MM-DD).',
          });
        }
        if (item && !item.expiryTracked && l.expiryDate) {
          issues.push({
            path: `lots.${i}.expiryDate`,
            message: 'This item does not track expiry dates.',
          });
        }
      });
      if (issues.length) throw new ValidationError(issues);
      await replaceDocumentLots(
        tx,
        ctx.organizationId,
        type,
        documentId,
        lots.map((l) => ({
          itemId: l.itemId,
          lotCode: l.lotCode.trim(),
          expiryDate: l.expiryDate ?? null,
          quantity: decimal(l.quantity).toFixed(6),
        })),
      );
      await recordAuditEvent(tx, {
        occurredAt: this.deps.clock.now(),
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        action: 'inventory.document_lots_set',
        resourceType: 'inventory_document',
        resourceId: documentId,
        metadata: { documentType: type, lots: lots.length },
        origin,
      });
      return { lots: lots.length };
    });
  }

  /** The lots of one item with their stock per warehouse. */
  itemLots(principal: Principal, itemId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!(await getBalance(tx, ctx.organizationId, itemId))) {
          throw new NotFoundError('Tracked item not found.');
        }
        const [rows, warehouses] = await Promise.all([
          lotLevelsOfItem(tx, ctx.organizationId, itemId),
          listWarehouses(tx, ctx.organizationId),
        ]);
        const name = new Map(warehouses.map((w) => [w.id, w.name]));
        const lots = new Map<
          string,
          {
            lotId: string;
            code: string;
            expiryDate: string | null;
            quantity: ReturnType<typeof decimal>;
            warehouses: { warehouseId: string; name: string | null; quantity: string }[];
          }
        >();
        for (const r of rows) {
          const entry = lots.get(r.lotId) ?? {
            lotId: r.lotId,
            code: r.code,
            expiryDate: r.expiryDate,
            quantity: decimal(0),
            warehouses: [],
          };
          entry.quantity = entry.quantity.plus(r.quantity);
          entry.warehouses.push({
            warehouseId: r.warehouseId,
            name: name.get(r.warehouseId) ?? null,
            quantity: decimal(r.quantity).toFixed(),
          });
          lots.set(r.lotId, entry);
        }
        return [...lots.values()].map((l) => ({ ...l, quantity: l.quantity.toFixed() }));
      },
    );
  }

  /** Lots with stock that expire within `days` of `asOf` (or already have), soonest first. */
  expiring(principal: Principal, input: { days: number; asOf: string }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: InventoryPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const through = new Date(Date.parse(`${input.asOf}T00:00:00Z`) + input.days * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const [rows, warehouses] = await Promise.all([
          expiringLots(tx, ctx.organizationId, through),
          listWarehouses(tx, ctx.organizationId),
        ]);
        const warehouseName = new Map(warehouses.map((w) => [w.id, w.name]));
        const itemNames = new Map<string, string>();
        for (const r of rows) {
          if (!itemNames.has(r.itemId)) {
            itemNames.set(r.itemId, (await getItem(tx, ctx.organizationId, r.itemId))?.name ?? '');
          }
        }
        const day = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
        return {
          asOf: input.asOf,
          through,
          lots: rows.map((r) => ({
            lotId: r.lotId,
            itemId: r.itemId,
            itemName: itemNames.get(r.itemId) ?? '',
            code: r.code,
            expiryDate: r.expiryDate,
            daysToExpiry: day(r.expiryDate) - day(input.asOf),
            expired: r.expiryDate < input.asOf,
            warehouseId: r.warehouseId,
            warehouseName: warehouseName.get(r.warehouseId) ?? null,
            quantity: decimal(r.quantity).toFixed(),
          })),
        };
      },
    );
  }
}
