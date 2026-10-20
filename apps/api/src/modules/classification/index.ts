/**
 * Classification (migration 0088, master specification sections 10, 16 and 18): customer groups,
 * custom fields on customers, product categories and barcodes. Side tables only; the customer and
 * item records are untouched.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

const entityColumns = {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  status: text('status', { enum: ['ACTIVE', 'ARCHIVED'] })
    .notNull()
    .default('ACTIVE'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
};

export const customerGroups = pgTable('customer_groups', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const customerGroupMembers = pgTable('customer_group_members', {
  organizationId: uuid('organization_id').notNull(),
  customerId: uuid('customer_id').primaryKey(),
  groupId: uuid('group_id').notNull(),
  setByUserId: uuid('set_by_user_id').notNull(),
  setAt: timestamptz('set_at').notNull(),
});

export const customFieldTypes = ['text', 'number', 'date', 'boolean', 'list'] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];
export const customFieldDefinitions = pgTable('custom_field_definitions', {
  ...entityColumns,
  entity: text('entity', { enum: ['customer'] }).notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  fieldType: text('field_type', { enum: customFieldTypes }).notNull(),
  options: jsonb('options').$type<string[] | null>(),
  sortOrder: integer('sort_order').notNull().default(0),
});
export const customFieldValues = pgTable('custom_field_values', {
  organizationId: uuid('organization_id').notNull(),
  fieldId: uuid('field_id').notNull(),
  recordId: uuid('record_id').notNull(),
  value: jsonb('value').$type<string | number | boolean>().notNull(),
  updatedByUserId: uuid('updated_by_user_id').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const itemCategories = pgTable('item_categories', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const itemCategoryAssignments = pgTable('item_category_assignments', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').primaryKey(),
  categoryId: uuid('category_id').notNull(),
  setByUserId: uuid('set_by_user_id').notNull(),
  setAt: timestamptz('set_at').notNull(),
});
export const itemBarcodes = pgTable('item_barcodes', {
  organizationId: uuid('organization_id').notNull(),
  barcode: text('barcode').notNull(),
  itemId: uuid('item_id').notNull(),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
});

export const variantGroups = pgTable('variant_groups', {
  ...entityColumns,
  name: text('name').notNull(),
});
export const variantGroupMembers = pgTable('variant_group_members', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').primaryKey(),
  groupId: uuid('group_id').notNull(),
  attributes: jsonb('attributes').$type<Record<string, string>>().notNull(),
  setByUserId: uuid('set_by_user_id').notNull(),
  setAt: timestamptz('set_at').notNull(),
});
export const warehouseBins = pgTable('warehouse_bins', {
  ...entityColumns,
  warehouseId: uuid('warehouse_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull().default(''),
});
export const itemDefaultBins = pgTable('item_default_bins', {
  organizationId: uuid('organization_id').notNull(),
  itemId: uuid('item_id').notNull(),
  warehouseId: uuid('warehouse_id').notNull(),
  binId: uuid('bin_id').notNull(),
  setByUserId: uuid('set_by_user_id').notNull(),
  setAt: timestamptz('set_at').notNull(),
});

export type CustomerGroup = typeof customerGroups.$inferSelect;
export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;
export type ItemCategory = typeof itemCategories.$inferSelect;

// ---------------------------------------------------------------------------
// Named, versioned lists (groups and categories share one shape)
// ---------------------------------------------------------------------------

type NamedTable = typeof customerGroups | typeof itemCategories | typeof variantGroups;

export async function listNamed(tx: Transaction, table: NamedTable, organizationId: string) {
  return tx
    .select()
    .from(table)
    .where(eq(table.organizationId, organizationId))
    .orderBy(asc(sql`lower(${table.name})`), asc(table.id));
}

export async function getNamed(
  tx: Transaction,
  table: NamedTable,
  organizationId: string,
  id: string,
) {
  const [row] = await tx
    .select()
    .from(table)
    .where(and(eq(table.organizationId, organizationId), eq(table.id, id)));
  return row;
}

export async function insertNamed(
  tx: Transaction,
  table: NamedTable,
  input: { organizationId: string; name: string; userId: string; at: Date },
) {
  const [row] = await tx
    .insert(table)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.at,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function updateNamed(
  tx: Transaction,
  table: NamedTable,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' };
    userId: string;
    at: Date;
  },
) {
  const [row] = await tx
    .update(table)
    .set({
      ...input.set,
      version: sql`${table.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.id, input.id),
        eq(table.version, input.version),
      ),
    )
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Memberships and assignments
// ---------------------------------------------------------------------------

export async function groupOfCustomer(tx: Transaction, organizationId: string, customerId: string) {
  const [row] = await tx
    .select()
    .from(customerGroupMembers)
    .where(
      and(
        eq(customerGroupMembers.organizationId, organizationId),
        eq(customerGroupMembers.customerId, customerId),
      ),
    );
  return row;
}

export async function setCustomerGroup(
  tx: Transaction,
  input: {
    organizationId: string;
    customerId: string;
    groupId: string | null;
    userId: string;
    at: Date;
  },
) {
  if (input.groupId === null) {
    await tx
      .delete(customerGroupMembers)
      .where(
        and(
          eq(customerGroupMembers.organizationId, input.organizationId),
          eq(customerGroupMembers.customerId, input.customerId),
        ),
      );
    return;
  }
  await tx
    .insert(customerGroupMembers)
    .values({
      organizationId: input.organizationId,
      customerId: input.customerId,
      groupId: input.groupId,
      setByUserId: input.userId,
      setAt: input.at,
    })
    .onConflictDoUpdate({
      target: customerGroupMembers.customerId,
      set: { groupId: input.groupId, setByUserId: input.userId, setAt: input.at },
    });
}

export async function customersOfGroup(
  tx: Transaction,
  organizationId: string,
  groupId: string,
  limit: number,
) {
  return tx
    .select({ customerId: customerGroupMembers.customerId })
    .from(customerGroupMembers)
    .where(
      and(
        eq(customerGroupMembers.organizationId, organizationId),
        eq(customerGroupMembers.groupId, groupId),
      ),
    )
    .orderBy(asc(customerGroupMembers.customerId))
    .limit(limit);
}

export async function memberCounts(
  tx: Transaction,
  table: 'groups' | 'categories' | 'variants',
  organizationId: string,
) {
  const result =
    table === 'groups'
      ? await tx.execute<{ id: string; n: number }>(sql`
          SELECT group_id AS id, count(*)::int AS n FROM customer_group_members
           WHERE organization_id = ${organizationId} GROUP BY group_id`)
      : table === 'variants'
        ? await tx.execute<{ id: string; n: number }>(sql`
          SELECT group_id AS id, count(*)::int AS n FROM variant_group_members
           WHERE organization_id = ${organizationId} GROUP BY group_id`)
        : await tx.execute<{ id: string; n: number }>(sql`
          SELECT category_id AS id, count(*)::int AS n FROM item_category_assignments
           WHERE organization_id = ${organizationId} GROUP BY category_id`);
  return new Map(result.rows.map((r) => [r.id, r.n]));
}

export async function categoryOfItem(tx: Transaction, organizationId: string, itemId: string) {
  const [row] = await tx
    .select()
    .from(itemCategoryAssignments)
    .where(
      and(
        eq(itemCategoryAssignments.organizationId, organizationId),
        eq(itemCategoryAssignments.itemId, itemId),
      ),
    );
  return row;
}

export async function setItemCategory(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    categoryId: string | null;
    userId: string;
    at: Date;
  },
) {
  if (input.categoryId === null) {
    await tx
      .delete(itemCategoryAssignments)
      .where(
        and(
          eq(itemCategoryAssignments.organizationId, input.organizationId),
          eq(itemCategoryAssignments.itemId, input.itemId),
        ),
      );
    return;
  }
  await tx
    .insert(itemCategoryAssignments)
    .values({
      organizationId: input.organizationId,
      itemId: input.itemId,
      categoryId: input.categoryId,
      setByUserId: input.userId,
      setAt: input.at,
    })
    .onConflictDoUpdate({
      target: itemCategoryAssignments.itemId,
      set: { categoryId: input.categoryId, setByUserId: input.userId, setAt: input.at },
    });
}

export async function itemsOfCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
  limit: number,
) {
  return tx
    .select({ itemId: itemCategoryAssignments.itemId })
    .from(itemCategoryAssignments)
    .where(
      and(
        eq(itemCategoryAssignments.organizationId, organizationId),
        eq(itemCategoryAssignments.categoryId, categoryId),
      ),
    )
    .orderBy(asc(itemCategoryAssignments.itemId))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Barcodes
// ---------------------------------------------------------------------------

export async function barcodesOfItem(tx: Transaction, organizationId: string, itemId: string) {
  const rows = await tx
    .select({ barcode: itemBarcodes.barcode })
    .from(itemBarcodes)
    .where(and(eq(itemBarcodes.organizationId, organizationId), eq(itemBarcodes.itemId, itemId)))
    .orderBy(asc(itemBarcodes.barcode));
  return rows.map((r) => r.barcode);
}

export async function itemOfBarcode(tx: Transaction, organizationId: string, barcode: string) {
  const [row] = await tx
    .select()
    .from(itemBarcodes)
    .where(and(eq(itemBarcodes.organizationId, organizationId), eq(itemBarcodes.barcode, barcode)));
  return row;
}

export async function barcodesTakenByOthers(
  tx: Transaction,
  organizationId: string,
  barcodes: string[],
  exceptItemId: string,
) {
  if (barcodes.length === 0) return [];
  const rows = await tx
    .select({ barcode: itemBarcodes.barcode, itemId: itemBarcodes.itemId })
    .from(itemBarcodes)
    .where(
      and(eq(itemBarcodes.organizationId, organizationId), inArray(itemBarcodes.barcode, barcodes)),
    );
  return rows.filter((r) => r.itemId !== exceptItemId).map((r) => r.barcode);
}

export async function replaceBarcodes(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    barcodes: string[];
    userId: string;
    at: Date;
  },
) {
  await tx
    .delete(itemBarcodes)
    .where(
      and(
        eq(itemBarcodes.organizationId, input.organizationId),
        eq(itemBarcodes.itemId, input.itemId),
      ),
    );
  if (input.barcodes.length) {
    await tx.insert(itemBarcodes).values(
      input.barcodes.map((barcode) => ({
        organizationId: input.organizationId,
        barcode,
        itemId: input.itemId,
        createdByUserId: input.userId,
        createdAt: input.at,
      })),
    );
  }
}

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

export async function listFieldDefinitions(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.organizationId, organizationId),
        eq(customFieldDefinitions.entity, 'customer'),
      ),
    )
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.key));
}

export async function getFieldDefinition(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.organizationId, organizationId),
        eq(customFieldDefinitions.id, id),
      ),
    );
  return row;
}

export async function insertFieldDefinition(
  tx: Transaction,
  input: {
    organizationId: string;
    key: string;
    label: string;
    fieldType: CustomFieldType;
    options: string[] | null;
    sortOrder: number;
    userId: string;
    at: Date;
  },
) {
  const [row] = await tx
    .insert(customFieldDefinitions)
    .values({
      organizationId: input.organizationId,
      entity: 'customer',
      key: input.key,
      label: input.label,
      fieldType: input.fieldType,
      options: input.options,
      sortOrder: input.sortOrder,
      createdByUserId: input.userId,
      createdAt: input.at,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function updateFieldDefinition(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: {
      label?: string;
      options?: string[];
      sortOrder?: number;
      status?: 'ACTIVE' | 'ARCHIVED';
    };
    userId: string;
    at: Date;
  },
) {
  const [row] = await tx
    .update(customFieldDefinitions)
    .set({
      ...input.set,
      version: sql`${customFieldDefinitions.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(customFieldDefinitions.organizationId, input.organizationId),
        eq(customFieldDefinitions.id, input.id),
        eq(customFieldDefinitions.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function valuesOfRecord(tx: Transaction, organizationId: string, recordId: string) {
  return tx
    .select()
    .from(customFieldValues)
    .where(
      and(
        eq(customFieldValues.organizationId, organizationId),
        eq(customFieldValues.recordId, recordId),
      ),
    );
}

export async function setFieldValue(
  tx: Transaction,
  input: {
    organizationId: string;
    fieldId: string;
    recordId: string;
    value: string | number | boolean | null;
    userId: string;
    at: Date;
  },
) {
  if (input.value === null) {
    await tx
      .delete(customFieldValues)
      .where(
        and(
          eq(customFieldValues.organizationId, input.organizationId),
          eq(customFieldValues.fieldId, input.fieldId),
          eq(customFieldValues.recordId, input.recordId),
        ),
      );
    return;
  }
  await tx
    .insert(customFieldValues)
    .values({
      organizationId: input.organizationId,
      fieldId: input.fieldId,
      recordId: input.recordId,
      value: input.value,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .onConflictDoUpdate({
      target: [customFieldValues.fieldId, customFieldValues.recordId],
      set: { value: input.value, updatedByUserId: input.userId, updatedAt: input.at },
    });
}

// ---------------------------------------------------------------------------
// Variants (migration 0090)
// ---------------------------------------------------------------------------

export async function variantOfItem(tx: Transaction, organizationId: string, itemId: string) {
  const [row] = await tx
    .select()
    .from(variantGroupMembers)
    .where(
      and(
        eq(variantGroupMembers.organizationId, organizationId),
        eq(variantGroupMembers.itemId, itemId),
      ),
    );
  return row;
}

export async function variantsOfGroup(tx: Transaction, organizationId: string, groupId: string) {
  return tx
    .select()
    .from(variantGroupMembers)
    .where(
      and(
        eq(variantGroupMembers.organizationId, organizationId),
        eq(variantGroupMembers.groupId, groupId),
      ),
    )
    .orderBy(asc(variantGroupMembers.itemId));
}

/** True when another variant of the group already has exactly these attributes. */
export async function attributesTaken(
  tx: Transaction,
  input: {
    organizationId: string;
    groupId: string;
    attributes: Record<string, string>;
    exceptItemId: string;
  },
) {
  const result = await tx.execute<{ item_id: string }>(sql`
    SELECT item_id FROM variant_group_members
     WHERE organization_id = ${input.organizationId} AND group_id = ${input.groupId}
       AND attributes = ${JSON.stringify(input.attributes)}::jsonb AND item_id <> ${input.exceptItemId}
     LIMIT 1`);
  return result.rows.length > 0;
}

