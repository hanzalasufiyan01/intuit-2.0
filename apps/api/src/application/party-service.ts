import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCountries } from '../modules/organizations/index.js';
import {
  clearDefaultAddress,
  clearPrimaryContact,
  deleteAddress,
  deleteContact,
  findDuplicateCandidates,
  findPartyByReference,
  getAddress,
  getContact,
  getParty,
  getPartyDetail,
  insertAddress,
  insertContact,
  insertParty,
  listParties,
  PartyPermissions,
  replacePartyRoles,
  touchParty,
  updateAddress,
  updateContact,
  updatePartyHeader,
  type AddressFields,
  type ContactFields,
  type Party,
  type PartyAddress,
  type PartyContact,
  type PartyFields,
  type PartyKind,
  type PartyRole,
  type PartyStatus,
} from '../modules/parties/index.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Unified Party/Contact master (Decisions 8, 28, 65; S4-08..S4-11, S4-13, S4-14, S4-19, S4-20).
 * Parties are archived, never deleted. Customer- or vendor-specific data does not live here.
 */

export interface PartyHeaderInput {
  kind: PartyKind;
  displayName: string | null;
  companyName: string | null;
  firstName: string | null;
  lastName: string | null;
  reference: string | null;
  tin: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
}
export type ContactInput = ContactFields;
export type AddressInput = AddressFields;

export interface CreatePartyInput extends PartyHeaderInput {
  roles: PartyRole[];
  contacts: ContactInput[];
  addresses: AddressInput[];
}

export type UpdatePartyInput = { version: number; roles?: PartyRole[] | undefined } & {
  [K in keyof PartyHeaderInput]?: PartyHeaderInput[K] | undefined;
};

/** S4-19: only these business fields are audited with values; others by name only. */
const AUDITED_VALUES = new Set(['kind', 'displayName', 'reference', 'tin', 'roles', 'status']);

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This party was changed by someone else. Reload it and apply your changes again.',
  );

function contactView(c: PartyContact) {
  return {
    id: c.id,
    firstName: c.firstName,
    lastName: c.lastName,
    jobTitle: c.jobTitle,
    email: c.email,
    phone: c.phone,
    mobile: c.mobile,
    isPrimary: c.isPrimary,
    receivesDocuments: c.receivesDocuments,
  };
}

function addressView(a: PartyAddress) {
  return {
    id: a.id,
    kind: a.kind,
    label: a.label,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    region: a.region,
    postalCode: a.postalCode,
    countryCode: a.countryCode,
    isDefault: a.isDefault,
  };
}

function partySummary(party: Party, roles: PartyRole[]) {
  return {
    id: party.id,
    kind: party.kind,
    displayName: party.displayName,
    companyName: party.companyName,
    reference: party.reference,
    tin: party.tin,
    email: party.email,
    phone: party.phone,
    status: party.status,
    roles: [...roles].sort(),
    version: party.version,
  };
}

