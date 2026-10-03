import { Decimal } from 'decimal.js';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { isSupportedCurrency, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { designationsOfAccount, getAccount } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getParty, listParties, type Party } from '../modules/parties/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import {
  getVendor,
  getVendorByParty,
  insertVendor,
  listVendorsByParty,
  purchaseAccountProblem,
  updateVendor,
  VendorPermissions,
  vendorPartyIds,
  type Vendor,
  type VendorFields,
  type VendorStatus,
} from '../modules/vendors/index.js';
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
 * Vendors on the shared Party master (Phase 4A-3; ADR 0004 P4-03; Decisions 8, 28; R36). Identity
 * (name, TIN, contacts, addresses) stays on the Party and is edited here under `vendors.update`
 * with the Party rules and audit; the vendor holds its currency (the default for future bills,
 * P4-20), payment terms, warning-only credit limit, the organization's account number with the
 * vendor, and default expense account and tax code. The Party keeps its `vendor` role while the
 * vendor exists, and keeps any other role (a party can be a customer and a vendor). No bank or
 * payment details (P4-43). The shared Party-role steps live in `party-role-records.ts`.
 */

export interface VendorTermsInput {
  currencyCode?: string | undefined;
  paymentTermsDays?: number | null | undefined;
  creditLimit?: string | null | undefined;
  accountNumber?: string | null | undefined;
  defaultExpenseAccountId?: string | null | undefined;
  defaultTaxCodeId?: string | null | undefined;
  /** P4-12: NULL = no vendor default. */
  defaultTaxRecoverable?: boolean | null | undefined;
}

export type CreateVendorInput = VendorTermsInput &
  ({ partyId: string; party?: undefined } | { party: CreatePartyInput; partyId?: undefined });

export interface UpdateVendorInput extends VendorTermsInput {
  version: number;
  /** Identity changes, at the party's own version. Roles are managed on the Contacts screens. */
  party?: Omit<UpdatePartyInput, 'roles'> | undefined;
}

const VENDOR: PartyRoleRecordKind = { role: 'vendor', noun: 'vendor' };
const VENDOR_ACCESS: PartyAccess = { permission: VendorPermissions.Update, role: 'vendor' };

const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'This vendor was changed by someone else. Reload it and apply your changes again.',
  );

function money(value: string | null, currency: string) {
  return value === null ? null : new Decimal(value).toFixed(minorUnits(currency));
}

function vendorView(vendor: Vendor, party: Party) {
  return {
    id: vendor.id,
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
    currencyCode: vendor.currencyCode,
    paymentTermsDays: vendor.paymentTermsDays,
    creditLimit: money(vendor.creditLimit, vendor.currencyCode),
    accountNumber: vendor.accountNumber,
    defaultExpenseAccountId: vendor.defaultExpenseAccountId,
    defaultTaxCodeId: vendor.defaultTaxCodeId,
    defaultTaxRecoverable: vendor.defaultTaxRecoverable,
    status: vendor.status,
    version: vendor.version,
    createdAt: vendor.createdAt.toISOString(),
    updatedAt: vendor.updatedAt.toISOString(),
    archivedAt: vendor.archivedAt?.toISOString() ?? null,
  };
}

const VENDOR_FIELDS: readonly (keyof VendorFields)[] = [
  'currencyCode',
  'paymentTermsDays',
  'creditLimit',
  'accountNumber',
  'defaultExpenseAccountId',
  'defaultTaxCodeId',
  'defaultTaxRecoverable',
];

