import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  parties,
  partyAddresses,
  partyContacts,
  partyRolesTable,
  type PartyAddressKind,
  type PartyRole,
  type PartyStatus,
} from './schema.js';

/** Persistence for the Party master. Only this module writes these tables (S4-01). */

export type Party = typeof parties.$inferSelect;
export type PartyContact = typeof partyContacts.$inferSelect;
export type PartyAddress = typeof partyAddresses.$inferSelect;

export type PartyFields = Pick<
  Party,
  | 'kind'
  | 'displayName'
  | 'companyName'
  | 'firstName'
  | 'lastName'
  | 'reference'
  | 'tin'
  | 'email'
  | 'phone'
  | 'website'
  | 'notes'
>;
export type ContactFields = Pick<
  PartyContact,
  | 'firstName'
  | 'lastName'
  | 'jobTitle'
  | 'email'
  | 'phone'
  | 'mobile'
  | 'isPrimary'
  | 'receivesDocuments'
>;
export type AddressFields = Pick<
  PartyAddress,
  | 'kind'
  | 'label'
  | 'line1'
  | 'line2'
  | 'city'
  | 'region'
  | 'postalCode'
  | 'countryCode'
  | 'isDefault'
>;

const scoped = (organizationId: string, partyId: string) =>
  and(eq(parties.organizationId, organizationId), eq(parties.id, partyId));

export async function insertParty(
  tx: Transaction,
  input: PartyFields & { organizationId: string; userId: string },
): Promise<Party> {
  const { userId, ...values } = input;
  const [row] = await tx
    .insert(parties)
    .values({ ...values, createdByUserId: userId, updatedByUserId: userId })
    .returning();
  return row!;
}