export async function setVariant(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    groupId: string | null;
    attributes: Record<string, string>;
    userId: string;
    at: Date;
  },
) {
  if (input.groupId === null) {
    await tx
      .delete(variantGroupMembers)
      .where(
        and(
          eq(variantGroupMembers.organizationId, input.organizationId),
          eq(variantGroupMembers.itemId, input.itemId),
        ),
      );
    return;
  }
  await tx
    .insert(variantGroupMembers)
    .values({
      organizationId: input.organizationId,
      itemId: input.itemId,
      groupId: input.groupId,
      attributes: input.attributes,
      setByUserId: input.userId,
      setAt: input.at,
    })
    .onConflictDoUpdate({
      target: variantGroupMembers.itemId,
      set: {
        groupId: input.groupId,
        attributes: input.attributes,
        setByUserId: input.userId,
        setAt: input.at,
      },
    });
}

// ---------------------------------------------------------------------------
// Bins (migration 0090)
// ---------------------------------------------------------------------------

export async function listBins(tx: Transaction, organizationId: string, warehouseId?: string) {
  return tx
    .select()
    .from(warehouseBins)
    .where(
      warehouseId
        ? and(
            eq(warehouseBins.organizationId, organizationId),
            eq(warehouseBins.warehouseId, warehouseId),
          )
        : eq(warehouseBins.organizationId, organizationId),
    )
    .orderBy(asc(warehouseBins.warehouseId), asc(sql`lower(${warehouseBins.code})`));
}

