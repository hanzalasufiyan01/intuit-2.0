import {
  AppError,
  ForbiddenError,
  PermissionDeniedError,
  ReauthenticationRequiredError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getEffectiveAccess } from '../modules/access-control/index.js';
import type { Session, User } from '../modules/identity/index.js';
import { findMembership, getOrganization } from '../modules/organizations/index.js';
import { setDbContext } from './unit-of-work.js';

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
  sessionId: string;
  organizationId: string;
  membershipId: string;
  isOwner: boolean;
  roleIds: string[];
  permissions: ReadonlySet<string>;
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
  return {
    userId: principal.user.id,
    sessionId: principal.session.id,
    organizationId,
    membershipId: membership.id,
    isOwner: access.isOwner,
    roleIds: access.roleIds,
    permissions: access.permissions,
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
