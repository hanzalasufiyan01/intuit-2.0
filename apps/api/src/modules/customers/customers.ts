import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { customers, type CustomerStatus } from './schema.js';

/** Customer data access (Decisions 8, 28, 48). Identity lives on the Party (R36). */

export type Customer = typeof customers.$inferSelect;
export type CustomerFields = Pick<Customer, 'currencyCode' | 'paymentTermsDays' | 'creditLimit'>;

const scoped = (organizationId: string, id: string) =>
  and(eq(customers.organizationId, organizationId), eq(customers.id, id));

export async function getCustomer(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Customer | undefined> {
  const query = tx.select().from(customers).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getCustomerByParty(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<Customer | undefined> {
  const [row] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.organizationId, organizationId), eq(customers.partyId, partyId)));
  return row;
}

export async function listCustomersByParty(
  tx: Transaction,
  organizationId: string,
  partyIds: readonly string[],
): Promise<Customer[]> {
  if (partyIds.length === 0) return [];
  return tx
    .select()
    .from(customers)
    .where(
      and(eq(customers.organizationId, organizationId), inArray(customers.partyId, [...partyIds])),
    );
}

/** The party ids of an organization's customers, as a subquery for party listings. */
export function customerPartyIds(organizationId: string, status: CustomerStatus | 'ALL'): SQL {
  return status === 'ALL'
    ? sql`SELECT c.party_id FROM customers c WHERE c.organization_id = ${organizationId}`
    : sql`SELECT c.party_id FROM customers c WHERE c.organization_id = ${organizationId} AND c.status = ${status}`;
}

export async function insertCustomer(
  tx: Transaction,
  input: CustomerFields & { organizationId: string; partyId: string; userId: string; now: Date },
): Promise<Customer | undefined> {
  const [row] = await tx
    .insert(customers)
    .values({
      organizationId: input.organizationId,
      partyId: input.partyId,
      currencyCode: input.currencyCode,
      paymentTermsDays: input.paymentTermsDays,
      creditLimit: input.creditLimit,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function updateCustomer(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<CustomerFields & Pick<Customer, 'status' | 'archivedAt' | 'archivedByUserId'>>;
    userId: string;
    now: Date;
  },
): Promise<Customer | undefined> {
  const [row] = await tx
    .update(customers)
    .set({
      ...input.set,
      version: sql`${customers.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(and(scoped(input.organizationId, input.id), eq(customers.version, input.version)))
    .returning();
  return row;
}

/** Customer ids of the parties a subquery selects (e.g. a name search). */
export function customerIdsOfParties(organizationId: string, partyIds: SQL): SQL {
  return sql`SELECT c.id FROM customers c WHERE c.organization_id = ${organizationId}
               AND c.party_id IN (${partyIds})`;
}
