import { Decimal } from 'decimal.js';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { designationsOfAccount, getAccount } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { CatalogPermissions } from '../modules/catalog/index.js';
import {
  findItemBySku,
  getItem,
  insertItem,
  listItems,
  SalesPermissions,
  updateItem,
  type SalesItem,
  type SalesItemFields,
  type SalesItemStatus,
  type SalesItemType,
} from '../modules/sales/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import { BillPermissions } from '../modules/purchases/index.js';
import { purchaseAccountProblem } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * The shared items catalog (D4, Decision 31; Phase 3B D8; ADR 0004 P4-05, P4-06): products and
 * services that are sold and/or purchased. The sales side holds a default price, revenue account
 * and tax code that invoice lines may override; the purchase side holds a purchase description,
 * default cost, expense account (P4-19 eligibility) and purchase tax code for later bill lines.
 * No inventory. Changes need `catalog.items.manage` (or, during the transition, the superseded
 * `sales.items.manage`); viewing also works with `invoices.view`.
 */

export interface ItemInput {
  sku: string | null;
  name: string;
  itemType: SalesItemType;
  description: string;
  unitPrice: string | null;
  revenueAccountId: string | null;
  taxCodeId: string | null;
  /** Purchase side (P4-05). Omitted on create: sold, not purchased, no purchase defaults. */
  isSold?: boolean | undefined;
  isPurchased?: boolean | undefined;
  purchaseDescription?: string | undefined;
  purchaseUnitCost?: string | null | undefined;
  expenseAccountId?: string | null | undefined;
  purchaseTaxCodeId?: string | null | undefined;
  /** P4-12: NULL = no item default. */
  purchaseTaxRecoverable?: boolean | null | undefined;
}

/** Catalog management (P4-06): the neutral key, or the superseded Sales key during the transition. */
const MANAGE_PERMISSIONS = [CatalogPermissions.ItemsManage, SalesPermissions.ItemsManage] as const;
const VIEW_PERMISSIONS = [
  SalesPermissions.InvoicesView,
  // ADR 0004 P4-06 (amended): bill users read the shared catalog.
  BillPermissions.View,
  ...MANAGE_PERMISSIONS,
] as const;

function requireAny(ctx: AuthorizationContext, keys: readonly string[]) {
  if (!keys.some((k) => hasPermission(ctx, k))) throw new PermissionDeniedError();
}

const ITEM_FIELDS = [
  'sku',
  'name',
  'itemType',
  'description',
  'unitPrice',
  'revenueAccountId',
  'taxCodeId',
  'isSold',
  'isPurchased',
  'purchaseDescription',
  'purchaseUnitCost',
  'expenseAccountId',
  'purchaseTaxCodeId',
  'purchaseTaxRecoverable',
] as const satisfies readonly (keyof SalesItemFields)[];

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This item was changed by someone else. Reload it and apply your changes again.',
  );

