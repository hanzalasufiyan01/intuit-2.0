import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  countries,
  organizationAddresses,
  organizationProfiles,
  type OrganizationAddressKind,
  type ProfileIdentifier,
} from './schema.js';

/**
 * Organization legal profile (Decision 17; S4-01..S4-07, S4-14) and the country reference data
 * (S4-05). One profile per organization, created only when an authorized user saves it.
 */

export type Country = typeof countries.$inferSelect;
export type OrganizationProfile = typeof organizationProfiles.$inferSelect;
export type OrganizationAddress = typeof organizationAddresses.$inferSelect;

export interface AddressInput {
  line1: string;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
}

export interface ProfileValues {
  legalName: string;
  tradingName: string | null;
  tin: string | null;
  gstRegistered: boolean;
  gstRegistrationNumber: string | null;
  gstRegisteredFrom: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  identifiers: ProfileIdentifier[];
  addresses: Partial<Record<OrganizationAddressKind, AddressInput | null>>;
}

export async function listCountries(tx: Transaction): Promise<Country[]> {
  return tx.select().from(countries).orderBy(asc(countries.name));
}

/** Countries by code (any status); callers decide whether inactive ones are acceptable. */
export async function getCountries(
  tx: Transaction,
  codes: readonly string[],
): Promise<Map<string, Country>> {
  const unique = [...new Set(codes)];
  if (unique.length === 0) return new Map();
  const rows = await tx.select().from(countries).where(inArray(countries.code, unique));
  return new Map(rows.map((c) => [c.code, c]));
}

export async function getOrganizationProfile(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<{ profile: OrganizationProfile; addresses: OrganizationAddress[] } | null> {
  const query = tx
    .select()
    .from(organizationProfiles)
    .where(eq(organizationProfiles.organizationId, organizationId))
    .limit(1);
  const [profile] = options.forUpdate ? await query.for('update') : await query;
  if (!profile) return null;
  const addresses = await tx
    .select()
    .from(organizationAddresses)
    .where(eq(organizationAddresses.organizationId, organizationId));
  return { profile, addresses };
}

/**
 * Saves the profile when `expectedVersion` matches (0 = not yet created). Returns undefined on
 * a version conflict (S4-14). Addresses given as null are removed; omitted kinds are unchanged.
 */
export async function saveOrganizationProfile(
  tx: Transaction,
  input: {
    organizationId: string;
    expectedVersion: number;
    values: ProfileValues;
    userId: string;
  },
): Promise<OrganizationProfile | undefined> {
  const { addresses, ...fields } = input.values;
  let saved: OrganizationProfile | undefined;
  if (input.expectedVersion === 0) {
    [saved] = await tx
      .insert(organizationProfiles)
      .values({ organizationId: input.organizationId, ...fields, updatedByUserId: input.userId })
      .onConflictDoNothing()
      .returning();
  } else {
    [saved] = await tx
      .update(organizationProfiles)
      .set({
        ...fields,
        updatedByUserId: input.userId,
        version: sql`${organizationProfiles.version} + 1`,
      })
      .where(
        and(
          eq(organizationProfiles.organizationId, input.organizationId),
          eq(organizationProfiles.version, input.expectedVersion),
        ),
      )
      .returning();
  }
  if (!saved) return undefined;
  for (const [kind, address] of Object.entries(addresses) as [
    OrganizationAddressKind,
    AddressInput | null | undefined,
  ][]) {
    if (address === undefined) continue;
    await tx
      .delete(organizationAddresses)
      .where(
        and(
          eq(organizationAddresses.organizationId, input.organizationId),
          eq(organizationAddresses.kind, kind),
        ),
      );
    if (address) {
      await tx
        .insert(organizationAddresses)
        .values({ organizationId: input.organizationId, kind, ...address });
    }
  }
  return saved;
}

/**
 * Sets or clears the organization logo (S4-03, S5-12). The logo is managed through its own
 * endpoints and does not bump the profile version.
 */
export async function setOrganizationLogo(
  tx: Transaction,
  organizationId: string,
  fileId: string | null,
): Promise<void> {
  await tx
    .update(organizationProfiles)
    .set({ logoFileId: fileId })
    .where(eq(organizationProfiles.organizationId, organizationId));
}
