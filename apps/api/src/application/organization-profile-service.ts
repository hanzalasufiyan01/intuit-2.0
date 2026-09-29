import { ConflictError, ValidationError, type ValidationIssue } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  getCountries,
  getOrganizationProfile,
  listCountries,
  OrganizationPermissions,
  organizationAddressKinds,
  saveOrganizationProfile,
  type AddressInput,
  type OrganizationAddress,
  type OrganizationAddressKind,
  type OrganizationProfile,
  type ProfileIdentifier,
} from '../modules/organizations/index.js';
import { requireRecentAuthentication, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction } from './unit-of-work.js';
import { withOrganization } from './organization-service.js';

/**
 * Organization legal profile (Decision 17; S4-01..S4-07, S4-12, S4-14). Viewing needs
 * organization.read; saving needs organization.update, plus recent re-authentication when the
 * TIN or GST registration changes (S4-12).
 */

export interface ProfileInput {
  version: number;
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
  registeredAddress: AddressInput | null;
  businessAddress: AddressInput | null;
}

const ADDRESS_FIELD: Record<OrganizationAddressKind, 'registeredAddress' | 'businessAddress'> = {
  registered: 'registeredAddress',
  business: 'businessAddress',
};
/** Tax identity (S4-12): changing any of these requires recent re-authentication. */
const TAX_IDENTITY = [
  'tin',
  'gstRegistered',
  'gstRegistrationNumber',
  'gstRegisteredFrom',
] as const;
/** Business identifiers whose values are audited; other fields are audited by name only. */
const AUDITED_VALUES = new Set([
  'legalName',
  'tradingName',
  'tin',
  'gstRegistered',
  'gstRegistrationNumber',
  'gstRegisteredFrom',
  'identifiers',
]);

function addressView(address: OrganizationAddress | undefined) {
  if (!address) return null;
  return {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
  };
}

function profileView(
  data: { profile: OrganizationProfile; addresses: OrganizationAddress[] } | null,
) {
  const p = data?.profile;
  const address = (kind: OrganizationAddressKind) =>
    addressView(data?.addresses.find((a) => a.kind === kind));
  return {
    // 0 = never saved (S4-04: nothing is inferred for existing organizations).
    version: p?.version ?? 0,
    legalName: p?.legalName ?? null,
    tradingName: p?.tradingName ?? null,
    tin: p?.tin ?? null,
    gstRegistered: p?.gstRegistered ?? false,
    gstRegistrationNumber: p?.gstRegistrationNumber ?? null,
    gstRegisteredFrom: p?.gstRegisteredFrom ?? null,
    email: p?.email ?? null,
    phone: p?.phone ?? null,
    website: p?.website ?? null,
    identifiers: p?.identifiers ?? [],
    registeredAddress: address('registered'),
    businessAddress: address('business'),
    updatedAt: p?.updatedAt.toISOString() ?? null,
    // S5-12: managed through the logo endpoints, outside the profile version.
    logo: p?.logoFileId ? { fileId: p.logoFileId } : null,
  };
}

type ProfileView = ReturnType<typeof profileView>;

export class OrganizationProfileService {
  constructor(private readonly deps: AppDependencies) {}

  /** Country reference data (S4-05), for any authenticated user. */
  listCountries(principal: Principal) {
    return inTransaction(this.deps.db, { userId: principal.user.id }, async (tx) =>
      (await listCountries(tx)).map((c) => ({ code: c.code, name: c.name, isActive: c.isActive })),
    );
  }

  getProfile(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationRead },
      async (tx, ctx) => profileView(await getOrganizationProfile(tx, ctx.organizationId)),
    );
  }

  updateProfile(principal: Principal, input: ProfileInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: OrganizationPermissions.OrganizationUpdate },
      async (tx, ctx) => {
        const current = await getOrganizationProfile(tx, ctx.organizationId, { forUpdate: true });
        const before = profileView(current);
        if (input.version !== before.version) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The company profile was changed by someone else. Reload it and apply your changes again.',
          );
        }
        await this.validate(tx, input, before);

        // S4-12: tax-identity changes need recent re-authentication.
        if (TAX_IDENTITY.some((k) => input[k] !== before[k])) {
          requireRecentAuthentication(
            principal,
            this.deps.clock.now(),
            this.deps.config.session.reauthWindowMs,
          );
        }

        const saved = await saveOrganizationProfile(tx, {
          organizationId: ctx.organizationId,
          expectedVersion: input.version,
          userId: ctx.userId,
          values: {
            legalName: input.legalName,
            tradingName: input.tradingName,
            tin: input.tin,
            gstRegistered: input.gstRegistered,
            gstRegistrationNumber: input.gstRegistrationNumber,
            gstRegisteredFrom: input.gstRegisteredFrom,
            email: input.email,
            phone: input.phone,
            website: input.website,
            identifiers: input.identifiers,
            addresses: {
              registered: input.registeredAddress,
              business: input.businessAddress,
            },
          },
        });
        if (!saved) {
          throw new ConflictError(
            'VERSION_CONFLICT',
            'The company profile was changed by someone else. Reload it and apply your changes again.',
          );
        }
        const after = profileView(await getOrganizationProfile(tx, ctx.organizationId));
        await this.audit(tx, ctx.organizationId, ctx.userId, before, after, origin);
        return after;
      },
    );
  }

  private async validate(tx: Transaction, input: ProfileInput, before: ProfileView) {
    const issues: ValidationIssue[] = [];
    // S4-07: a GST-registered organization needs its registration number.
    if (input.gstRegistered && !input.gstRegistrationNumber) {
      issues.push({
        path: 'gstRegistrationNumber',
        message: 'Enter the GST registration number for a GST-registered organization.',
      });
    }
    const codes = organizationAddressKinds
      .map((k) => input[ADDRESS_FIELD[k]]?.countryCode)
      .filter((c): c is string => c !== undefined);
    const countries = await getCountries(tx, codes);
    for (const kind of organizationAddressKinds) {
      const field = ADDRESS_FIELD[kind];
      const address = input[field];
      if (!address) continue;
      const country = countries.get(address.countryCode);
      if (!country) {
        issues.push({ path: `${field}.countryCode`, message: 'Unknown country.' });
      } else if (!country.isActive && before[field]?.countryCode !== address.countryCode) {
        // An inactive country may be kept but not newly selected.
        issues.push({
          path: `${field}.countryCode`,
          message: 'This country is no longer available.',
        });
      }
    }
    if (issues.length) throw new ValidationError(issues);
  }

  private async audit(
    tx: Transaction,
    organizationId: string,
    userId: string,
    before: ProfileView,
    after: ProfileView,
    origin: EventOrigin,
  ) {
    const keys = Object.keys(after).filter(
      (k) => k !== 'version' && k !== 'updatedAt',
    ) as (keyof ProfileView)[];
    const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    await recordAuditEvent(tx, {
      occurredAt: this.deps.clock.now(),
      organizationId,
      actorUserId: userId,
      action: 'organization.profile_updated',
      resourceType: 'organization',
      resourceId: organizationId,
      metadata: {
        created: before.version === 0,
        version: after.version,
        changedFields: changed,
        // Values only for business identifiers; contact details and addresses by name only.
        values: Object.fromEntries(
          changed.filter((k) => AUDITED_VALUES.has(k)).map((k) => [k, after[k]]),
        ),
      },
      origin,
    });
  }
}
