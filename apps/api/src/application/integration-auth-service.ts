import { UnauthenticatedError } from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import {
  getIntegration,
  getToken,
  listScopes,
  parseToken,
  permissionsForScopes,
  resolveApiToken,
  secretMatches,
  touchToken,
} from '../modules/api-integrations/index.js';
import {
  bindAuditApiToken,
  recordSecurityEvent,
  type EventOrigin,
} from '../modules/audit/index.js';
import { findServicePrincipal } from '../modules/identity/index.js';
import { findMembership, getOrganization } from '../modules/organizations/index.js';
import { permissionCatalog } from './permission-catalog.js';
import { requirePermission, type AuthorizationContext } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Public API authentication (ADR 0011, D2): resolves
 *
 *   token -> integration -> service principal -> organization
 *
 * into an `AuthorizationContext` for the integration's non-human service principal. The context
 * carries the integration and token so that audit and idempotency identify the API caller without
 * any domain service passing identities around. A service principal is never interpreted as a
 * human: there is no session, no membership role and no Owner status.
 *
 * Effective API permission =
 *   the integration's granted scopes
 *   ∩ the frozen platform Public API policy (the scope catalog: unknown scopes give nothing)
 *   ∩ the organization permission boundary (keys that exist in the permission catalog).
 *
 * Every authentication failure is the same generic 401; the reason is recorded as a security
 * event (never containing the credential). This step adds no routes: callers (the Public API
 * plugin of a later step) use `withIntegration`.
 */

type FailureReason =
  | 'malformed'
  | 'unknown_credential'
  | 'bad_secret'
  | 'revoked'
  | 'expired'
  | 'integration_disabled'
  | 'integration_revoked'
  | 'organization_inactive'
  | 'principal_inactive';

class AuthenticationFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

const KNOWN_PERMISSIONS = new Set(permissionCatalog.map((p) => p.key));
const NO_SECRET = Buffer.alloc(32);

export class IntegrationAuthService {
  constructor(private readonly deps: AppDependencies) {}

  /**
   * Authenticates the credential and runs `work` in one transaction under the integration's
   * context (RLS organization and service-principal user set). `permission`, when given, is
   * checked against the effective API permissions.
   */
  async withIntegration<T>(
    credential: string | null | undefined,
    options: { origin: EventOrigin; permission?: string | undefined },
    work: (tx: Transaction, context: AuthorizationContext) => Promise<T>,
  ): Promise<T> {
    const parsed = parseToken(credential);
    if (!parsed) {
      await this.recordFailure('malformed', options.origin, null);
      throw new UnauthenticatedError('Invalid or expired API token.');
    }
    const resolved = await inTransaction(this.deps.db, {}, (tx) =>
      resolveApiToken(tx, parsed.publicId),
    );
    if (!resolved) {
      // Same work as a real check, so an unknown credential is not distinguishable by timing.
      secretMatches(parsed.secret, NO_SECRET);
      await this.recordFailure('unknown_credential', options.origin, null);
      throw new UnauthenticatedError('Invalid or expired API token.');
    }
    try {
      return await inTransaction(
        this.deps.db,
        { organizationId: resolved.organizationId, userId: resolved.serviceUserId },
        async (tx) => {
          const context = await this.authenticateInTransaction(
            tx,
            resolved,
            parsed.secret,
            options.origin,
          );
          if (options.permission) requirePermission(context, options.permission);
          return work(tx, context);
        },
      );
    } catch (error) {
      if (!(error instanceof AuthenticationFailure)) throw error;
      await this.recordFailure(error.reason, options.origin, resolved.organizationId);
      throw new UnauthenticatedError('Invalid or expired API token.');
    }
  }

  private async authenticateInTransaction(
    tx: Transaction,
    resolved: { tokenId: string; organizationId: string; serviceUserId: string },
    secret: string,
    origin: EventOrigin,
  ): Promise<AuthorizationContext> {
    const now = this.deps.clock.now();
    const token = await getToken(tx, resolved.organizationId, resolved.tokenId);
    if (!token || !secretMatches(secret, token.secretHash)) {
      throw new AuthenticationFailure('bad_secret');
    }
    if (token.revokedAt) throw new AuthenticationFailure('revoked');
    if (token.expiresAt.getTime() <= now.getTime()) throw new AuthenticationFailure('expired');
    const integration = await getIntegration(tx, resolved.organizationId, token.integrationId);
    if (!integration || integration.serviceUserId !== resolved.serviceUserId) {
      throw new AuthenticationFailure('unknown_credential');
    }
    if (integration.status === 'revoked') throw new AuthenticationFailure('integration_revoked');
    if (integration.status !== 'active') throw new AuthenticationFailure('integration_disabled');
    const organization = await getOrganization(tx, resolved.organizationId);
    if (!organization || organization.status !== 'active') {
      throw new AuthenticationFailure('organization_inactive');
    }
    const principal = await findServicePrincipal(tx, resolved.serviceUserId);
    const membership = await findMembership(tx, resolved.organizationId, resolved.serviceUserId);
    if (
      !principal ||
      principal.status !== 'active' ||
      !membership ||
      membership.status !== 'active' ||
      membership.id !== integration.serviceMembershipId
    ) {
      throw new AuthenticationFailure('principal_inactive');
    }
    const scopes =
      (await listScopes(tx, resolved.organizationId, [integration.id])).get(integration.id) ?? [];
    const permissions = new Set(
      [...permissionsForScopes(scopes)].filter((key) => KNOWN_PERMISSIONS.has(key)),
    );
    bindAuditApiToken(tx, token.id);
    await touchToken(tx, {
      organizationId: resolved.organizationId,
      id: token.id,
      ip: origin.ipAddress,
      now,
    });
    return {
      userId: resolved.serviceUserId,
      sessionId: null,
      organizationId: resolved.organizationId,
      membershipId: membership.id,
      isOwner: false,
      roleIds: [],
      permissions,
      integration: { integrationId: integration.id, tokenId: token.id },
    };
  }

  private async recordFailure(
    reason: FailureReason,
    origin: EventOrigin,
    organizationId: string | null,
  ) {
    await inTransaction(this.deps.db, {}, (tx) =>
      recordSecurityEvent(tx, {
        occurredAt: this.deps.clock.now(),
        eventType: 'api_token.auth_failed',
        userId: null,
        organizationId,
        metadata: { reason },
        origin,
      }),
    );
  }
}
