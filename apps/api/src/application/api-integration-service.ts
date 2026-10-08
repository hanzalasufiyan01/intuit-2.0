import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getEffectiveAccess } from '../modules/access-control/index.js';
import {
  addScopes,
  ApiIntegrationPermissions,
  countActiveTokens,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  generateToken,
  getIntegration,
  getToken,
  insertIntegration,
  insertToken,
  isPublicApiScope,
  listIntegrations,
  listScopes,
  listTokens,
  MAX_ACTIVE_TOKENS_PER_ORGANIZATION,
  MAX_TOKEN_LIFETIME_DAYS,
  PUBLIC_API_SCOPES,
  permissionsForScopes,
  removeScopes,
  revokeIntegrationTokens,
  revokeToken,
  tokenDisplayPrefix,
  updateIntegration,
  type ApiIntegration,
  type ApiToken,
  type IntegrationStatus,
} from '../modules/api-integrations/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { createServicePrincipal, getUserProfiles } from '../modules/identity/index.js';
import {
  createMembership,
  findMembershipById,
  getSecurityPolicy,
} from '../modules/organizations/index.js';
import { requireRecentMfa, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { mfaRequirement } from './mfa-policy.js';
import { withOrganization } from './organization-service.js';

/**
 * API integrations and tokens (ADR 0011, D2), managed by people. An integration is owned by the
 * organization and runs as its own non-human service principal; the responsible administrator is
 * a separate, reassignable human. Every management operation needs `api_tokens.manage`, a recent
 * password confirmation and, where the organization's MFA policy applies to the actor, a recent
 * second factor. The human actor is audited; the integration's own runtime activity is audited as
 * `api_token` (see recordAuditEvent). Tokens are opaque, expire (at most 365 days), carry no
 * permissions of their own and are shown once.
 */

const RESOURCE = 'api_integration';
const TOKEN_RESOURCE = 'api_token';

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The integration changed; reload it and try again.');

export interface IntegrationInput {
  name: string;
  description?: string | undefined;
  scopes: string[];
  /** Defaults to the actor; otherwise another active human holding `api_tokens.manage`. */
  responsibleMembershipId?: string | undefined;
}

export interface TokenInput {
  name: string;
  expiresInDays?: number | undefined;
}

export class ApiIntegrationService {
  constructor(private readonly deps: AppDependencies) {}

  private get now() {
    return this.deps.clock.now();
  }

  /** MFA step-up where the organization's policy requires MFA of this actor (S7-33 semantics). */
  private async stepUpWhenEnforced(
    tx: Transaction,
    principal: Principal,
    ctx: AuthorizationContext,
  ) {
    const policy = await getSecurityPolicy(tx, ctx.organizationId);
    if (mfaRequirement(ctx, policy).required) {
      await requireRecentMfa(tx, principal, this.now, this.deps.config.mfa.stepUpWindowMs);
    }
  }

  private manage<T>(
    principal: Principal,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApiIntegrationPermissions.TokensManage, sensitive: true },
      async (tx, ctx) => {
        await this.stepUpWhenEnforced(tx, principal, ctx);
        return work(tx, ctx);
      },
    );
  }

  private async audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    // The actor is the human; metadata keys avoid words the audit sanitizer treats as secrets.
    await recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private tokenView(t: ApiToken) {
    const now = this.now.getTime();
    return {
      id: t.id,
      integrationId: t.integrationId,
      name: t.name,
      // Never the secret and never its hash: only the public, non-secret part.
      prefix: tokenDisplayPrefix(t.publicId),
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
      status: t.revokedAt ? 'revoked' : t.expiresAt.getTime() <= now ? 'expired' : 'active',
      replacesId: t.replacesTokenId,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      revokedAt: t.revokedAt?.toISOString() ?? null,
      revokeReason: t.revokeReason,
    };
  }

  private async view(tx: Transaction, organizationId: string, rows: readonly ApiIntegration[]) {
    const scopes = await listScopes(
      tx,
      organizationId,
      rows.map((r) => r.id),
    );
    const memberships = new Map<string, string | null>();
    for (const row of rows) {
      const membership = await findMembershipById(tx, organizationId, row.responsibleMembershipId);
      memberships.set(row.responsibleMembershipId, membership?.userId ?? null);
    }
    const profiles = await getUserProfiles(
      tx,
      [...memberships.values()].filter((id): id is string => id !== null),
    );
    return rows.map((r) => {
      const userId = memberships.get(r.responsibleMembershipId) ?? null;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        status: r.status,
        scopes: scopes.get(r.id) ?? [],
        responsible: {
          membershipId: r.responsibleMembershipId,
          displayName: userId ? (profiles.get(userId)?.displayName ?? null) : null,
        },
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        disabledAt: r.disabledAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        revokeReason: r.revokeReason,
      };
    });
  }

  /** The v1 scope catalog (the fixed platform policy), for administrators building a grant. */
  scopeCatalog(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApiIntegrationPermissions.TokensView },
      async () =>
        PUBLIC_API_SCOPES.map((s) => ({
          scope: s.scope,
          description: s.description,
          write: s.write,
        })),
    );
  }

  list(principal: Principal, filter: { status?: IntegrationStatus | undefined } = {}) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApiIntegrationPermissions.TokensView },
      async (tx, ctx) =>
        this.view(tx, ctx.organizationId, await listIntegrations(tx, ctx.organizationId, filter)),
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApiIntegrationPermissions.TokensView },
      async (tx, ctx) => {
        const row = await getIntegration(tx, ctx.organizationId, id);
        if (!row) throw new NotFoundError('Integration not found.');
        return (await this.view(tx, ctx.organizationId, [row]))[0]!;
      },
    );
  }

  listTokens(principal: Principal, integrationId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ApiIntegrationPermissions.TokensView },
      async (tx, ctx) => {
        if (!(await getIntegration(tx, ctx.organizationId, integrationId))) {
          throw new NotFoundError('Integration not found.');
        }
        return (await listTokens(tx, ctx.organizationId, integrationId)).map((t) =>
          this.tokenView(t),
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Validation helpers
  // ---------------------------------------------------------------------------

  /**
   * Scopes must be in the fixed platform policy, and the actor may grant only scopes whose
   * permission keys the actor currently holds (checked now, never at runtime).
   */
  private scopeIssues(ctx: AuthorizationContext, scopes: readonly string[], path = 'scopes') {
    const issues: ValidationIssue[] = [];
    for (const scope of scopes) {
      if (!isPublicApiScope(scope)) {
        issues.push({ path, message: `"${scope}" is not an API scope.` });
        continue;
      }
      const missing = [...permissionsForScopes([scope])].filter((k) => !ctx.permissions.has(k));
      if (missing.length > 0) {
        issues.push({
          path,
          message: `You cannot grant "${scope}": you do not hold ${missing.join(', ')}.`,
        });
      }
    }
    return issues;
  }

  private async responsibleIssues(
    tx: Transaction,
    organizationId: string,
    membershipId: string,
  ): Promise<ValidationIssue[]> {
    // Service principals are never found by findMembershipById, so only people qualify.
    const membership = await findMembershipById(tx, organizationId, membershipId);
    if (!membership || membership.status !== 'active') {
      return [{ path: 'responsibleMembershipId', message: 'Choose an active member.' }];
    }
    const access = await getEffectiveAccess(tx, organizationId, membership.id);
    if (!access.permissions.has(ApiIntegrationPermissions.TokensManage)) {
      return [
        {
          path: 'responsibleMembershipId',
          message: 'The responsible administrator must be allowed to manage API tokens.',
        },
      ];
    }
    return [];
  }

  private async load(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const row = await getIntegration(tx, ctx.organizationId, id, { forUpdate: true });
    if (!row) throw new NotFoundError('Integration not found.');
    return row;
  }

  private async changed(tx: Transaction, ctx: AuthorizationContext, row: ApiIntegration) {
    return (await this.view(tx, ctx.organizationId, [row]))[0]!;
  }

  private assertEditable(row: ApiIntegration, version: number) {
    if (row.version !== version) throw versionConflict();
    if (row.status === 'revoked') throw invalidState('A revoked integration cannot be changed.');
  }

  // ---------------------------------------------------------------------------
  // Integrations
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: IntegrationInput, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const name = input.name.trim();
      const issues: ValidationIssue[] = [];
      if (name.length < 1 || name.length > 100) {
        issues.push({
          path: 'name',
          message: 'Give the integration a name of up to 100 characters.',
        });
      }
      const scopes = [...new Set(input.scopes)];
      if (scopes.length === 0)
        issues.push({ path: 'scopes', message: 'Grant at least one scope.' });
      issues.push(...this.scopeIssues(ctx, scopes));
      const responsibleId = input.responsibleMembershipId ?? ctx.membershipId;
      issues.push(...(await this.responsibleIssues(tx, ctx.organizationId, responsibleId)));
      const taken = (await listIntegrations(tx, ctx.organizationId)).some(
        (i) => i.status !== 'revoked' && i.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken)
        issues.push({ path: 'name', message: 'Another integration already has this name.' });
      if (issues.length) throw new ValidationError(issues);

      const now = this.now;
      // The non-human identity and its single membership; never a login, never a role.
      const serviceUser = await createServicePrincipal(tx, {
        displayName: `API integration: ${name}`.slice(0, 200),
        now,
      });
      const membership = await createMembership(tx, {
        organizationId: ctx.organizationId,
        userId: serviceUser.id,
      });
      if (!membership) throw new AppError('CONFLICT', 409, 'The integration could not be created.');
      const row = await insertIntegration(tx, {
        organizationId: ctx.organizationId,
        name,
        description: input.description?.trim() ?? '',
        serviceUserId: serviceUser.id,
        serviceMembershipId: membership.id,
        responsibleMembershipId: responsibleId,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await addScopes(tx, {
        organizationId: ctx.organizationId,
        integrationId: row.id,
        scopes,
        grantedByUserId: ctx.userId,
        now,
      });
      await this.audit(tx, ctx, 'api_integration.created', RESOURCE, row.id, origin, {
        name,
        scopes,
        responsibleMembershipId: responsibleId,
        serviceUserId: serviceUser.id,
      });
      return this.changed(tx, ctx, row);
    });
  }

  update(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      description?: string | undefined;
      scopes?: string[] | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.manage(principal, async (tx, ctx) => {
      const row = await this.load(tx, ctx, id);
      this.assertEditable(row, input.version);
      const issues: ValidationIssue[] = [];
      const set: Partial<ApiIntegration> = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (name.length < 1 || name.length > 100) {
          issues.push({
            path: 'name',
            message: 'Give the integration a name of up to 100 characters.',
          });
        } else if (
          name.toLowerCase() !== row.name.toLowerCase() &&
          (await listIntegrations(tx, ctx.organizationId)).some(
            (i) => i.status !== 'revoked' && i.name.toLowerCase() === name.toLowerCase(),
          )
        ) {
          issues.push({ path: 'name', message: 'Another integration already has this name.' });
        }
        set.name = name;
      }
      if (input.description !== undefined) set.description = input.description.trim();
      let added: string[] = [];
      let removed: string[] = [];
      if (input.scopes !== undefined) {
        const wanted = [...new Set(input.scopes)];
        if (wanted.length === 0)
          issues.push({ path: 'scopes', message: 'Grant at least one scope.' });
        const current = (await listScopes(tx, ctx.organizationId, [row.id])).get(row.id) ?? [];
        added = wanted.filter((s) => !current.includes(s));
        removed = current.filter((s) => !wanted.includes(s));
        // Only newly granted scopes need the actor to hold their permissions.
        issues.push(...this.scopeIssues(ctx, added));
        for (const scope of wanted) {
          if (!isPublicApiScope(scope) && !added.includes(scope)) {
            issues.push({ path: 'scopes', message: `"${scope}" is not an API scope.` });
          }
        }
      }
      if (issues.length) throw new ValidationError(issues);
      const now = this.now;
      if (added.length || removed.length) {
        await removeScopes(tx, ctx.organizationId, row.id, removed);
        await addScopes(tx, {
          organizationId: ctx.organizationId,
          integrationId: row.id,
          scopes: added,
          grantedByUserId: ctx.userId,
          now,
        });
      }
      const updated = await updateIntegration(tx, {
        organizationId: ctx.organizationId,
        id: row.id,
        version: input.version,
        set: { ...set, updatedByUserId: ctx.userId, updatedAt: now },
      });
      if (!updated) throw versionConflict();
      if (Object.keys(set).length > 0) {
        await this.audit(tx, ctx, 'api_integration.updated', RESOURCE, row.id, origin, {
          fields: Object.keys(set),
        });
      }
      if (added.length || removed.length) {
        await this.audit(tx, ctx, 'api_integration.scopes_changed', RESOURCE, row.id, origin, {
          added,
          removed,
        });
      }
      return this.changed(tx, ctx, updated);
    });
  }

  private transition(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    origin: EventOrigin,
    to: 'disabled' | 'active' | 'revoked',
  ) {
    return this.manage(principal, async (tx, ctx) => {
      const row = await this.load(tx, ctx, id);
      this.assertEditable(row, input.version);
      const reason = input.reason?.trim() ?? '';
      if (to === 'revoked' && reason.length === 0) {
        throw new ValidationError([
          { path: 'reason', message: 'Give a reason for revoking the integration.' },
        ]);
      }
      if (to === 'disabled' && row.status !== 'active')
        throw invalidState('The integration is not active.');
      if (to === 'active' && row.status !== 'disabled')
        throw invalidState('The integration is not disabled.');
      const now = this.now;
      const set: Partial<ApiIntegration> = {
        status: to,
        updatedByUserId: ctx.userId,
        updatedAt: now,
        ...(to === 'disabled' ? { disabledAt: now, disabledByUserId: ctx.userId } : {}),
        ...(to === 'active' ? { disabledAt: null, disabledByUserId: null } : {}),
        ...(to === 'revoked'
          ? { revokedAt: now, revokedByUserId: ctx.userId, revokeReason: reason, disabledAt: null }
          : {}),
      };
      let revokedCount = 0;
      if (to === 'revoked') {
        revokedCount = (
          await revokeIntegrationTokens(tx, {
            organizationId: ctx.organizationId,
            integrationId: row.id,
            userId: ctx.userId,
            reason: `Integration revoked: ${reason}`,
            now,
          })
        ).length;
      }
      const updated = await updateIntegration(tx, {
        organizationId: ctx.organizationId,
        id: row.id,
        version: input.version,
        set,
      });
      if (!updated) throw versionConflict();
      await this.audit(
        tx,
        ctx,
        to === 'revoked'
          ? 'api_integration.revoked'
          : to === 'disabled'
            ? 'api_integration.disabled'
            : 'api_integration.enabled',
        RESOURCE,
        row.id,
        origin,
        { reason: reason || null, revokedCount },
      );
      return this.changed(tx, ctx, updated);
    });
  }

  disable(
    p: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    o: EventOrigin,
  ) {
    return this.transition(p, id, input, o, 'disabled');
  }
  enable(p: Principal, id: string, input: { version: number }, o: EventOrigin) {
    return this.transition(p, id, input, o, 'active');
  }
  revoke(p: Principal, id: string, input: { version: number; reason: string }, o: EventOrigin) {
    return this.transition(p, id, input, o, 'revoked');
  }

  /** Reassigns the responsible administrator (a human relationship, independent of the runtime). */
  reassign(
    principal: Principal,
    id: string,
    input: { version: number; responsibleMembershipId: string },
    origin: EventOrigin,
  ) {
    return this.manage(principal, async (tx, ctx) => {
      const row = await this.load(tx, ctx, id);
      this.assertEditable(row, input.version);
      const issues = await this.responsibleIssues(
        tx,
        ctx.organizationId,
        input.responsibleMembershipId,
      );
      if (issues.length) throw new ValidationError(issues);
      const updated = await updateIntegration(tx, {
        organizationId: ctx.organizationId,
        id: row.id,
        version: input.version,
        set: {
          responsibleMembershipId: input.responsibleMembershipId,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict();
      await this.audit(
        tx,
        ctx,
        'api_integration.responsible_reassigned',
        RESOURCE,
        row.id,
        origin,
        {
          from: row.responsibleMembershipId,
          to: input.responsibleMembershipId,
        },
      );
      return this.changed(tx, ctx, updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Tokens
  // ---------------------------------------------------------------------------

  private async issueToken(
    tx: Transaction,
    ctx: AuthorizationContext,
    integration: ApiIntegration,
    input: TokenInput,
    replaces: ApiToken | null,
  ) {
    const days = input.expiresInDays ?? DEFAULT_TOKEN_LIFETIME_DAYS;
    const name = input.name.trim();
    const issues: ValidationIssue[] = [];
    if (name.length < 1 || name.length > 100) {
      issues.push({ path: 'name', message: 'Give the token a name of up to 100 characters.' });
    }
    if (!Number.isInteger(days) || days < 1 || days > MAX_TOKEN_LIFETIME_DAYS) {
      issues.push({
        path: 'expiresInDays',
        message: `A token expires in 1 to ${MAX_TOKEN_LIFETIME_DAYS} days.`,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    if (integration.status !== 'active') {
      throw invalidState('Only an active integration can receive tokens.');
    }
    const now = this.now;
    if (
      (await countActiveTokens(tx, ctx.organizationId, now)) >= MAX_ACTIVE_TOKENS_PER_ORGANIZATION
    ) {
      throw invalidState(
        `An organization can have at most ${MAX_ACTIVE_TOKENS_PER_ORGANIZATION} active tokens. Revoke one first.`,
      );
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const generated = generateToken();
      const row = await insertToken(tx, {
        organizationId: ctx.organizationId,
        integrationId: integration.id,
        publicId: generated.publicId,
        secretHash: generated.secretHash,
        name,
        createdByUserId: ctx.userId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + days * 86_400_000),
        replacesTokenId: replaces?.id ?? null,
      });
      if (row) return { row, secret: generated.token };
    }
    throw new AppError('CONFLICT', 409, 'A token could not be generated; try again.');
  }

  /** The credential is part of this response only; it cannot be read again. */
  createToken(principal: Principal, integrationId: string, input: TokenInput, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const integration = await this.load(tx, ctx, integrationId);
      const { row, secret } = await this.issueToken(tx, ctx, integration, input, null);
      await this.audit(tx, ctx, 'api_token.created', TOKEN_RESOURCE, row.id, origin, {
        integrationId: integration.id,
        publicId: row.publicId,
        expiresAt: row.expiresAt.toISOString(),
      });
      return { ...this.tokenView(row), token: secret };
    });
  }

  /**
   * Replacement semantics: a new token of the same integration (so the integration's identity,
   * scopes and idempotency namespace are unchanged) that records which token it replaces. The old
   * token keeps working until it is revoked or expires, so the integration can switch over.
   */
  rotateToken(principal: Principal, tokenId: string, input: TokenInput, origin: EventOrigin) {
    return this.manage(principal, async (tx, ctx) => {
      const old = await getToken(tx, ctx.organizationId, tokenId, { forUpdate: true });
      if (!old) throw new NotFoundError('Token not found.');
      const integration = await this.load(tx, ctx, old.integrationId);
      const { row, secret } = await this.issueToken(tx, ctx, integration, input, old);
      await this.audit(tx, ctx, 'api_token.rotated', TOKEN_RESOURCE, row.id, origin, {
        integrationId: integration.id,
        replacedId: old.id,
        publicId: row.publicId,
      });
      return { ...this.tokenView(row), token: secret };
    });
  }

  revokeToken(
    principal: Principal,
    tokenId: string,
    input: { reason: string },
    origin: EventOrigin,
  ) {
    return this.manage(principal, async (tx, ctx) => {
      const reason = input.reason.trim();
      if (!reason) {
        throw new ValidationError([
          { path: 'reason', message: 'Give a reason for revoking the token.' },
        ]);
      }
      const existing = await getToken(tx, ctx.organizationId, tokenId, { forUpdate: true });
      if (!existing) throw new NotFoundError('Token not found.');
      if (existing.revokedAt) throw invalidState('The token is already revoked.');
      const revoked = await revokeToken(tx, {
        organizationId: ctx.organizationId,
        id: tokenId,
        userId: ctx.userId,
        reason,
        now: this.now,
      });
      if (!revoked) throw invalidState('The token is already revoked.');
      await this.audit(tx, ctx, 'api_token.revoked', TOKEN_RESOURCE, tokenId, origin, {
        integrationId: existing.integrationId,
        reason,
      });
      return this.tokenView(revoked);
    });
  }
}
