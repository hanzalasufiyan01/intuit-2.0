import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { vendors, type VendorStatus } from './schema.js';

/** Vendor data access (ADR 0004 P4-03; Decisions 8, 28; R36). Identity lives on the Party. */

export type Vendor = typeof vendors.$inferSelect;
export type VendorFields = Pick<
  Vendor,
  | 'currencyCode'
  | 'paymentTermsDays'
  | 'creditLimit'
  | 'accountNumber'
  | 'defaultExpenseAccountId'
  | 'defaultTaxCodeId'
  | 'defaultTaxRecoverable'
>;

const scoped = (organizationId: string, id: string) =>
  and(eq(vendors.organizationId, organizationId), eq(vendors.id, id));

export async function getVendor(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<Vendor | undefined> {
  const query = tx.select().from(vendors).where(scoped(organizationId, id));
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getVendorByParty(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<Vendor | undefined> {
  const [row] = await tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.organizationId, organizationId), eq(vendors.partyId, partyId)));
  return row;
}

export async function listVendorsByParty(
  tx: Transaction,
  organizationId: string,
  partyIds: readonly string[],
): Promise<Vendor[]> {
  if (partyIds.length === 0) return [];
  return tx
    .select()
    .from(vendors)
    .where(
      and(eq(vendors.organizationId, organizationId), inArray(vendors.partyId, [...partyIds])),
    );
}

/** The party ids of an organization's vendors, as a subquery for party listings. */
export function vendorPartyIds(organizationId: string, status: VendorStatus | 'ALL'): SQL {
  return status === 'ALL'
    ? sql`SELECT v.party_id FROM vendors v WHERE v.organization_id = ${organizationId}`
    : sql`SELECT v.party_id FROM vendors v WHERE v.organization_id = ${organizationId} AND v.status = ${status}`;
}

export async function insertVendor(
  tx: Transaction,
  input: VendorFields & { organizationId: string; partyId: string; userId: string; now: Date },
): Promise<Vendor | undefined> {
  const [row] = await tx
    .insert(vendors)
    .values({
      organizationId: input.organizationId,
      partyId: input.partyId,
      currencyCode: input.currencyCode,
      paymentTermsDays: input.paymentTermsDays,
      creditLimit: input.creditLimit,
      accountNumber: input.accountNumber,
      defaultExpenseAccountId: input.defaultExpenseAccountId,
      defaultTaxCodeId: input.defaultTaxCodeId,
      defaultTaxRecoverable: input.defaultTaxRecoverable,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export async function updateVendor(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<VendorFields & Pick<Vendor, 'status' | 'archivedAt' | 'archivedByUserId'>>;
    userId: string;
    now: Date;
  },
): Promise<Vendor | undefined> {
  const [row] = await tx
    .update(vendors)
    .set({
      ...input.set,
      version: sql`${vendors.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    .where(and(scoped(input.organizationId, input.id), eq(vendors.version, input.version)))
    .returning();
  return row;
}

/** Vendors of the given parties (a name search through the parties module). */
export function vendorIdsOfParties(organizationId: string, partyIds: SQL): SQL {
  return sql`SELECT v.id FROM vendors v WHERE v.organization_id = ${organizationId}
               AND v.party_id IN (${partyIds})`;
}