export async function getParty(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  options: { forUpdate?: boolean } = {},
): Promise<Party | undefined> {
  const query = tx.select().from(parties).where(scoped(organizationId, partyId)).limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function getPartyDetail(tx: Transaction, organizationId: string, partyId: string) {
  const party = await getParty(tx, organizationId, partyId);
  if (!party) return undefined;
  const [roles, contacts, addresses] = await Promise.all([
    tx
      .select({ role: partyRolesTable.role })
      .from(partyRolesTable)
      .where(
        and(
          eq(partyRolesTable.organizationId, organizationId),
          eq(partyRolesTable.partyId, partyId),
        ),
      ),
    tx
      .select()
      .from(partyContacts)
      .where(
        and(eq(partyContacts.organizationId, organizationId), eq(partyContacts.partyId, partyId)),
      )
      .orderBy(asc(partyContacts.sortOrder), asc(partyContacts.createdAt)),
    tx
      .select()
      .from(partyAddresses)
      .where(
        and(eq(partyAddresses.organizationId, organizationId), eq(partyAddresses.partyId, partyId)),
      )
      .orderBy(asc(partyAddresses.kind), asc(partyAddresses.createdAt)),
  ]);
  return { party, roles: roles.map((r) => r.role), contacts, addresses };
}

/** Updates header fields when `expectedVersion` matches (S4-14); undefined on conflict. */
export async function updatePartyHeader(
  tx: Transaction,
  input: {
    organizationId: string;
    partyId: string;
    expectedVersion: number;
    changes: Partial<PartyFields>;
    userId: string;
  },
): Promise<Party | undefined> {
  const [row] = await tx
    .update(parties)
    .set({ ...input.changes, updatedByUserId: input.userId, version: sql`${parties.version} + 1` })
    .where(
      and(scoped(input.organizationId, input.partyId), eq(parties.version, input.expectedVersion)),
    )
    .returning();
  return row;
}

/** Any change to a party's contacts, addresses or status is a new version of the party. */
export async function touchParty(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  userId: string,
  set: Partial<Pick<Party, 'status' | 'archivedAt' | 'archivedByUserId'>> = {},
): Promise<Party> {
  const [row] = await tx
    .update(parties)
    .set({ ...set, updatedByUserId: userId, version: sql`${parties.version} + 1` })
    .where(scoped(organizationId, partyId))
    .returning();
  return row!;
}

export async function replacePartyRoles(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  roles: readonly PartyRole[],
): Promise<void> {
  await tx
    .delete(partyRolesTable)
    .where(
      and(eq(partyRolesTable.organizationId, organizationId), eq(partyRolesTable.partyId, partyId)),
    );
  if (roles.length) {
    await tx
      .insert(partyRolesTable)
      .values([...new Set(roles)].map((role) => ({ partyId, organizationId, role })));
  }
}

export async function findPartyByReference(
  tx: Transaction,
  organizationId: string,
  reference: string,
  exceptPartyId?: string,
): Promise<Party | undefined> {
  const [row] = await tx
    .select()
    .from(parties)
    .where(
      and(
        eq(parties.organizationId, organizationId),
        sql`lower(${parties.reference}) = lower(${reference})`,
        exceptPartyId ? ne(parties.id, exceptPartyId) : undefined,
      ),
    )
    .limit(1);
  return row;
}

/**
 * Active parties that probably duplicate the given identity (S4-13): same TIN, same email or the
 * same normalized display name. Hints only; never blocks.
 */
export async function findDuplicateCandidates(
  tx: Transaction,
  organizationId: string,
  input: { displayName: string; tin: string | null; email: string | null; exceptPartyId?: string },
): Promise<{ id: string; matchedOn: ('tin' | 'email' | 'name')[] }[]> {
  const normalize = (column: unknown) =>
    sql`lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;
  const tinMatch = input.tin ? sql`lower(${parties.tin}) = lower(${input.tin})` : sql`false`;
  const emailMatch = input.email
    ? sql`lower(${parties.email}) = lower(${input.email})`
    : sql`false`;
  const nameMatch = sql`${normalize(parties.displayName)} = ${normalize(sql`${input.displayName}::text`)}`;
  const rows = await tx
    .select({
      id: parties.id,
      tin: sql<boolean>`${tinMatch}`,
      email: sql<boolean>`${emailMatch}`,
      name: sql<boolean>`${nameMatch}`,
    })
    .from(parties)
    .where(
      and(
        eq(parties.organizationId, organizationId),
        eq(parties.status, 'ACTIVE'),
        input.exceptPartyId ? ne(parties.id, input.exceptPartyId) : undefined,
        or(tinMatch, emailMatch, nameMatch),
      ),
    )
    .orderBy(asc(parties.displayName))
    .limit(20);
  return rows.map((r) => ({
    id: r.id,
    matchedOn: (['tin', 'email', 'name'] as const).filter((k) => r[k]),
  }));
}

export interface PartyListQuery {
  organizationId: string;
  status: PartyStatus | 'ALL';
  role: PartyRole | null;
  search: string | null;
  limit: number;
  after: { name: string; id: string } | null;
}

/** Cursor-paginated list ordered by (lower(display_name), id); trigram-backed search (S4-15). */
export async function listParties(tx: Transaction, query: PartyListQuery) {
  const escaped = query.search
    ? query.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)
    : null;
  const rows = await tx
    .select()
    .from(parties)
    .where(
      and(
        eq(parties.organizationId, query.organizationId),
        query.status === 'ALL' ? undefined : eq(parties.status, query.status),
        query.role
          ? sql`EXISTS (SELECT 1 FROM party_roles pr WHERE pr.party_id = ${parties.id}
                  AND pr.organization_id = ${parties.organizationId} AND pr.role = ${query.role})`
          : undefined,
        escaped ? sql`search_text LIKE ${`%${escaped}%`} ESCAPE '\\'` : undefined,
        query.after
          ? sql`(lower(${parties.displayName}), ${parties.id}) > (${query.after.name}, ${query.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(sql`lower(${parties.displayName})`, asc(parties.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const ids = page.map((p) => p.id);
  const roles = ids.length
    ? await tx
        .select()
        .from(partyRolesTable)
        .where(
          and(
            eq(partyRolesTable.organizationId, query.organizationId),
            sql`${partyRolesTable.partyId} = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])`,
          ),
        )
    : [];
  return {
    items: page.map((party) => ({
      party,
      roles: roles.filter((r) => r.partyId === party.id).map((r) => r.role),
    })),
    hasMore: rows.length > query.limit,
  };
}

// ---------------------------------------------------------------------------
// Contacts (S4-10) and addresses
// ---------------------------------------------------------------------------

export async function getContact(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  contactId: string,
) {
  const [row] = await tx
    .select()
    .from(partyContacts)
    .where(
      and(
        eq(partyContacts.organizationId, organizationId),
        eq(partyContacts.partyId, partyId),
        eq(partyContacts.id, contactId),
      ),
    )
    .limit(1);
  return row;
}

/** Clears the primary flag so a new primary can be set in the same transaction. */
export async function clearPrimaryContact(
  tx: Transaction,
  organizationId: string,
  partyId: string,
) {
  await tx
    .update(partyContacts)
    .set({ isPrimary: false })
    .where(
      and(
        eq(partyContacts.organizationId, organizationId),
        eq(partyContacts.partyId, partyId),
        eq(partyContacts.isPrimary, true),
      ),
    );
}

export async function insertContact(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  values: ContactFields & { sortOrder?: number },
): Promise<PartyContact> {
  const [row] = await tx
    .insert(partyContacts)
    .values({ organizationId, partyId, ...values })
    .returning();
  return row!;
}

export async function updateContact(
  tx: Transaction,
  organizationId: string,
  contactId: string,
  changes: Partial<ContactFields>,
): Promise<PartyContact | undefined> {
  const [row] = await tx
    .update(partyContacts)
    .set(changes)
    .where(and(eq(partyContacts.organizationId, organizationId), eq(partyContacts.id, contactId)))
    .returning();
  return row;
}

export async function deleteContact(tx: Transaction, organizationId: string, contactId: string) {
  await tx
    .delete(partyContacts)
    .where(and(eq(partyContacts.organizationId, organizationId), eq(partyContacts.id, contactId)));
}

export async function getAddress(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  addressId: string,
) {
  const [row] = await tx
    .select()
    .from(partyAddresses)
    .where(
      and(
        eq(partyAddresses.organizationId, organizationId),
        eq(partyAddresses.partyId, partyId),
        eq(partyAddresses.id, addressId),
      ),
    )
    .limit(1);
  return row;
}

/** Clears the default flag of one address kind so a new default can be set. */
export async function clearDefaultAddress(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  kind: PartyAddressKind,
) {
  await tx
    .update(partyAddresses)
    .set({ isDefault: false })
    .where(
      and(
        eq(partyAddresses.organizationId, organizationId),
        eq(partyAddresses.partyId, partyId),
        eq(partyAddresses.kind, kind),
        eq(partyAddresses.isDefault, true),
      ),
    );
}

export async function insertAddress(
  tx: Transaction,
  organizationId: string,
  partyId: string,
  values: AddressFields,
): Promise<PartyAddress> {
  const [row] = await tx
    .insert(partyAddresses)
    .values({ organizationId, partyId, ...values })
    .returning();
  return row!;
}

export async function updateAddress(
  tx: Transaction,
  organizationId: string,
  addressId: string,
  changes: Partial<AddressFields>,
): Promise<PartyAddress | undefined> {
  const [row] = await tx
    .update(partyAddresses)
    .set(changes)
    .where(and(eq(partyAddresses.organizationId, organizationId), eq(partyAddresses.id, addressId)))
    .returning();
  return row;
}

export async function deleteAddress(tx: Transaction, organizationId: string, addressId: string) {
  await tx
    .delete(partyAddresses)
    .where(
      and(eq(partyAddresses.organizationId, organizationId), eq(partyAddresses.id, addressId)),
    );
}

// ---------------------------------------------------------------------------
// Bulk read contracts for imports and exports (S6)
// ---------------------------------------------------------------------------

/** Keys used by imports: reference lookups and S4-13 duplicate hints, for every party. */
export async function listPartyMatchKeys(tx: Transaction, organizationId: string) {
  return tx
    .select({
      id: parties.id,
      status: parties.status,
      reference: sql<string | null>`lower(${parties.reference})`,
      name: sql<string>`lower(regexp_replace(btrim(${parties.displayName}), '\\s+', ' ', 'g'))`,
      tin: sql<string | null>`lower(${parties.tin})`,
      email: sql<string | null>`lower(${parties.email})`,
    })
    .from(parties)
    .where(eq(parties.organizationId, organizationId));
}

/** A page of parties in display-name order (keyset: lower(display_name), id). */
export async function listPartiesPage(
  tx: Transaction,
  organizationId: string,
  query: { after: { name: string; id: string } | null; limit: number },
): Promise<Party[]> {
  return tx
    .select()
    .from(parties)
    .where(
      and(
        eq(parties.organizationId, organizationId),
        query.after
          ? sql`(lower(${parties.displayName}), ${parties.id}) > (${query.after.name}, ${query.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(sql`lower(${parties.displayName})`), asc(parties.id))
    .limit(query.limit);
}

/** Roles, contacts and addresses of several parties at once (one query each). */
export async function getPartyExtras(tx: Transaction, organizationId: string, partyIds: string[]) {
  if (partyIds.length === 0) {
    return { roles: new Map<string, PartyRole[]>(), contacts: [], addresses: [] };
  }
  const [roleRows, contacts, addresses] = await Promise.all([
    tx
      .select()
      .from(partyRolesTable)
      .where(
        and(
          eq(partyRolesTable.organizationId, organizationId),
          inArray(partyRolesTable.partyId, partyIds),
        ),
      ),
    tx
      .select()
      .from(partyContacts)
      .where(
        and(
          eq(partyContacts.organizationId, organizationId),
          inArray(partyContacts.partyId, partyIds),
        ),
      )
      .orderBy(
        asc(partyContacts.partyId),
        asc(partyContacts.sortOrder),
        asc(partyContacts.createdAt),
      ),
    tx
      .select()
      .from(partyAddresses)
      .where(
        and(
          eq(partyAddresses.organizationId, organizationId),
          inArray(partyAddresses.partyId, partyIds),
        ),
      )
      .orderBy(asc(partyAddresses.partyId), asc(partyAddresses.createdAt)),
  ]);
  const roles = new Map<string, PartyRole[]>();
  for (const r of roleRows) roles.set(r.partyId, [...(roles.get(r.partyId) ?? []), r.role]);
  return { roles, contacts, addresses };
}