export class VendorService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly parties: PartyService,
  ) {
    // A party keeps its vendor role while it has a vendor record.
    parties.registerRoleGuard('vendor', async (tx, organizationId, partyId) =>
      (await getVendorByParty(tx, organizationId, partyId))
        ? 'This contact is a vendor. Archive the vendor instead of removing the role.'
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
    vendorId: string,
    metadata: Record<string, unknown>,
    origin: EventOrigin,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'vendor',
      resourceId: vendorId,
      metadata,
      origin,
    });
  }

  private async detail(tx: Transaction, organizationId: string, vendor: Vendor) {
    const { row, extra } = await partyIdentity(this.parties, tx, organizationId, vendor.partyId);
    return { ...vendorView(vendor, row), ...extra };
  }

  private async requireVendor(tx: Transaction, organizationId: string, id: string) {
    const vendor = await getVendor(tx, organizationId, id, { forUpdate: true });
    if (!vendor) throw new NotFoundError('Vendor not found.');
    return vendor;
  }

  /**
   * Validates and normalizes the vendor-specific fields. A default account or tax code is checked
   * only when it is set or changed, so an existing default that later became unusable does not
   * block unrelated edits (it is checked again when a bill uses it).
   */
  private async terms(
    tx: Transaction,
    organizationId: string,
    input: VendorTermsInput,
    current: VendorFields,
  ): Promise<{ fields: VendorFields; issues: ValidationIssue[] }> {
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
    const accountNumber =
      input.accountNumber === undefined
        ? current.accountNumber
        : input.accountNumber?.trim() || null;
    const defaultExpenseAccountId =
      input.defaultExpenseAccountId === undefined
        ? current.defaultExpenseAccountId
        : input.defaultExpenseAccountId;
    if (defaultExpenseAccountId && defaultExpenseAccountId !== current.defaultExpenseAccountId) {
      const account = await getAccount(tx, organizationId, defaultExpenseAccountId);
      const problem = account
        ? purchaseAccountProblem({
            status: account.status,
            isLeaf: account.isLeaf,
            subtype: account.subtype,
            isControlAccount: account.isControlAccount,
            designated: (await designationsOfAccount(tx, organizationId, account.id)).length > 0,
          })
        : 'Account not found.';
      if (problem) issues.push({ path: 'defaultExpenseAccountId', message: problem });
    }
    const defaultTaxCodeId =
      input.defaultTaxCodeId === undefined ? current.defaultTaxCodeId : input.defaultTaxCodeId;
    if (defaultTaxCodeId && defaultTaxCodeId !== current.defaultTaxCodeId) {
      const code = await getTaxCode(tx, organizationId, defaultTaxCodeId);
      if (!code) issues.push({ path: 'defaultTaxCodeId', message: 'Tax code not found.' });
      else if (code.status !== 'ACTIVE') {
        issues.push({ path: 'defaultTaxCodeId', message: `${code.code} is archived.` });
      }
    }
    const defaultTaxRecoverable =
      input.defaultTaxRecoverable === undefined
        ? current.defaultTaxRecoverable
        : input.defaultTaxRecoverable;
    return {
      fields: {
        currencyCode,
        paymentTermsDays,
        creditLimit,
        accountNumber,
        defaultExpenseAccountId,
        defaultTaxCodeId,
        defaultTaxRecoverable,
      },
      issues,
    };
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
      { permission: VendorPermissions.View },
      async (tx, ctx) => {
        const status: VendorStatus | 'ALL' =
          query.status === 'all' ? 'ALL' : query.status === 'archived' ? 'ARCHIVED' : 'ACTIVE';
        const page = await listParties(tx, {
          organizationId: ctx.organizationId,
          status: 'ALL',
          role: null,
          search: query.search?.trim() || null,
          limit: query.limit,
          after: query.after ? decodePartyCursor(query.after) : null,
          partyIdsIn: vendorPartyIds(ctx.organizationId, status),
        });
        const rows = await listVendorsByParty(
          tx,
          ctx.organizationId,
          page.items.map((i) => i.party.id),
        );
        const byParty = new Map(rows.map((v) => [v.partyId, v]));
        const last = page.items.at(-1)?.party;
        return {
          items: page.items.map((i) => vendorView(byParty.get(i.party.id)!, i.party)),
          nextCursor: page.hasMore && last ? encodePartyCursor(last) : null,
        };
      },
    );
  }

  /** Any vendor, archived ones included: historical documents keep showing them. */
  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPermissions.View },
      async (tx, ctx) => {
        const vendor = await getVendor(tx, ctx.organizationId, id);
        if (!vendor) throw new NotFoundError('Vendor not found.');
        return this.detail(tx, ctx.organizationId, vendor);
      },
    );
  }

  /**
   * The vendor for a new Purchases document: it must exist, and both the vendor and its party must
   * be active. Archived vendors remain readable for existing documents but get no new ones.
   * (Used by the Purchases documents of later stages.)
   */
  async requireUsableVendorInTransaction(
    tx: Transaction,
    organizationId: string,
    vendorId: string,
    path = 'vendorId',
  ): Promise<Vendor> {
    const vendor = await getVendor(tx, organizationId, vendorId);
    if (!vendor) throw new ValidationError([{ path, message: 'Vendor not found.' }]);
    const party = await getParty(tx, organizationId, vendor.partyId);
    if (vendor.status !== 'ACTIVE' || party?.status !== 'ACTIVE') {
      throw new ValidationError([
        { path, message: 'Archived vendors cannot be used on new documents.' },
      ]);
    }
    return vendor;
  }

  /** The party of a vendor, for the identity sub-resources (vendor → party never changes). */
  private partyOf(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPermissions.Update },
      async (tx, ctx) => (await this.requireVendor(tx, ctx.organizationId, id)).partyId,
    );
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: CreateVendorInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPermissions.Create },
      async (tx, ctx) => {
        const { vendor, party } = await this.createInTransaction(tx, ctx, input, origin);
        return {
          ...(await this.detail(tx, ctx.organizationId, vendor)),
          warnings: await this.parties.duplicateWarningsInTransaction(
            tx,
            ctx.organizationId,
            party,
          ),
        };
      },
    );
  }

  /** Creates a vendor inside the caller's transaction with the HTTP path's rules and audit. */
  async createInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: CreateVendorInput,
    origin: EventOrigin,
  ): Promise<{ vendor: Vendor; party: Party }> {
    requirePermission(ctx, VendorPermissions.Create);
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const { fields, issues } = await this.terms(tx, ctx.organizationId, input, {
      currencyCode: settings.baseCurrency,
      paymentTermsDays: null,
      creditLimit: null,
      accountNumber: null,
      defaultExpenseAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxRecoverable: null,
    });
    if (issues.length) throw new ValidationError(issues);

    const { party, newParty } = await partyForRoleRecord(this.parties, tx, ctx, input, {
      kind: VENDOR,
      permission: VendorPermissions.Create,
      hasRecord: async (partyId) =>
        (await getVendorByParty(tx, ctx.organizationId, partyId)) !== undefined,
      origin,
    });
    const vendor = await insertVendor(tx, {
      ...fields,
      organizationId: ctx.organizationId,
      partyId: party.id,
      userId: ctx.userId,
      now: this.now,
    });
    if (!vendor) throw new ConflictError('CONFLICT', 'This contact is already a vendor.');
    await this.audit(
      tx,
      ctx,
      'vendor.created',
      vendor.id,
      {
        partyId: party.id,
        displayName: party.displayName,
        newParty,
        ...Object.fromEntries(VENDOR_FIELDS.map((k) => [k, vendor[k]])),
      },
      origin,
    );
    return { vendor, party };
  }

  update(principal: Principal, id: string, input: UpdateVendorInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPermissions.Update },
      async (tx, ctx) => {
        const vendor = await this.requireVendor(tx, ctx.organizationId, id);
        if (vendor.version !== input.version) throw versionConflict();
        const { fields, issues } = await this.terms(tx, ctx.organizationId, input, vendor);
        if (issues.length) throw new ValidationError(issues);

        let party: Party | undefined;
        if (input.party) {
          party = await this.parties.updateInTransaction(
            tx,
            ctx,
            vendor.partyId,
            input.party,
            origin,
            VENDOR_ACCESS,
          );
        }
        const changed = VENDOR_FIELDS.filter((k) => fields[k] !== vendor[k]);
        let updated = vendor;
        if (changed.length) {
          const saved = await updateVendor(tx, {
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
            'vendor.updated',
            id,
            {
              version: saved.version,
              changedFields: changed,
              before: Object.fromEntries(changed.map((k) => [k, vendor[k]])),
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

  /** Archived vendors stay valid on existing documents but get no new ones. */
  setStatus(
    principal: Principal,
    id: string,
    input: { version: number; status: VendorStatus },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: VendorPermissions.Archive },
      async (tx, ctx) => {
        const vendor = await this.requireVendor(tx, ctx.organizationId, id);
        if (vendor.version !== input.version) throw versionConflict();
        if (vendor.status === input.status) {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            `The vendor is already ${input.status.toLowerCase()}.`,
          );
        }
        const archived = input.status === 'ARCHIVED';
        if (!archived) {
          await assertPartyActiveForRestore(tx, ctx.organizationId, vendor.partyId, VENDOR);
        }
        const saved = await updateVendor(tx, {
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
          archived ? 'vendor.archived' : 'vendor.restored',
          id,
          { partyId: vendor.partyId, status: input.status },
          origin,
        );
        return this.detail(tx, ctx.organizationId, saved);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Identity sub-resources: the Party rules and audit, under vendors.update (D6 mirror). These
  // delegate to PartyService; no contact or address logic lives here.
  // ---------------------------------------------------------------------------

  async addContact(principal: Principal, id: string, input: ContactInput, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.addContact(principal, partyId, input, origin, VENDOR_ACCESS);
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
    await this.parties.updateContact(principal, partyId, contactId, input, origin, VENDOR_ACCESS);
    return this.get(principal, id);
  }

  async removeContact(principal: Principal, id: string, contactId: string, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.removeContact(principal, partyId, contactId, origin, VENDOR_ACCESS);
    return this.get(principal, id);
  }

  async addAddress(principal: Principal, id: string, input: AddressInput, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.addAddress(principal, partyId, input, origin, VENDOR_ACCESS);
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
    await this.parties.updateAddress(principal, partyId, addressId, input, origin, VENDOR_ACCESS);
    return this.get(principal, id);
  }

  async removeAddress(principal: Principal, id: string, addressId: string, origin: EventOrigin) {
    const partyId = await this.partyOf(principal, id);
    await this.parties.removeAddress(principal, partyId, addressId, origin, VENDOR_ACCESS);
    return this.get(principal, id);
  }
}
