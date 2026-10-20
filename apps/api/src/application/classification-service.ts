import { sql } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import type { ValidationIssue } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { BillPermissions } from '../modules/purchases/index.js';
import { CatalogPermissions, getItem } from '../modules/catalog/index.js';
import {
  barcodesOfItem,
  barcodesTakenByOthers,
  categoryOfItem,
  customerGroups,
  customersOfGroup,
  getFieldDefinition,
  getNamed,
  groupOfCustomer,
  insertFieldDefinition,
  insertNamed,
  itemCategories,
  itemOfBarcode,
  itemsOfCategory,
  listFieldDefinitions,
  listNamed,
  memberCounts,
  replaceBarcodes,
  setCustomerGroup,
  setFieldValue,
  setItemCategory,
  updateFieldDefinition,
  updateNamed,
  valuesOfRecord,
  attributesTaken,
  defaultBinsOfItem,
  getBin,
  insertBin,
  listBins,
  setDefaultBin,
  setVariant,
  updateBin,
  variantGroups,
  variantOfItem,
  variantsOfGroup,
  type CustomFieldDefinition,
  type CustomFieldType,
} from '../modules/classification/index.js';
import { CustomerPermissions, getCustomer } from '../modules/customers/index.js';
import { getWarehouse, InventoryPermissions } from '../modules/inventory/index.js';
import { SalesPermissions } from '../modules/sales/index.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Customer groups, custom fields on customers, product categories and barcodes (migration 0088;
 * master specification sections 10, 16 and 18). Side tables only: the customer and item records
 * do not change, and nothing here feeds accounting. Customer-side changes need
 * `customers.update`; item-side changes need the catalog management permission.
 */

const ITEM_MANAGE = [CatalogPermissions.ItemsManage, SalesPermissions.ItemsManage] as const;
const ITEM_VIEW = [SalesPermissions.InvoicesView, BillPermissions.View, ...ITEM_MANAGE] as const;

