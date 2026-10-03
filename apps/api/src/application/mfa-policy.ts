import { MfaEnrollmentRequiredError, MfaVerificationRequiredError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { AccessControlPermissions, getEffectiveAccess } from '../modules/access-control/index.js';
import { AccountingPermissions } from '../modules/accounting/index.js';
import { ApprovalPermissions } from '../modules/approvals/index.js';
import { hasActiveFactor, type Session } from '../modules/identity/index.js';
import { PurchasesPermissions } from '../modules/purchases/index.js';
import { SalesPermissions } from '../modules/sales/index.js';
import {
  getSecurityPolicy,
  listMemberMfaEnrollment,
  listOrganizationMemberships,
  OrganizationPermissions,
  type SecurityPolicy,
} from '../modules/organizations/index.js';

/**
 * MFA enforcement (S7-27), four separate layers:
 *  A. login: a user with an active factor is challenged at every password sign-in unless a valid
 *     remembered device is presented (AuthService.login);
 *  B. organization policy: "require MFA for all members" (S7-29);
 *  C. role/permission: the Owner and holders of the Decision 57a keys (S7-28);
 *  D. sensitive actions: password re-authentication (ADR 0001, unchanged) plus, for MFA
 *     management and security actions only, a fresh second factor (step-up, S7-33).
 * B and C are evaluated for the active organization on every request (S7-30) and for the acting
 * user of background work (S7-31).
 */

/**
 * Decision 57a, exactly (S7-28): the Owner plus holders of these keys. `sales.settings.manage`
 * joined with Phase 3B (E6); no other key is added.
 */
export const HIGH_PRIVILEGE_PERMISSIONS: readonly string[] = [
  AccessControlPermissions.RolesManage,
  OrganizationPermissions.MembersManage,
  ApprovalPermissions.ApprovalsManage,
  AccountingPermissions.Setup,
  SalesPermissions.SettingsManage,
  // Phase 4A-4 (ADR 0004 P4-41).
  PurchasesPermissions.SettingsManage,
];

export type MfaRequirementReason = 'owner' | 'privileged_permission' | 'organization_policy';

export interface MfaRequirement {
  required: boolean;
  reasons: MfaRequirementReason[];
}

export function mfaRequirement(
  access: { isOwner: boolean; permissions: ReadonlySet<string> },
  policy: Pick<SecurityPolicy, 'requireMfaForAllMembers'>,
): MfaRequirement {
  const reasons: MfaRequirementReason[] = [];
  if (access.isOwner) reasons.push('owner');
  if (HIGH_PRIVILEGE_PERMISSIONS.some((key) => access.permissions.has(key))) {
    reasons.push('privileged_permission');
  }
  if (policy.requireMfaForAllMembers) reasons.push('organization_policy');
  return { required: reasons.length > 0, reasons };
}

/**
 * Whether the session satisfies MFA for an organization. A remembered device counts unless the
 * organization disallows remembered devices (S7-36); it never counts as step-up.
 */
export function sessionSatisfiesMfa(
  session: Pick<Session, 'mfaMethod' | 'mfaPendingUntil'>,
  policy: Pick<SecurityPolicy, 'allowTrustedDevices'>,
): boolean {
  if (session.mfaPendingUntil !== null) return false;
  if (session.mfaMethod === 'totp' || session.mfaMethod === 'recovery_code') return true;
  return session.mfaMethod === 'trusted_device' && policy.allowTrustedDevices;
}

/**
 * Enforces B and C for a request (S7-31). Throws MFA_ENROLLMENT_REQUIRED when the user has no
 * factor yet, MFA_VERIFICATION_REQUIRED when the session has not satisfied MFA for this
 * organization.
 */
export async function enforceOrganizationMfa(
  tx: Transaction,
  input: {
    userId: string;
    session: Pick<Session, 'mfaMethod' | 'mfaPendingUntil'>;
    organizationId: string;
    access: { isOwner: boolean; permissions: ReadonlySet<string> };
  },
): Promise<void> {
  const policy = await getSecurityPolicy(tx, input.organizationId);
  if (!mfaRequirement(input.access, policy).required) return;
  if (sessionSatisfiesMfa(input.session, policy)) return;
  if (await hasActiveFactor(tx, input.userId)) throw new MfaVerificationRequiredError();
  throw new MfaEnrollmentRequiredError();
}

/**
 * Background work has no session (L-6): a job acting for a user in an organization that requires
 * MFA of them fails permanently unless the user still has an active factor (S7-31).
 */
export async function enforceActingUserMfa(
  tx: Transaction,
  input: {
    userId: string;
    organizationId: string;
    access: { isOwner: boolean; permissions: ReadonlySet<string> };
  },
): Promise<void> {
  const policy = await getSecurityPolicy(tx, input.organizationId);
  if (!mfaRequirement(input.access, policy).required) return;
  if (await hasActiveFactor(tx, input.userId)) return;
  throw new MfaEnrollmentRequiredError(
    'The requesting user must set up two-step verification before this work can run.',
  );
}

export interface MemberMfaStatus {
  enrolled: boolean;
  required: boolean;
  active: boolean;
}

/**
 * Per-member MFA status for administrators (S7-39): enrolled yes/no (through the definer
 * function; RLS hides other users' credentials) and whether MFA is required of them here.
 */
export async function memberMfaStatus(
  tx: Transaction,
  organizationId: string,
): Promise<Map<string, MemberMfaStatus>> {
  const policy = await getSecurityPolicy(tx, organizationId);
  const enrollment = await listMemberMfaEnrollment(tx);
  const status = new Map<string, MemberMfaStatus>();
  for (const membership of await listOrganizationMemberships(tx, organizationId)) {
    const access = await getEffectiveAccess(tx, organizationId, membership.id);
    status.set(membership.id, {
      enrolled: enrollment.get(membership.id) ?? false,
      required: mfaRequirement(access, policy).required,
      active: membership.status === 'active',
    });
  }
  return status;
}
