import {
  AppError,
  ForbiddenError,
  MfaEnrollmentRequiredError,
  MfaStepUpRequiredError,
  PermissionDeniedError,
  ReauthenticationRequiredError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getEffectiveAccess, scopeAccess } from '../modules/access-control/index.js';
import { hasActiveFactor, type Session, type User } from '../modules/identity/index.js';
import { findMembership, getOrganization } from '../modules/organizations/index.js';
import { enforceActingUserMfa, enforceOrganizationMfa } from './mfa-policy.js';
import { setBranchScope, setDbContext } from './unit-of-work.js';

/** The authenticated caller, resolved by the server from the session cookie. */
export interface Principal {
  user: User;
  session: Session;
}

/**
 * Server-resolved authorization context for an organization-scoped operation.
 * Never built from client-supplied organization identifiers.
 */
export interface AuthorizationContext {
  userId: string;
  /** Null for an acting-user context resolved for background work (L-6). */
  sessionId: string | null;
  organizationId: string;
  membershipId: string;
  isOwner: boolean;
  roleIds: string[];
  permissions: ReadonlySet<string>;
  /**
   * The branches (dimension values) a restricted member is limited to; null when unrestricted.
   * Row-level security enforces it on invoices and bills; the permissions are already narrowed.
   */
  branchScope?: string[] | null;
  /**
   * Set only for a Public API request (ADR 0011): the integration and token behind the service
   * principal in `userId`. Absent for people. Audit and idempotency read it from here, so domain
   * services never pass integration identities themselves.
   */
  integration?: { integrationId: string; tokenId: string };
}

export class NoActiveOrganizationError extends AppError {
  constructor() {
    super('NO_ACTIVE_ORGANIZATION', 409, 'Select an organization to continue.');
  }
}

/**
 * Authentication -> organization membership -> roles -> permissions.
 * Also establishes the RLS context (user + active organization) on the transaction.
 * Resource/scope checks are then applied by each operation (every query is filtered
 * by the context organization, and RLS enforces the same boundary underneath).
 */
export async function resolveAuthorizationContext(
  tx: Transaction,
  principal: Principal,
): Promise<AuthorizationContext> {
  const organizationId = principal.session.activeOrganizationId;
  if (!organizationId) throw new NoActiveOrganizationError();

  await setDbContext(tx, { userId: principal.user.id, organizationId });

  const membership = await findMembership(tx, organizationId, principal.user.id);
  if (!membership || membership.status !== 'active') {
    throw new ForbiddenError('You do not have access to this organization.');
  }
  const organization = await getOrganization(tx, organizationId);
  if (!organization || organization.status !== 'active') {
    throw new ForbiddenError('You do not have access to this organization.');
  }

  const access = await getEffectiveAccess(tx, organizationId, membership.id);
  // S7-27 B/C: organization policy and privileged roles, for every organization-scoped request.
  await enforceOrganizationMfa(tx, {
    userId: principal.user.id,
    session: principal.session,
    organizationId,
    access,
  });
  const scoped = await scopeAccess(tx, organizationId, membership.id, access);
  await setBranchScope(tx, scoped.branchScope);
  return {
    userId: principal.user.id,
    sessionId: principal.session.id,
    organizationId,
    membershipId: membership.id,
    isOwner: access.isOwner,
    roleIds: access.roleIds,
    permissions: scoped.permissions,
    branchScope: scoped.branchScope,
  };
}

/**
 * Acting-user context for background work (S6-09, L-6). A job has no session, so the user who
 * requested the work is re-resolved when it runs: the membership must still be active, the
 * organization active, and permissions are the user's current effective permissions. The RLS
 * context is set exactly as for a request. Re-authentication (a session property) is checked at
 * the HTTP request that starts the work, never here.
 */
export async function resolveActingUserContext(
  tx: Transaction,
  userId: string,
  organizationId: string,
): Promise<AuthorizationContext> {
  await setDbContext(tx, { userId, organizationId });
  const membership = await findMembership(tx, organizationId, userId);
  if (!membership || membership.status !== 'active') {
    throw new ForbiddenError('The requesting user no longer has access to this organization.');
  }
  const organization = await getOrganization(tx, organizationId);
  if (!organization || organization.status !== 'active') {
    throw new ForbiddenError('This organization is not active.');
  }
  const access = await getEffectiveAccess(tx, organizationId, membership.id);
  // S7-31: jobs never bypass the MFA requirement of the user they act for.
  await enforceActingUserMfa(tx, { userId, organizationId, access });
  const scoped = await scopeAccess(tx, organizationId, membership.id, access);
  await setBranchScope(tx, scoped.branchScope);
  return {
    userId,
    sessionId: null,
    organizationId,
    membershipId: membership.id,
    isOwner: access.isOwner,
    roleIds: access.roleIds,
    permissions: scoped.permissions,
    branchScope: scoped.branchScope,
  };
}

export function hasPermission(context: AuthorizationContext, permission: string): boolean {
  return context.permissions.has(permission);
}

export function requirePermission(context: AuthorizationContext, permission: string): void {
  if (!hasPermission(context, permission)) throw new PermissionDeniedError();
}

/** Sensitive actions require a password confirmation within the configured window. */
export function requireRecentAuthentication(
  principal: Principal,
  now: Date,
  reauthWindowMs: number,
): void {
  const age = now.getTime() - principal.session.reauthenticatedAt.getTime();
  if (age > reauthWindowMs) throw new ReauthenticationRequiredError();
}

/**
 * Step-up (S7-33): MFA management and security actions also need a second factor entered in this
 * session within the window. A remembered device never counts. Callers check password
 * re-authentication first.
 */
export async function requireRecentMfa(
  tx: Transaction,
  principal: Principal,
  now: Date,
  stepUpWindowMs: number,
): Promise<void> {
  if (!(await hasActiveFactor(tx, principal.user.id))) throw new MfaEnrollmentRequiredError();
  const verifiedAt = principal.session.mfaVerifiedAt;
  if (!verifiedAt || now.getTime() - verifiedAt.getTime() > stepUpWindowMs) {
    throw new MfaStepUpRequiredError();
  }
}

/**
 * A branch-restricted member (migration 0084) must tag invoices and bills with at least one of
 * their own branches; the database enforces it too, but this gives a readable answer and never
 * reveals anything about branches outside the member's list. `ids` undefined = unchanged on edit.
 */
export function assertWithinBranchScope(
  context: AuthorizationContext,
  ids: readonly string[] | undefined,
  options: { required: boolean },
): void {
  const scope = context.branchScope;
  if (!scope || scope.length === 0) return;
  if (ids === undefined && !options.required) return;
  if (!(ids ?? []).some((id) => scope.includes(id))) {
    throw new ValidationError([
      {
        path: 'dimensionValueIds',
        message: 'Choose at least one of the branches you are allowed to work in.',
      },
    ]);
  }
}