export async function getBin(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(warehouseBins)
    .where(and(eq(warehouseBins.organizationId, organizationId), eq(warehouseBins.id, id)));
  return row;
}

export async function insertBin(
  tx: Transaction,
  input: {
    organizationId: string;
    warehouseId: string;
    code: string;
    name: string;
    userId: string;
    at: Date;
  },
) {
  const [row] = await tx
    .insert(warehouseBins)
    .values({
      organizationId: input.organizationId,
      warehouseId: input.warehouseId,
      code: input.code,
      name: input.name,
      createdByUserId: input.userId,
      createdAt: input.at,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function updateBin(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: { name?: string; status?: 'ACTIVE' | 'ARCHIVED' };
    userId: string;
    at: Date;
  },
) {
  const [row] = await tx
    .update(warehouseBins)
    .set({
      ...input.set,
      version: sql`${warehouseBins.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(warehouseBins.organizationId, input.organizationId),
        eq(warehouseBins.id, input.id),
        eq(warehouseBins.version, input.version),
      ),
    )
    .returning();
  return row;
}

export async function defaultBinsOfItem(tx: Transaction, organizationId: string, itemId: string) {
  return tx
    .select()
    .from(itemDefaultBins)
    .where(
      and(eq(itemDefaultBins.organizationId, organizationId), eq(itemDefaultBins.itemId, itemId)),
    );
}

export async function setDefaultBin(
  tx: Transaction,
  input: {
    organizationId: string;
    itemId: string;
    warehouseId: string;
    binId: string | null;
    userId: string;
    at: Date;
  },
) {
  if (input.binId === null) {
    await tx
      .delete(itemDefaultBins)
      .where(
        and(
          eq(itemDefaultBins.organizationId, input.organizationId),
          eq(itemDefaultBins.itemId, input.itemId),
          eq(itemDefaultBins.warehouseId, input.warehouseId),
        ),
      );
    return;
  }
  await tx
    .insert(itemDefaultBins)
    .values({
      organizationId: input.organizationId,
      itemId: input.itemId,
      warehouseId: input.warehouseId,
      binId: input.binId,
      setByUserId: input.userId,
      setAt: input.at,
    })
    .onConflictDoUpdate({
      target: [itemDefaultBins.itemId, itemDefaultBins.warehouseId],
      set: { binId: input.binId, setByUserId: input.userId, setAt: input.at },
    });
}
