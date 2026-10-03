import { Decimal } from 'decimal.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { isSupportedCurrency, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  CustomerPermissions,
  customerPartyIds,
  getCustomer,
  getCustomerByParty,
  insertCustomer,
  listCustomersByParty,
  updateCustomer,
  type Customer,
  type CustomerFields,
  type CustomerStatus,
} from '../modules/customers/index.js';
import { listParties, type Party } from '../modules/parties/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { requirePermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';
import {
  assertPartyActiveForRestore,
  decodePartyCursor,
  encodePartyCursor,
  partyForRoleRecord,
  partyIdentity,
  type PartyRoleRecordKind,
} from './party-role-records.js';
import type {
  AddressInput,
  ContactInput,
  CreatePartyInput,
  PartyAccess,
  PartyService,
  UpdatePartyInput,
} from './party-service.js';

/**
 * Customers on the shared Party master (Decisions 8, 28, 48; R36; Phase 3B D6). Identity (name,
 * TIN, contacts, addresses) stays on the Party and is edited here under `customers.update` with
 * the Party rules and audit; currency, payment terms and the warning-only credit limit live on the
 * customer. The Party holds the `customer` role for as long as the customer exists.
 */

export interface CustomerTermsInput {
  currencyCode?: string | undefined;
  paymentTermsDays?: number | null | undefined;
  creditLimit?: string | null | undefined;
}

export type CreateCustomerInput = CustomerTermsInput &
  ({ partyId: string; party?: undefined } | { party: CreatePartyInput; partyId?: undefined });

export interface UpdateCustomerInput extends CustomerTermsInput {
  version: number;
  /** Identity changes, at the party's own version. Roles are managed on the Contacts screens. */
  party?: Omit<UpdatePartyInput, 'roles'> | undefined;
}

const CUSTOMER_ACCESS: PartyAccess = { permission: CustomerPermissions.Update, role: 'customer' };

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This customer was changed by someone else. Reload it and apply your changes again.',
  );

const CUSTOMER: PartyRoleRecordKind = { role: 'customer', noun: 'customer' };

function money(value: string | null, currency: string) {
  return value === null ? null : new Decimal(value).toFixed(minorUnits(currency));
}

function customerView(customer: Customer, party: Party) {
  return {
    id: customer.id,
    partyId: party.id,
    kind: party.kind,
    displayName: party.displayName,
    companyName: party.companyName,
    reference: party.reference,
    tin: party.tin,
    email: party.email,
    phone: party.phone,
    partyStatus: party.status,
    partyVersion: party.version,
    currencyCode: customer.currencyCode,
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: money(customer.creditLimit, customer.currencyCode),
    status: customer.status,
    version: customer.version,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
    archivedAt: customer.archivedAt?.toISOString() ?? null,
  };
}