const versionConflict = (noun: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${noun} was changed by someone else. Reload it.`);

function requireAny(ctx: AuthorizationContext, keys: readonly string[]) {
  if (!keys.some((k) => hasPermission(ctx, k))) throw new PermissionDeniedError();
}

const iso = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

function fieldView(d: CustomFieldDefinition) {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    fieldType: d.fieldType,
    options: d.options,
    sortOrder: d.sortOrder,
    status: d.status,
    version: d.version,
  };
}

export class ClassificationService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Named lists: customer groups and item categories
  // ---------------------------------------------------------------------------

  private named(kind: 'group' | 'category' | 'variant') {
    if (kind === 'variant') {
      return {
        table: variantGroups,
        noun: 'variant group',
        prefix: 'variant_group',
        resource: 'variant_group',
        view: ITEM_VIEW as readonly string[],
        manage: ITEM_MANAGE as readonly string[],
        counts: 'variants' as const,
      };
    }
    return kind === 'group'
      ? {
          table: customerGroups,
          noun: 'customer group',
          prefix: 'customer_group',
          resource: 'customer_group',
          view: [CustomerPermissions.View, CustomerPermissions.Update],
          manage: [CustomerPermissions.Update],
          counts: 'groups' as const,
        }
      : {
          table: itemCategories,
          noun: 'item category',
          prefix: 'item_category',
          resource: 'item_category',
          view: ITEM_VIEW as readonly string[],
          manage: ITEM_MANAGE as readonly string[],
          counts: 'categories' as const,
        };
  }

  listNamed(principal: Principal, kind: 'group' | 'category' | 'variant') {
    const n = this.named(kind);
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, n.view);
      const rows = await listNamed(tx, n.table, ctx.organizationId);
      const counts = await memberCounts(tx, n.counts, ctx.organizationId);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        version: r.version,
        members: counts.get(r.id) ?? 0,
      }));
    });
  }

  createNamed(
    principal: Principal,
    kind: 'group' | 'category' | 'variant',
    name: string,
    origin: EventOrigin,
  ) {
    const n = this.named(kind);
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, n.manage);
      const row = await insertNamed(tx, n.table, {
        organizationId: ctx.organizationId,
        name: name.trim(),
        userId: ctx.userId,
        at: this.now,
      });
      if (!row) throw new ConflictError('CONFLICT', `A ${n.noun} with this name already exists.`);
      await this.audit(tx, ctx, `${n.prefix}.created`, n.resource, row.id, origin, {
        name: row.name,
      });
      return { id: row.id, name: row.name, status: row.status, version: row.version, members: 0 };
    });
  }

  updateNamed(
    principal: Principal,
    kind: 'group' | 'category' | 'variant',
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    },
    origin: EventOrigin,
  ) {
    const n = this.named(kind);
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, n.manage);
      const row = await getNamed(tx, n.table, ctx.organizationId, id);
      if (!row) throw new NotFoundError(`The ${n.noun} was not found.`);
      const set: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' } = {};
      if (input.name !== undefined && input.name.trim() !== row.name) set.name = input.name.trim();
      if (input.status !== undefined && input.status !== row.status) set.status = input.status;
      if (!Object.keys(set).length)
        return { id, name: row.name, status: row.status, version: row.version };
      let updated;
      try {
        updated = await updateNamed(tx, n.table, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set,
          userId: ctx.userId,
          at: this.now,
        });
      } catch {
        throw new ConflictError('CONFLICT', `A ${n.noun} with this name already exists.`);
      }
      if (!updated) throw versionConflict(n.noun);
      await this.audit(tx, ctx, `${n.prefix}.updated`, n.resource, id, origin, {
        before: { name: row.name, status: row.status },
        after: set,
      });
      return { id, name: updated.name, status: updated.status, version: updated.version };
    });
  }

  // ---------------------------------------------------------------------------
  // Customer group membership
  // ---------------------------------------------------------------------------

  getCustomerGroup(principal: Principal, customerId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.View]);
      if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
        throw new NotFoundError('Customer not found.');
      }
      const member = await groupOfCustomer(tx, ctx.organizationId, customerId);
      const group = member
        ? await getNamed(tx, customerGroups, ctx.organizationId, member.groupId)
        : undefined;
      return { groupId: group?.id ?? null, name: group?.name ?? null };
    });
  }

  setCustomerGroup(
    principal: Principal,
    customerId: string,
    groupId: string | null,
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.Update]);
      if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
        throw new NotFoundError('Customer not found.');
      }
      if (groupId !== null) {
        const group = await getNamed(tx, customerGroups, ctx.organizationId, groupId);
        if (!group || group.status !== 'ACTIVE') {
          throw new ValidationError([
            { path: 'groupId', message: 'Choose an active customer group.' },
          ]);
        }
      }
      const before = await groupOfCustomer(tx, ctx.organizationId, customerId);
      await setCustomerGroup(tx, {
        organizationId: ctx.organizationId,
        customerId,
        groupId,
        userId: ctx.userId,
        at: this.now,
      });
      await this.audit(tx, ctx, 'customer.group_set', 'customer', customerId, origin, {
        before: before?.groupId ?? null,
        after: groupId,
      });
      return { groupId };
    });
  }

  customersInGroup(principal: Principal, groupId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.View]);
      if (!(await getNamed(tx, customerGroups, ctx.organizationId, groupId))) {
        throw new NotFoundError('The customer group was not found.');
      }
      const rows = await customersOfGroup(tx, ctx.organizationId, groupId, 500);
      return rows.map((r) => r.customerId);
    });
  }

  // ---------------------------------------------------------------------------
  // Custom fields on customers
  // ---------------------------------------------------------------------------

  listFields(principal: Principal) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.View]);
      return (await listFieldDefinitions(tx, ctx.organizationId)).map(fieldView);
    });
  }

  private validateOptions(type: CustomFieldType, options: string[] | undefined): string[] | null {
    if (type !== 'list') {
      if (options !== undefined) {
        throw new ValidationError([{ path: 'options', message: 'Only a list field has options.' }]);
      }
      return null;
    }
    const clean = [...new Set((options ?? []).map((o) => o.trim()))].filter(Boolean);
    if (clean.length < 2 || clean.length > 50 || clean.some((o) => o.length > 100)) {
      throw new ValidationError([
        { path: 'options', message: 'Give 2 to 50 different choices of at most 100 characters.' },
      ]);
    }
    return clean;
  }

  createField(
    principal: Principal,
    input: {
      key: string;
      label: string;
      fieldType: CustomFieldType;
      options?: string[] | undefined;
      sortOrder?: number | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.Update]);
      const options = this.validateOptions(input.fieldType, input.options);
      const row = await insertFieldDefinition(tx, {
        organizationId: ctx.organizationId,
        key: input.key,
        label: input.label.trim(),
        fieldType: input.fieldType,
        options,
        sortOrder: input.sortOrder ?? 0,
        userId: ctx.userId,
        at: this.now,
      });
      if (!row) throw new ConflictError('CONFLICT', 'A custom field with this key already exists.');
      await this.audit(tx, ctx, 'custom_field.created', 'custom_field', row.id, origin, {
        key: row.key,
        fieldType: row.fieldType,
      });
      return fieldView(row);
    });
  }

  updateField(
    principal: Principal,
    id: string,
    input: {
      version: number;
      label?: string | undefined;
      options?: string[] | undefined;
      sortOrder?: number | undefined;
      status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.Update]);
      const def = await getFieldDefinition(tx, ctx.organizationId, id);
      if (!def) throw new NotFoundError('The custom field was not found.');
      const set: {
        label?: string;
        options?: string[];
        sortOrder?: number;
        status?: 'ACTIVE' | 'ARCHIVED';
      } = {};
      if (input.label !== undefined && input.label.trim() !== def.label)
        set.label = input.label.trim();
      if (input.sortOrder !== undefined && input.sortOrder !== def.sortOrder)
        set.sortOrder = input.sortOrder;
      if (input.status !== undefined && input.status !== def.status) set.status = input.status;
      if (input.options !== undefined) {
        const options = this.validateOptions(def.fieldType, input.options)!;
        // A choice that stored values still use cannot be removed.
        const removed = (def.options ?? []).filter((o) => !options.includes(o));
        if (removed.length) {
          const used = await tx.execute<{ n: number }>(sqlCount(ctx.organizationId, id, removed));
          if ((used.rows[0]?.n ?? 0) > 0) {
            throw new ConflictError(
              'CONFLICT',
              'A choice that customers still use cannot be removed; archive the field instead.',
            );
          }
        }
        set.options = options;
      }
      if (!Object.keys(set).length) return fieldView(def);
      const updated = await updateFieldDefinition(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set,
        userId: ctx.userId,
        at: this.now,
      });
      if (!updated) throw versionConflict('custom field');
      await this.audit(tx, ctx, 'custom_field.updated', 'custom_field', id, origin, {
        changed: Object.keys(set),
      });
      return fieldView(updated);
    });
  }

  /** Definitions with the customer's values (archived fields only when they hold a value). */
  getCustomerFields(principal: Principal, customerId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.View]);
      if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
        throw new NotFoundError('Customer not found.');
      }
      const [defs, values] = await Promise.all([
        listFieldDefinitions(tx, ctx.organizationId),
        valuesOfRecord(tx, ctx.organizationId, customerId),
      ]);
      const byField = new Map(values.map((v) => [v.fieldId, v.value]));
      return defs
        .filter((d) => d.status === 'ACTIVE' || byField.has(d.id))
        .map((d) => ({ ...fieldView(d), value: byField.get(d.id) ?? null }));
    });
  }

  /** Sets (or, with null, clears) values by field key. Unknown or archived keys are refused. */
  setCustomerFields(
    principal: Principal,
    customerId: string,
    values: Record<string, string | number | boolean | null>,
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [CustomerPermissions.Update]);
      if (!(await getCustomer(tx, ctx.organizationId, customerId))) {
        throw new NotFoundError('Customer not found.');
      }
      const defs = new Map(
        (await listFieldDefinitions(tx, ctx.organizationId)).map((d) => [d.key, d]),
      );
      const issues: ValidationIssue[] = [];
      const writes: { def: CustomFieldDefinition; value: string | number | boolean | null }[] = [];
      for (const [key, raw] of Object.entries(values)) {
        const def = defs.get(key);
        const path = `values.${key}`;
        if (!def || def.status !== 'ACTIVE') {
          issues.push({ path, message: 'Unknown or archived custom field.' });
          continue;
        }
        if (raw === null) {
          writes.push({ def, value: null });
          continue;
        }
        const bad = (message: string) => issues.push({ path, message });
        switch (def.fieldType) {
          case 'text':
            if (typeof raw !== 'string' || !raw.trim() || raw.length > 500)
              bad('Enter text of up to 500 characters.');
            else writes.push({ def, value: raw.trim() });
            break;
          case 'number':
            if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > 1e12)
              bad('Enter a number.');
            else writes.push({ def, value: raw });
            break;
          case 'date':
            if (typeof raw !== 'string' || !iso(raw)) bad('Enter a date (YYYY-MM-DD).');
            else writes.push({ def, value: raw });
            break;
          case 'boolean':
            if (typeof raw !== 'boolean') bad('Choose yes or no.');
            else writes.push({ def, value: raw });
            break;
          case 'list':
            if (typeof raw !== 'string' || !(def.options ?? []).includes(raw))
              bad('Choose one of the listed values.');
            else writes.push({ def, value: raw });
            break;
        }
      }
      if (issues.length) throw new ValidationError(issues);
      for (const w of writes) {
        await setFieldValue(tx, {
          organizationId: ctx.organizationId,
          fieldId: w.def.id,
          recordId: customerId,
          value: w.value,
          userId: ctx.userId,
          at: this.now,
        });
      }
      // Values can hold personal details, so the audit event names the fields only.
      await this.audit(tx, ctx, 'customer.custom_fields_set', 'customer', customerId, origin, {
        fields: writes.map((w) => w.def.key),
      });
      return this.customerValues(tx, ctx.organizationId, customerId);
    });
  }

  private async customerValues(tx: Transaction, organizationId: string, customerId: string) {
    const [defs, values] = await Promise.all([
      listFieldDefinitions(tx, organizationId),
      valuesOfRecord(tx, organizationId, customerId),
    ]);
    const byField = new Map(values.map((v) => [v.fieldId, v.value]));
    return defs
      .filter((d) => d.status === 'ACTIVE' || byField.has(d.id))
      .map((d) => ({ ...fieldView(d), value: byField.get(d.id) ?? null }));
  }

  // ---------------------------------------------------------------------------
  // Item category and barcodes
  // ---------------------------------------------------------------------------

  getItemClassification(principal: Principal, itemId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, ITEM_VIEW);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      const assignment = await categoryOfItem(tx, ctx.organizationId, itemId);
      const category = assignment
        ? await getNamed(tx, itemCategories, ctx.organizationId, assignment.categoryId)
        : undefined;
      return {
        categoryId: category?.id ?? null,
        categoryName: category?.name ?? null,
        barcodes: await barcodesOfItem(tx, ctx.organizationId, itemId),
      };
    });
  }

  setItemCategory(
    principal: Principal,
    itemId: string,
    categoryId: string | null,
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, ITEM_MANAGE);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      if (categoryId !== null) {
        const category = await getNamed(tx, itemCategories, ctx.organizationId, categoryId);
        if (!category || category.status !== 'ACTIVE') {
          throw new ValidationError([
            { path: 'categoryId', message: 'Choose an active category.' },
          ]);
        }
      }
      const before = await categoryOfItem(tx, ctx.organizationId, itemId);
      await setItemCategory(tx, {
        organizationId: ctx.organizationId,
        itemId,
        categoryId,
        userId: ctx.userId,
        at: this.now,
      });
      await this.audit(tx, ctx, 'item.category_set', 'item', itemId, origin, {
        before: before?.categoryId ?? null,
        after: categoryId,
      });
      return { categoryId };
    });
  }

  setItemBarcodes(principal: Principal, itemId: string, barcodes: string[], origin: EventOrigin) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, ITEM_MANAGE);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      const unique = [...new Set(barcodes.map((b) => b.trim()))];
      if (unique.length !== barcodes.length || unique.some((b) => !/^[\x21-\x7e]{1,64}$/.test(b))) {
        throw new ValidationError([
          {
            path: 'barcodes',
            message: 'List each barcode once, 1 to 64 visible characters without spaces.',
          },
        ]);
      }
      if (unique.length > 20) {
        throw new ValidationError([{ path: 'barcodes', message: 'At most 20 barcodes per item.' }]);
      }
      const taken = await barcodesTakenByOthers(tx, ctx.organizationId, unique, itemId);
      if (taken.length) {
        throw new ConflictError('CONFLICT', `Barcode ${taken[0]} already belongs to another item.`);
      }
      await replaceBarcodes(tx, {
        organizationId: ctx.organizationId,
        itemId,
        barcodes: unique,
        userId: ctx.userId,
        at: this.now,
      });
      await this.audit(tx, ctx, 'item.barcodes_set', 'item', itemId, origin, {
        count: unique.length,
      });
      return { barcodes: unique.sort() };
    });
  }

  /** Exact barcode lookup (for a scanner). */
  itemByBarcode(principal: Principal, barcode: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, ITEM_VIEW);
      const hit = await itemOfBarcode(tx, ctx.organizationId, barcode);
      const item = hit ? await getItem(tx, ctx.organizationId, hit.itemId) : undefined;
      if (!item) throw new NotFoundError('No item has this barcode.');
      return { id: item.id, sku: item.sku, name: item.name, status: item.status };
    });
  }

  // ---------------------------------------------------------------------------
  // Variants (migration 0090): items grouped under a parent with attributes
  // ---------------------------------------------------------------------------

  getItemVariant(principal: Principal, itemId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, ITEM_VIEW);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      const member = await variantOfItem(tx, ctx.organizationId, itemId);
      const group = member
        ? await getNamed(tx, variantGroups, ctx.organizationId, member.groupId)
        : undefined;
      return {
        groupId: group?.id ?? null,
        groupName: group?.name ?? null,
        attributes: member?.attributes ?? null,
      };
    });
  }

  /** Puts an item into a variant group with its attributes, or (groupId null) takes it out. */
  setItemVariant(
    principal: Principal,
    itemId: string,
    input: { groupId: string | null; attributes?: Record<string, string> | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, ITEM_MANAGE);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      let attributes: Record<string, string> = {};
      if (input.groupId !== null) {
        const group = await getNamed(tx, variantGroups, ctx.organizationId, input.groupId);
        if (!group || group.status !== 'ACTIVE') {
          throw new ValidationError([
            { path: 'groupId', message: 'Choose an active variant group.' },
          ]);
        }
        const entries = Object.entries(input.attributes ?? {}).map(
          ([k, v]) => [k.trim(), String(v).trim()] as const,
        );
        const issues: ValidationIssue[] = [];
        if (entries.length < 1 || entries.length > 6) {
          issues.push({
            path: 'attributes',
            message: 'Give 1 to 6 attributes, for example size and colour.',
          });
        }
        if (new Set(entries.map(([k]) => k.toLowerCase())).size !== entries.length) {
          issues.push({ path: 'attributes', message: 'Each attribute name is used once.' });
        }
        if (entries.some(([k, v]) => !k || !v || k.length > 40 || v.length > 100)) {
          issues.push({
            path: 'attributes',
            message: 'Names are up to 40 and values up to 100 characters.',
          });
        }
        if (issues.length) throw new ValidationError(issues);
        attributes = Object.fromEntries(entries);
        if (
          await attributesTaken(tx, {
            organizationId: ctx.organizationId,
            groupId: input.groupId,
            attributes,
            exceptItemId: itemId,
          })
        ) {
          throw new ConflictError(
            'CONFLICT',
            'Another variant of this group has the same attributes.',
          );
        }
      }
      const before = await variantOfItem(tx, ctx.organizationId, itemId);
      await setVariant(tx, {
        organizationId: ctx.organizationId,
        itemId,
        groupId: input.groupId,
        attributes,
        userId: ctx.userId,
        at: this.now,
      });
      await this.audit(tx, ctx, 'item.variant_set', 'item', itemId, origin, {
        before: before?.groupId ?? null,
        after: input.groupId,
      });
      return { groupId: input.groupId, attributes: input.groupId === null ? null : attributes };
    });
  }

  /** The variants of a group with their item names and attributes. */
  variantGroupDetail(principal: Principal, groupId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, ITEM_VIEW);
      const group = await getNamed(tx, variantGroups, ctx.organizationId, groupId);
      if (!group) throw new NotFoundError('The variant group was not found.');
      const members = await variantsOfGroup(tx, ctx.organizationId, groupId);
      const out = [];
      for (const m of members) {
        const item = await getItem(tx, ctx.organizationId, m.itemId);
        out.push({
          itemId: m.itemId,
          sku: item?.sku ?? null,
          name: item?.name ?? null,
          status: item?.status ?? null,
          attributes: m.attributes,
        });
      }
      return { id: group.id, name: group.name, status: group.status, variants: out };
    });
  }

  // ---------------------------------------------------------------------------
  // Bins (migration 0090): named locations inside a warehouse, labels only
  // ---------------------------------------------------------------------------

  listBins(principal: Principal, warehouseId?: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [InventoryPermissions.View]);
      const rows = await listBins(tx, ctx.organizationId, warehouseId);
      return rows.map((b) => ({
        id: b.id,
        warehouseId: b.warehouseId,
        code: b.code,
        name: b.name,
        status: b.status,
        version: b.version,
      }));
    });
  }

  createBin(
    principal: Principal,
    input: { warehouseId: string; code: string; name?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [InventoryPermissions.SettingsManage]);
      const warehouse = await getWarehouse(tx, ctx.organizationId, input.warehouseId);
      if (!warehouse || warehouse.status !== 'ACTIVE') {
        throw new ValidationError([
          { path: 'warehouseId', message: 'Choose an active warehouse.' },
        ]);
      }
      const row = await insertBin(tx, {
        organizationId: ctx.organizationId,
        warehouseId: input.warehouseId,
        code: input.code,
        name: (input.name ?? '').trim(),
        userId: ctx.userId,
        at: this.now,
      });
      if (!row)
        throw new ConflictError('CONFLICT', 'This warehouse already has a bin with this code.');
      await this.audit(tx, ctx, 'warehouse_bin.created', 'warehouse_bin', row.id, origin, {
        warehouseId: row.warehouseId,
        code: row.code,
      });
      return {
        id: row.id,
        warehouseId: row.warehouseId,
        code: row.code,
        name: row.name,
        status: row.status,
        version: row.version,
      };
    });
  }

  updateBin(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [InventoryPermissions.SettingsManage]);
      const bin = await getBin(tx, ctx.organizationId, id);
      if (!bin) throw new NotFoundError('Bin not found.');
      const set: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' } = {};
      if (input.name !== undefined && input.name.trim() !== bin.name) set.name = input.name.trim();
      if (input.status !== undefined && input.status !== bin.status) set.status = input.status;
      if (!Object.keys(set).length) return { id, status: bin.status, version: bin.version };
      const updated = await updateBin(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set,
        userId: ctx.userId,
        at: this.now,
      });
      if (!updated) throw versionConflict('bin');
      await this.audit(tx, ctx, 'warehouse_bin.updated', 'warehouse_bin', id, origin, {
        changed: Object.keys(set),
      });
      return { id, status: updated.status, version: updated.version };
    });
  }

  getDefaultBins(principal: Principal, itemId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, [InventoryPermissions.View]);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      return (await defaultBinsOfItem(tx, ctx.organizationId, itemId)).map((r) => ({
        warehouseId: r.warehouseId,
        binId: r.binId,
      }));
    });
  }

  /** Sets (or with null clears) the default bin of an item in the bin's warehouse. */
  setDefaultBin(
    principal: Principal,
    itemId: string,
    binId: string | null,
    warehouseId: string,
    origin: EventOrigin,
  ) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      requireAny(ctx, [InventoryPermissions.ItemsManage]);
      if (!(await getItem(tx, ctx.organizationId, itemId)))
        throw new NotFoundError('Item not found.');
      if (binId !== null) {
        const bin = await getBin(tx, ctx.organizationId, binId);
        if (!bin || bin.status !== 'ACTIVE' || bin.warehouseId !== warehouseId) {
          throw new ValidationError([
            { path: 'binId', message: 'Choose an active bin of that warehouse.' },
          ]);
        }
      } else if (!(await getWarehouse(tx, ctx.organizationId, warehouseId))) {
        throw new ValidationError([{ path: 'warehouseId', message: 'Unknown warehouse.' }]);
      }
      await setDefaultBin(tx, {
        organizationId: ctx.organizationId,
        itemId,
        warehouseId,
        binId,
        userId: ctx.userId,
        at: this.now,
      });
      await this.audit(tx, ctx, 'item.default_bin_set', 'item', itemId, origin, {
        warehouseId,
        binId,
      });
      return { warehouseId, binId };
    });
  }

  itemsInCategory(principal: Principal, categoryId: string) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      requireAny(ctx, ITEM_VIEW);
      if (!(await getNamed(tx, itemCategories, ctx.organizationId, categoryId))) {
        throw new NotFoundError('The category was not found.');
      }
      return (await itemsOfCategory(tx, ctx.organizationId, categoryId, 500)).map((r) => r.itemId);
    });
  }
}

function sqlCount(organizationId: string, fieldId: string, removed: string[]) {
  return sql`SELECT count(*)::int AS n FROM custom_field_values
              WHERE organization_id = ${organizationId} AND field_id = ${fieldId}
                AND (value #>> '{}') = ANY(${`{${removed.map((r) => `"${r.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`}::text[])`;
}