function encodeCursor(party: Party) {
  return Buffer.from(JSON.stringify({ n: party.displayName.toLowerCase(), i: party.id })).toString(
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

export class PartyService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    partyId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'party',
      resourceId: partyId,
      metadata,
      origin,
    });
  }

  private async detail(tx: Transaction, organizationId: string, partyId: string) {
    const data = await getPartyDetail(tx, organizationId, partyId);
    if (!data) throw new NotFoundError('Party not found.');
    const p = data.party;
    return {
      ...partySummary(p, data.roles),
      firstName: p.firstName,
      lastName: p.lastName,
      website: p.website,
      notes: p.notes,
      contacts: data.contacts.map(contactView),
      addresses: data.addresses.map(addressView),
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      archivedAt: p.archivedAt?.toISOString() ?? null,
    };
  }

  private async requireParty(tx: Transaction, organizationId: string, partyId: string) {
    const party = await getParty(tx, organizationId, partyId, { forUpdate: true });
    if (!party) throw new NotFoundError('Party not found.');
    return party;
  }

  /** Display name rules (S4-08): required; an individual defaults to "first last". */
  private resolveHeader(input: PartyHeaderInput): PartyFields {
    const fallback =
      input.kind === 'individual'
        ? [input.firstName, input.lastName].filter(Boolean).join(' ').trim() || null
        : null;
    const displayName = input.displayName ?? fallback;
    if (!displayName) {
      throw new ValidationError([
        {
          path: 'displayName',
          message:
            input.kind === 'individual'
              ? 'Enter a display name or a first or last name.'
              : 'A display name is required.',
        },
      ]);
    }
    return { ...input, displayName };
  }

  private async assertReferenceFree(
    tx: Transaction,
    organizationId: string,
    reference: string | null,
    exceptPartyId?: string,
  ) {
    if (reference && (await findPartyByReference(tx, organizationId, reference, exceptPartyId))) {
      throw new ConflictError('CONFLICT', 'Another party already uses this reference.');
    }
  }

  /** Countries must exist; an inactive one may be kept but not newly selected. */
  private async assertCountries(
    tx: Transaction,
    entries: readonly { path: string; countryCode: string; previous?: string | undefined }[],
  ) {
    const countries = await getCountries(
      tx,
      entries.map((e) => e.countryCode),
    );
    const issues: ValidationIssue[] = [];
    for (const e of entries) {
      const country = countries.get(e.countryCode);
      if (!country) issues.push({ path: e.path, message: 'Unknown country.' });
      else if (!country.isActive && e.previous !== e.countryCode) {
        issues.push({ path: e.path, message: 'This country is no longer available.' });
      }
    }
    if (issues.length) throw new ValidationError(issues);
  }

  /** S4-13: possible duplicates are reported, never blocked. */
  private async duplicateWarnings(tx: Transaction, organizationId: string, party: Party) {
    const candidates = await findDuplicateCandidates(tx, organizationId, {
      displayName: party.displayName,
      tin: party.tin,
      email: party.email,
      exceptPartyId: party.id,
    });
    return candidates.length
      ? [
          {
            code: 'POSSIBLE_DUPLICATE' as const,
            message: 'Other active parties have the same name, TIN or email.',
            matches: candidates.map((c) => ({ partyId: c.id, matchedOn: c.matchedOn })),
          },
        ]
      : [];
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      search?: string | undefined;
      role?: PartyRole | undefined;
      status: 'active' | 'archived' | 'all';
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.View },
      async (tx, ctx) => {
        const status: PartyStatus | 'ALL' =
          query.status === 'all' ? 'ALL' : query.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
        const result = await listParties(tx, {
          organizationId: ctx.organizationId,
          status,
          role: query.role ?? null,
          search: query.search?.trim() || null,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const last = result.items.at(-1)?.party;
        return {
          items: result.items.map((i) => partySummary(i.party, i.roles)),
          nextCursor: result.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, partyId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.View },
      async (tx, ctx) => this.detail(tx, ctx.organizationId, partyId),
    );
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: CreatePartyInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.Create },
      async (tx, ctx) => {
        const party = await this.createInTransaction(tx, ctx, input, origin);
        return {
          ...(await this.detail(tx, ctx.organizationId, party.id)),
          warnings: await this.duplicateWarnings(tx, ctx.organizationId, party),
        };
      },
    );
  }

  /**
   * S6 (L-7): creates a party inside the caller's transaction with exactly the rules and audit
   * of the HTTP path (S4-08..S4-10, S4-19). Imports report duplicate hints themselves (S4-13).
   */
  async createInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: CreatePartyInput,
    origin: EventOrigin,
  ): Promise<Party> {
    requirePermission(ctx, PartyPermissions.Create);
    const header = this.resolveHeader(input);
    const issues: ValidationIssue[] = [];
    if (input.contacts.filter((c) => c.isPrimary).length > 1) {
      issues.push({ path: 'contacts', message: 'Only one contact person can be primary.' });
    }
    for (const kind of ['billing', 'delivery'] as const) {
      if (input.addresses.filter((a) => a.kind === kind && a.isDefault).length > 1) {
        issues.push({
          path: 'addresses',
          message: `Only one ${kind} address can be the default.`,
        });
      }
    }
    if (issues.length) throw new ValidationError(issues);
    await this.assertCountries(
      tx,
      input.addresses.map((a, i) => ({
        path: `addresses.${i}.countryCode`,
        countryCode: a.countryCode,
      })),
    );
    await this.assertReferenceFree(tx, ctx.organizationId, header.reference);

    const party = await insertParty(tx, {
      ...header,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
    });
    await replacePartyRoles(tx, ctx.organizationId, party.id, input.roles);
    for (const [i, contact] of input.contacts.entries()) {
      await insertContact(tx, ctx.organizationId, party.id, { ...contact, sortOrder: i });
    }
    for (const address of input.addresses) {
      await insertAddress(tx, ctx.organizationId, party.id, address);
    }
    await this.audit(
      tx,
      ctx,
      'party.created',
      party.id,
      {
        kind: party.kind,
        displayName: party.displayName,
        reference: party.reference,
        tin: party.tin,
        roles: [...new Set(input.roles)].sort(),
        status: party.status,
        // Personal and contact fields by name only (S4-19).
        fieldsProvided: (
          ['companyName', 'firstName', 'lastName', 'email', 'phone', 'website', 'notes'] as const
        ).filter((k) => header[k] !== null),
        contacts: input.contacts.length,
        addresses: input.addresses.length,
      },
      origin,
    );
    return party;
  }

  update(principal: Principal, partyId: string, input: UpdatePartyInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.Update },
      async (tx, ctx) => {
        const party = await this.requireParty(tx, ctx.organizationId, partyId);
        if (party.version !== input.version) throw versionConflict();
        const detail = await getPartyDetail(tx, ctx.organizationId, partyId);
        const merged: PartyHeaderInput = {
          kind: input.kind ?? party.kind,
          displayName: input.displayName === undefined ? party.displayName : input.displayName,
          companyName: input.companyName === undefined ? party.companyName : input.companyName,
          firstName: input.firstName === undefined ? party.firstName : input.firstName,
          lastName: input.lastName === undefined ? party.lastName : input.lastName,
          reference: input.reference === undefined ? party.reference : input.reference,
          tin: input.tin === undefined ? party.tin : input.tin,
          email: input.email === undefined ? party.email : input.email,
          phone: input.phone === undefined ? party.phone : input.phone,
          website: input.website === undefined ? party.website : input.website,
          notes: input.notes === undefined ? party.notes : input.notes,
        };
        const header = this.resolveHeader(merged);
        await this.assertReferenceFree(tx, ctx.organizationId, header.reference, partyId);

        const changes: Partial<PartyFields> = {};
        for (const key of Object.keys(header) as (keyof PartyFields)[]) {
          if (header[key] !== party[key]) (changes as Record<string, unknown>)[key] = header[key];
        }
        const beforeRoles = [...(detail?.roles ?? [])].sort();
        const afterRoles = input.roles ? [...new Set(input.roles)].sort() : beforeRoles;
        const rolesChanged = JSON.stringify(beforeRoles) !== JSON.stringify(afterRoles);

        const updated = await updatePartyHeader(tx, {
          organizationId: ctx.organizationId,
          partyId,
          expectedVersion: input.version,
          changes,
          userId: ctx.userId,
        });
        if (!updated) throw versionConflict();
        if (rolesChanged) await replacePartyRoles(tx, ctx.organizationId, partyId, afterRoles);

        const changedFields = [...Object.keys(changes), ...(rolesChanged ? ['roles'] : [])];
        if (changedFields.length) {
          const valueOf = (k: string) =>
            k === 'roles' ? afterRoles : (changes as Record<string, unknown>)[k];
          const beforeOf = (k: string) =>
            k === 'roles' ? beforeRoles : (party as unknown as Record<string, unknown>)[k];
          const audited = changedFields.filter((k) => AUDITED_VALUES.has(k));
          await this.audit(
            tx,
            ctx,
            'party.updated',
            partyId,
            {
              version: updated.version,
              changedFields,
              before: Object.fromEntries(audited.map((k) => [k, beforeOf(k)])),
              after: Object.fromEntries(audited.map((k) => [k, valueOf(k)])),
            },
            origin,
          );
        }
        return {
          ...(await this.detail(tx, ctx.organizationId, partyId)),
          warnings: await this.duplicateWarnings(tx, ctx.organizationId, updated),
        };
      },
    );
  }

  setStatus(principal: Principal, partyId: string, status: PartyStatus, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.Archive },
      async (tx, ctx) => {
        const party = await this.requireParty(tx, ctx.organizationId, partyId);
        if (party.status === status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `The party is already ${status.toLowerCase()}.`,
          );
        }
        const archived = status === 'ARCHIVED';
        await touchParty(tx, ctx.organizationId, partyId, ctx.userId, {
          status,
          archivedAt: archived ? this.now : null,
          archivedByUserId: archived ? ctx.userId : null,
        });
        await this.audit(
          tx,
          ctx,
          archived ? 'party.archived' : 'party.restored',
          partyId,
          { displayName: party.displayName, status },
          origin,
        );
        return this.detail(tx, ctx.organizationId, partyId);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Contact persons (S4-10)
  // ---------------------------------------------------------------------------

  addContact(principal: Principal, partyId: string, input: ContactInput, origin: EventOrigin) {
    return this.subresource(principal, partyId, (tx, ctx) =>
      this.insertContactAudited(tx, ctx, partyId, input, origin).then(() => undefined),
    );
  }

  /**
   * S6 (L-7): adds a contact person inside the caller's transaction (parties.update, as in the
   * HTTP path), making a new party version.
   */
  async addContactInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    partyId: string,
    input: ContactInput,
    origin: EventOrigin,
  ): Promise<PartyContact> {
    requirePermission(ctx, PartyPermissions.Update);
    await this.requireParty(tx, ctx.organizationId, partyId);
    const contact = await this.insertContactAudited(tx, ctx, partyId, input, origin);
    await touchParty(tx, ctx.organizationId, partyId, ctx.userId);
    return contact;
  }

  private async insertContactAudited(
    tx: Transaction,
    ctx: AuthorizationContext,
    partyId: string,
    input: ContactInput,
    origin: EventOrigin,
  ): Promise<PartyContact> {
    if (input.isPrimary) await clearPrimaryContact(tx, ctx.organizationId, partyId);
    const contact = await insertContact(tx, ctx.organizationId, partyId, input);
    await this.audit(
      tx,
      ctx,
      'party.contact_added',
      partyId,
      { contactId: contact.id, fields: providedFields(input), isPrimary: contact.isPrimary },
      origin,
    );
    return contact;
  }

  updateContact(
    principal: Principal,
    partyId: string,
    contactId: string,
    input: { [K in keyof ContactInput]?: ContactInput[K] | undefined },
    origin: EventOrigin,
  ) {
    return this.subresource(principal, partyId, async (tx, ctx) => {
      const contact = await getContact(tx, ctx.organizationId, partyId, contactId);
      if (!contact) throw new NotFoundError('Contact person not found.');
      const next = { ...contact, ...definedOnly(input) };
      if (!next.firstName && !next.lastName) {
        throw new ValidationError([
          { path: 'firstName', message: 'A contact person needs a first or last name.' },
        ]);
      }
      if (input.isPrimary && !contact.isPrimary) {
        await clearPrimaryContact(tx, ctx.organizationId, partyId);
      }
      await updateContact(tx, ctx.organizationId, contactId, definedOnly(input));
      await this.audit(
        tx,
        ctx,
        'party.contact_updated',
        partyId,
        { contactId, changedFields: Object.keys(definedOnly(input)) },
        origin,
      );
    });
  }

  removeContact(principal: Principal, partyId: string, contactId: string, origin: EventOrigin) {
    return this.subresource(principal, partyId, async (tx, ctx) => {
      const contact = await getContact(tx, ctx.organizationId, partyId, contactId);
      if (!contact) throw new NotFoundError('Contact person not found.');
      await deleteContact(tx, ctx.organizationId, contactId);
      await this.audit(
        tx,
        ctx,
        'party.contact_removed',
        partyId,
        { contactId, wasPrimary: contact.isPrimary },
        origin,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  addAddress(principal: Principal, partyId: string, input: AddressInput, origin: EventOrigin) {
    return this.subresource(principal, partyId, async (tx, ctx) => {
      await this.assertCountries(tx, [{ path: 'countryCode', countryCode: input.countryCode }]);
      if (input.isDefault) await clearDefaultAddress(tx, ctx.organizationId, partyId, input.kind);
      const address = await insertAddress(tx, ctx.organizationId, partyId, input);
      await this.audit(
        tx,
        ctx,
        'party.address_added',
        partyId,
        {
          addressId: address.id,
          kind: address.kind,
          isDefault: address.isDefault,
          fields: providedFields(input),
        },
        origin,
      );
    });
  }

  updateAddress(
    principal: Principal,
    partyId: string,
    addressId: string,
    input: { [K in keyof AddressInput]?: AddressInput[K] | undefined },
    origin: EventOrigin,
  ) {
    return this.subresource(principal, partyId, async (tx, ctx) => {
      const address = await getAddress(tx, ctx.organizationId, partyId, addressId);
      if (!address) throw new NotFoundError('Address not found.');
      const changes = definedOnly(input);
      const next = { ...address, ...changes };
      if (changes.countryCode !== undefined) {
        await this.assertCountries(tx, [
          { path: 'countryCode', countryCode: next.countryCode, previous: address.countryCode },
        ]);
      }
      if (next.isDefault && (!address.isDefault || next.kind !== address.kind)) {
        await clearDefaultAddress(tx, ctx.organizationId, partyId, next.kind);
      }
      await updateAddress(tx, ctx.organizationId, addressId, changes);
      await this.audit(
        tx,
        ctx,
        'party.address_updated',
        partyId,
        { addressId, changedFields: Object.keys(changes) },
        origin,
      );
    });
  }

  removeAddress(principal: Principal, partyId: string, addressId: string, origin: EventOrigin) {
    return this.subresource(principal, partyId, async (tx, ctx) => {
      const address = await getAddress(tx, ctx.organizationId, partyId, addressId);
      if (!address) throw new NotFoundError('Address not found.');
      await deleteAddress(tx, ctx.organizationId, addressId);
      await this.audit(
        tx,
        ctx,
        'party.address_removed',
        partyId,
        { addressId, kind: address.kind, wasDefault: address.isDefault },
        origin,
      );
    });
  }

  /** Contacts and addresses change under parties.update and make a new party version. */
  private subresource(
    principal: Principal,
    partyId: string,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<void>,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PartyPermissions.Update },
      async (tx, ctx) => {
        await this.requireParty(tx, ctx.organizationId, partyId);
        await work(tx, ctx);
        await touchParty(tx, ctx.organizationId, partyId, ctx.userId);
        return this.detail(tx, ctx.organizationId, partyId);
      },
    );
  }
}

type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

function definedOnly<T extends object>(input: T): Defined<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** Field names that carry a value (S4-19: names, never personal values). */
function providedFields(input: object): string[] {
  return Object.entries(input)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'boolean')
    .map(([k]) => k);
}