export class CustomerService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly parties: PartyService,
  ) {
    // A party keeps its customer role while it has a customer record.
    parties.registerRoleGuard('customer', async (tx, organizationId, partyId) =>
      (await getCustomerByParty(tx, organizationId, partyId))
        ? 'This contact is a customer. Archive the customer instead of removing the role.'
        : null,
    );
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    customerId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'customer',
      resourceId: customerId,
      metadata,
      origin,
    });
  }

  private async detail(tx: Transaction, organizationId: string, customer: Customer) {
    const { row, extra } = await partyIdentity(this.parties, tx, organizationId, customer.partyId);
    return { ...customerView(customer, row), ...extra };
  }

  private async requireCustomer(tx: Transaction, organizationId: string, id: string) {
    const customer = await getCustomer(tx, organizationId, id, { forUpdate: true });
    if (!customer) throw new NotFoundError('Customer not found.');
    return customer;
  }

  /** Validates and normalizes the customer-specific fields. */
  private terms(
    input: CustomerTermsInput,
    current: CustomerFields,
  ): { fields: CustomerFields; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const currencyCode = input.currencyCode ?? current.currencyCode;
    if (!isSupportedCurrency(currencyCode)) {
      issues.push({ path: 'currencyCode', message: 'Unsupported currency.' });
    }
    const paymentTermsDays =
      input.paymentTermsDays === undefined ? current.paymentTermsDays : input.paymentTermsDays;
    let creditLimit = input.creditLimit === undefined ? current.creditLimit : input.creditLimit;
    if (creditLimit !== null && isSupportedCurrency(currencyCode)) {
      const value = new Decimal(creditLimit);
      if (value.decimalPlaces() > minorUnits(currencyCode)) {
        issues.push({
          path: 'creditLimit',
          message: `Use at most ${minorUnits(currencyCode)} decimal places for ${currencyCode}.`,
        });
      }
      creditLimit = value.toFixed(4);
    }
    return { fields: { currencyCode, paymentTermsDays, creditLimit }, issues };
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  list(
    principal: Principal,
    query: {
      search?: string | undefined;
      status: 'active' | 'archived' | 'all';
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.View },
      async (tx, ctx) => {
        const status: CustomerStatus | 'ALL' =
          query.status === 'all' ? 'ALL' : query.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
        const page = await listParties(tx, {
          organizationId: ctx.organizationId,
          status: 'ALL',
          role: null,
          search: query.search?.trim() || null,
          limit: query.limit,
          after: query.after ? decodePartyCursor(query.after) : null,
          partyIdsIn: customerPartyIds(ctx.organizationId, status),
        });
        const rows = await listCustomersByParty(
          tx,
          ctx.organizationId,
          page.items.map((i) => i.party.id),
        );
        const byParty = new Map(rows.map((c) => [c.partyId, c]));
        const last = page.items.at(-1)?.party;
        return {
          items: page.items.map((i) => customerView(byParty.get(i.party.id)!, i.party)),
          nextCursor: page.hasMore && last ? encodePartyCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.View },
      async (tx, ctx) => {
        const customer = await getCustomer(tx, ctx.organizationId, id);
        if (!customer) throw new NotFoundError('Customer not found.');
        return this.detail(tx, ctx.organizationId, customer);
      },
    );
  }

  /** The party of a customer, for the identity sub-resources (customer → party never changes). */
  private partyOf(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.Update },
      async (tx, ctx) => (await this.requireCustomer(tx, ctx.organizationId, id)).partyId,
    );
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: CreateCustomerInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.Create },
      async (tx, ctx) => {
        const { customer, party } = await this.createInTransaction(tx, ctx, input, origin);
        return {
          ...(await this.detail(tx, ctx.organizationId, customer)),
          warnings: await this.parties.duplicateWarningsInTransaction(
            tx,
            ctx.organizationId,
            party,
          ),
        };
      },
    );
  }

  /**
   * Creates a customer inside the caller's transaction with the HTTP path's rules and audit
   * (Phase 3B step 18: the customers import commits through this).
   */
  async createInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: CreateCustomerInput,
    origin: EventOrigin,
  ): Promise<{ customer: Customer; party: Party }> {
    requirePermission(ctx, CustomerPermissions.Create);
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const { fields, issues } = this.terms(input, {
      currencyCode: settings.baseCurrency,
      paymentTermsDays: null,
      creditLimit: null,
    });
    if (issues.length) throw new ValidationError(issues);

    const { party, newParty } = await partyForRoleRecord(this.parties, tx, ctx, input, {
      kind: CUSTOMER,
      permission: CustomerPermissions.Create,
      hasRecord: async (partyId) =>
        (await getCustomerByParty(tx, ctx.organizationId, partyId)) !== undefined,
      origin,
    });

    const customer = await insertCustomer(tx, {
      ...fields,
      organizationId: ctx.organizationId,
      partyId: party.id,
      userId: ctx.userId,
      now: this.now,
    });
    if (!customer) throw new ConflictError('CONFLICT', 'This contact is already a customer.');
    await this.audit(
      tx,
      ctx,
      'customer.created',
      customer.id,
      {
        partyId: party.id,
        displayName: party.displayName,
        newParty,
        currencyCode: customer.currencyCode,
        paymentTermsDays: customer.paymentTermsDays,
        creditLimit: customer.creditLimit,
      },
      origin,
    );
    return { customer, party };
  }

  update(principal: Principal, id: string, input: UpdateCustomerInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.Update },
      async (tx, ctx) => {
        const customer = await this.requireCustomer(tx, ctx.organizationId, id);
        if (customer.version !== input.version) throw versionConflict();
        const { fields, issues } = this.terms(input, customer);
        if (issues.length) throw new ValidationError(issues);

        let party: Party | undefined;
        if (input.party) {
          party = await this.parties.updateInTransaction(
            tx,
            ctx,
            customer.partyId,
            input.party,
            origin,
            CUSTOMER_ACCESS,
          );
        }
        const changed = (Object.keys(fields) as (keyof CustomerFields)[]).filter(
          (k) => fields[k] !== customer[k],
        );
        let updated = customer;
        if (changed.length) {
          const saved = await updateCustomer(tx, {
            organizationId: ctx.organizationId,
            id,
            version: input.version,
            set: Object.fromEntries(changed.map((k) => [k, fields[k]])),
            userId: ctx.userId,
            now: this.now,
          });
          if (!saved) throw versionConflict();
          updated = saved;
          await this.audit(
            tx,
            ctx,
            'customer.updated',
            id,
            {
              version: saved.version,
              changedFields: changed,
              before: Object.fromEntries(changed.map((k) => [k, customer[k]])),
              after: Object.fromEntries(changed.map((k) => [k, fields[k]])),
            },
            origin,
          );
        }
        return {
          ...(await this.detail(tx, ctx.organizationId, updated)),
          warnings: party
            ? await this.parties.duplicateWarningsInTransaction(tx, ctx.organizationId, party)
            : [],
        };
      },
    );
  }

  /** Archived customers stay valid on existing documents but get no new ones. */
  setStatus(
    principal: Principal,
    id: string,
    input: { version: number; status: CustomerStatus },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: CustomerPermissions.Archive },
      async (tx, ctx) => {
        const customer = await this.requireCustomer(tx, ctx.organizationId, id);
        if (customer.version !== input.version) throw versionConflict();
        if (customer.status === input.status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `The customer is already ${input.status.toLowerCase()}.`,
          );
        }
        const archived = input.status === 'ARCHIVED';
        if (!archived) {
          await assertPartyActiveForRestore(tx, ctx.organizationId, customer.partyId, CUSTOMER);
        }
        const saved = await updateCustomer(tx, {
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
          archived ? 'customer.archived' : 'customer.restored',
          id,
          { partyId: customer.partyId, status: input.status },
          origin,
        );
        return this.detail(tx, ctx.organizationId, saved);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Identity sub-resources (Phase 3B D6): the Party rules and audit, under customers.update
  // ---------------------------------------------------------------------------

  async addContact(principal: Principal, id: string, input: ContactInput, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.addContact(principal, partyId, input, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }

  async updateContact(
    principal: Principal,
    id: string,
    contactId: string,
    input: { [K in keyof ContactInput]?: ContactInput[K] | undefined },
    origin: EventOrigin,
  ) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.updateContact(principal, partyId, contactId, input, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }

  async removeContact(principal: Principal, id: string, contactId: string, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.removeContact(principal, partyId, contactId, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }

  async addAddress(principal: Principal, id: string, input: AddressInput, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.addAddress(principal, partyId, input, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }

  async updateAddress(
    principal: Principal,
    id: string,
    addressId: string,
    input: { [K in keyof AddressInput]?: AddressInput[K] | undefined },
    origin: EventOrigin,
  ) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.updateAddress(principal, partyId, addressId, input, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }

  async removeAddress(principal: Principal, id: string, addressId: string, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.removeAddress(principal, partyId, addressId, origin, CUSTOMER_ACCESS);
    return this.get(principal, id);
  }
}
