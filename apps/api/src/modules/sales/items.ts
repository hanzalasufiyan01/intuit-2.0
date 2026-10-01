import { and, asc, eq, gt, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { salesItems, type SalesItemStatus } from './schema.js';

/** Items catalog data access (D4, Decision 31). No inventory. */

export type SalesItem = typeof salesItems.$inferSelect;
export type SalesItemFields = Pick<
  SalesItem,
  'sku' | 'name' | 'itemType' | 'description' | 'unitPrice' | 'revenueAccountId' | 'taxCodeId'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(salesItems.organizationId, organizationId), eq(salesItems.id, id));

/** Escapes LIKE wildcards so user text matches literally. */
export function likeContains(text: string) {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function getItem(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<SalesItem | undefined> {
  const query = tx.select().from(salesItems).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function findItemBySku(
  tx: Transaction,
  organizationId: string,
  sku: string,
  exceptId?: string,
): Promise<SalesItem | undefined> {
  const [row] = await tx
    .select()
    .from(salesItems)
    .where(
      and(
        eq(salesItems.organizationId, organizationId),
        sql`lower(${salesItems.sku}) = lower(${sku})`,
        exceptId ? sql`${salesItems.id} <> ${exceptId}` : undefined,
      ),
    )
    .limit(1);
  return row;
}

export interface ItemListQuery {
  organizationId: string;
  status: SalesItemStatus | 'ALL';
  search: string | null;
  limit: number;
  after: { name: string; id: string } | null;
}

/** Keyset pagination by (lower(name), id); search matches name, SKU or description. */
export async function listItems(tx: Transaction, query: ItemListQuery) {
  const conditions: (SQL | undefined)[] = [eq(salesItems.organizationId, query.organizationId)];
  if (query.status !== 'ALL') conditions.push(eq(salesItems.status, query.status));
  if (query.search) {
    const pattern = likeContains(query.search);
    conditions.push(
      or(
        ilike(salesItems.name, pattern),
        ilike(salesItems.sku, pattern),
        ilike(salesItems.description, pattern),
      ),
    );
  }
  if (query.after) {
    conditions.push(
      or(
        gt(sql`lower(${salesItems.name})`, query.after.name),
        and(
          eq(sql`lower(${salesItems.name})`, query.after.name),
          gt(salesItems.id, query.after.id),
        ),
      ),
    );
  }
  const rows = await tx
    .select()
    .from(salesItems)
    .where(and(...conditions))
    .orderBy(asc(sql`lower(${salesItems.name})`), asc(salesItems.id))
    .limit(query.limit + 1);
  return { items: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
}

export async function insertItem(
  tx: Transaction,
  input: SalesItemFields & { organizationId: string; userId: string; now: Date },
): Promise<SalesItem> {
  const { organizationId, userId, now, ...fields } = input;
  const [row] = await tx
    .insert(salesItems)
    .values({
      ...fields,
      organizationId,
      createdByUserId: userId,
      createdAt: now,
      updatedByUserId: userId,
      updatedAt: now,
    })
    .returning();
  return row!;
}

export async function updateItem(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<SalesItemFields & Pick<SalesItem, 'status' | 'archivedAt' | 'archivedByUserId'>>;
    userId: string;
    now: Date;
  },
): Promise<SalesItem | undefined> {
  const [row] = await tx
    .update(salesItems)
    .set({
      ...input.set,
      version: sql`${salesItems.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(and(scoped(input.organizationId, input.id), eq(salesItems.version, input.version)))
    .returning();
  return row;
}