function encodeCursor(item: SalesItem) {
  return Buffer.from(JSON.stringify({ n: item.name.toLowerCase(), i: item.id })).toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { name: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      n?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.n === 'string' &&
      typeof parsed.i === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.i)
    ) {
      return { name: parsed.n, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
}

export class ItemService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private view(item: SalesItem, baseCurrency: string) {
    return {
      id: item.id,
      sku: item.sku,
      name: item.name,
      itemType: item.itemType,
      description: item.description,
      unitPrice:
        item.unitPrice === null
          ? null
          : new Decimal(item.unitPrice).toFixed(minorUnits(baseCurrency)),
      revenueAccountId: item.revenueAccountId,
      taxCodeId: item.taxCodeId,
      isSold: item.isSold,
      isPurchased: item.isPurchased,
      purchaseDescription: item.purchaseDescription,
      purchaseUnitCost:
        item.purchaseUnitCost === null
          ? null
          : new Decimal(item.purchaseUnitCost).toFixed(minorUnits(baseCurrency)),
      expenseAccountId: item.expenseAccountId,
      purchaseTaxCodeId: item.purchaseTaxCodeId,
      purchaseTaxRecoverable: item.purchaseTaxRecoverable,
      status: item.status,
      version: item.version,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      archivedAt: item.archivedAt?.toISOString() ?? null,
    };
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    itemId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'sales_item',
      resourceId: itemId,
      metadata,
      origin,
    });
  }

  private async requireItem(tx: Transaction, organizationId: string, id: string) {
    const item = await getItem(tx, organizationId, id, { forUpdate: true });
    if (!item) throw new NotFoundError('Item not found.');
    return item;
  }

  /** Checks references and the price; returns the normalized fields. */
  private async validate(
    tx: Transaction,
    organizationId: string,
    input: ItemInput,
    current?: SalesItem,
  ): Promise<SalesItemFields> {
    const settings = await requireAccountingSettings(tx, organizationId);
    const issues: ValidationIssue[] = [];
    if (input.sku && (await findItemBySku(tx, organizationId, input.sku, current?.id))) {
      throw new ConflictError('CONFLICT', 'Another item already uses this SKU.');
    }
    let unitPrice: string | null = null;
    if (input.unitPrice !== null) {
      const price = new Decimal(input.unitPrice);
      if (price.decimalPlaces() > 4) {
        issues.push({ path: 'unitPrice', message: 'Use at most 4 decimal places.' });
      }
      unitPrice = price.toFixed(4);
    }
    if (input.revenueAccountId && input.revenueAccountId !== current?.revenueAccountId) {
      const account = await getAccount(tx, organizationId, input.revenueAccountId);
      const path = 'revenueAccountId';
      if (!account) issues.push({ path, message: 'Account not found.' });
      else if (account.status !== 'ACTIVE')
        issues.push({ path, message: 'Choose an active account.' });
      else if (!account.isLeaf) issues.push({ path, message: 'Choose a posting (leaf) account.' });
      else if (account.accountType !== 'REVENUE') {
        issues.push({ path, message: 'Choose a revenue account.' });
      } else if (account.isControlAccount) {
        issues.push({ path, message: 'A control account cannot be used here.' });
      } else if (account.currencyCode !== settings.baseCurrency) {
        issues.push({ path, message: 'The revenue account is in the base currency.' });
      }
    }
    const taxCode = async (
      id: string | null | undefined,
      previous: string | null | undefined,
      path: string,
    ) => {
      if (!id || id === previous) return;
      const code = await getTaxCode(tx, organizationId, id);
      if (!code) issues.push({ path, message: 'Tax code not found.' });
      else if (code.status !== 'ACTIVE')
        issues.push({ path, message: 'Choose an active tax code.' });
    };
    await taxCode(input.taxCodeId, current?.taxCodeId, 'taxCodeId');

    // Purchase side (P4-05): at least one facet; a purchase account per P4-19 (clarified).
    const isSold = input.isSold ?? current?.isSold ?? true;
    const isPurchased = input.isPurchased ?? current?.isPurchased ?? false;
    if (!isSold && !isPurchased) {
      issues.push({ path: 'isSold', message: 'An item is sold, purchased, or both.' });
    }
    let purchaseUnitCost: string | null = null;
    const cost =
      input.purchaseUnitCost === undefined
        ? (current?.purchaseUnitCost ?? null)
        : input.purchaseUnitCost;
    if (cost !== null) {
      const value = new Decimal(cost);
      if (value.decimalPlaces() > 4) {
        issues.push({ path: 'purchaseUnitCost', message: 'Use at most 4 decimal places.' });
      }
      purchaseUnitCost = value.toFixed(4);
    }
    const expenseAccountId =
      input.expenseAccountId === undefined
        ? (current?.expenseAccountId ?? null)
        : input.expenseAccountId;
    if (expenseAccountId && expenseAccountId !== current?.expenseAccountId) {
      const account = await getAccount(tx, organizationId, expenseAccountId);
      const problem = account
        ? purchaseAccountProblem({
            status: account.status,
            isLeaf: account.isLeaf,
            subtype: account.subtype,
            isControlAccount: account.isControlAccount,
            designated: (await designationsOfAccount(tx, organizationId, account.id)).length > 0,
          })
        : 'Account not found.';
      if (problem) issues.push({ path: 'expenseAccountId', message: problem });
    }
    const purchaseTaxCodeId =
      input.purchaseTaxCodeId === undefined
        ? (current?.purchaseTaxCodeId ?? null)
        : input.purchaseTaxCodeId;
    await taxCode(purchaseTaxCodeId, current?.purchaseTaxCodeId, 'purchaseTaxCodeId');
    if (issues.length) throw new ValidationError(issues);
    return {
      sku: input.sku,
      name: input.name.trim(),
      itemType: input.itemType,
      description: input.description.trim(),
      unitPrice,
      revenueAccountId: input.revenueAccountId,
      taxCodeId: input.taxCodeId,
      isSold,
      isPurchased,
      purchaseDescription: (input.purchaseDescription ?? current?.purchaseDescription ?? '').trim(),
      purchaseUnitCost,
      expenseAccountId,
      purchaseTaxCodeId,
      purchaseTaxRecoverable:
        input.purchaseTaxRecoverable === undefined
          ? (current?.purchaseTaxRecoverable ?? null)
          : input.purchaseTaxRecoverable,
    };
  }

  list(
    principal: Principal,
    query: {
      search?: string | undefined;
      status: 'active' | 'archived' | 'all';
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.requireView(ctx);
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const status: SalesItemStatus | 'ALL' =
        query.status === 'all' ? 'ALL' : query.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
      const page = await listItems(tx, {
        organizationId: ctx.organizationId,
        status,
        search: query.search?.trim() || null,
        limit: query.limit,
        after: query.after ? decodeCursor(query.after) : null,
      });
      const last = page.items.at(-1);
      return {
        items: page.items.map((i) => this.view(i, settings.baseCurrency)),
        nextCursor: page.hasMore && last ? encodeCursor(last) : null,
      };
    });
  }

  get(principal: Principal, id: string) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      this.requireView(ctx);
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const item = await getItem(tx, ctx.organizationId, id);
      if (!item) throw new NotFoundError('Item not found.');
      return this.view(item, settings.baseCurrency);
    });
  }

  private requireView(ctx: AuthorizationContext) {
    requireAny(ctx, VIEW_PERMISSIONS);
  }

  /** The create rules without writing (step 18: items import validation). */
  async validateInTransaction(tx: Transaction, ctx: AuthorizationContext, input: ItemInput) {
    requireAny(ctx, MANAGE_PERMISSIONS);
    return this.validate(tx, ctx.organizationId, input);
  }

  /** Creates an item in the caller's transaction (step 18: items import commit). */
  async createInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ItemInput,
    origin: EventOrigin,
  ): Promise<SalesItem> {
    requireAny(ctx, MANAGE_PERMISSIONS);
    const fields = await this.validate(tx, ctx.organizationId, input);
    const item = await insertItem(tx, {
      ...fields,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      now: this.now,
    });
    await this.audit(tx, ctx, 'sales_item.created', item.id, { ...fields }, origin);
    return item;
  }

  create(principal: Principal, input: ItemInput, origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, MANAGE_PERMISSIONS);
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const item = await this.createInTransaction(tx, ctx, input, origin);
      return this.view(item, settings.baseCurrency);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: { version: number } & { [K in keyof ItemInput]?: ItemInput[K] | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, MANAGE_PERMISSIONS);
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const item = await this.requireItem(tx, ctx.organizationId, id);
      if (item.version !== input.version) throw versionConflict();
      const merged = Object.fromEntries(
        ITEM_FIELDS.map((k) => [k, input[k] === undefined ? item[k] : input[k]]),
      ) as unknown as ItemInput;
      const fields = await this.validate(tx, ctx.organizationId, merged, item);
      const changed = ITEM_FIELDS.filter((k) => fields[k] !== item[k]);
      if (!changed.length) return this.view(item, settings.baseCurrency);
      const saved = await updateItem(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: Object.fromEntries(changed.map((k) => [k, fields[k]])),
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      await this.audit(
        tx,
        ctx,
        'sales_item.updated',
        id,
        {
          version: saved.version,
          changedFields: changed,
          before: Object.fromEntries(changed.map((k) => [k, item[k]])),
          after: Object.fromEntries(changed.map((k) => [k, fields[k]])),
        },
        origin,
      );
      return this.view(saved, settings.baseCurrency);
    });
  }

  setStatus(
    principal: Principal,
    id: string,
    input: { version: number; status: SalesItemStatus },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, MANAGE_PERMISSIONS);
      const settings = await requireAccountingSettings(tx, ctx.organizationId);
      const item = await this.requireItem(tx, ctx.organizationId, id);
      if (item.version !== input.version) throw versionConflict();
      if (item.status === input.status) {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          `The item is already ${input.status.toLowerCase()}.`,
        );
      }
      const archived = input.status === 'ARCHIVED';
      const saved = await updateItem(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          status: input.status,
          archivedAt: archived ? this.now : null,
          archivedByUserId: archived ? ctx.userId : null,
        },
        userId: ctx.userId,
        now: this.now,
      });
      if (!saved) throw versionConflict();
      await this.audit(
        tx,
        ctx,
        archived ? 'sales_item.archived' : 'sales_item.restored',
        id,
        { name: item.name, sku: item.sku },
        origin,
      );
      return this.view(saved, settings.baseCurrency);
    });
  }
}
