import { describe, expect, it } from 'vitest';
import { permissionCatalog } from '../src/application/permission-catalog.js';
import { roleTemplateDefinitions } from '../src/application/role-templates.js';
import { ConfigError, loadConfig } from '../src/infrastructure/config/config.js';
import {
  PermissionCatalogError,
  validatePermissionCatalog,
} from '../src/modules/access-control/permission-catalog.js';
import { sanitizeMetadata } from '../src/modules/audit/events.js';
import { evaluateSession, type Session } from '../src/modules/identity/sessions.js';
import {
  effectiveInvitationStatus,
  type Invitation,
} from '../src/modules/organizations/invitations.js';

const baseEnv = {
  APP_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgres://intuit_app:x@localhost:5432/intuit2_dev',
  SESSION_SECRET: 'a'.repeat(40),
};

describe('configuration', () => {
  it('applies the approved security defaults', () => {
    const config = loadConfig(baseEnv);
    expect(config.session.idleTimeoutMs).toBe(30 * 60_000);
    expect(config.session.absoluteLifetimeMs).toBe(7 * 24 * 60 * 60_000);
    expect(config.session.reauthWindowMs).toBe(15 * 60_000);
    expect(config.password.minLength).toBe(12);
    expect(config.loginProtection).toMatchObject({ maxFailedAttempts: 5, windowMs: 15 * 60_000 });
    expect(config.invitations.expiryMs).toBe(72 * 60 * 60_000);
    expect(config.password.resetTokenTtlMs).toBe(60 * 60_000);
    expect(
      loadConfig({ ...baseEnv, PASSWORD_RESET_TOKEN_TTL_MINUTES: '60' }).password.resetTokenTtlMs,
    ).toBe(60 * 60_000);
    expect(config.session.cookieSecure).toBe(false);
    expect(loadConfig({ ...baseEnv, APP_ENV: 'production' }).session.cookieSecure).toBe(true);
  });

  it('fails fast on invalid configuration without echoing secrets', () => {
    expect(() => loadConfig({ ...baseEnv, SESSION_SECRET: 'short-secret-value' })).toThrow(
      ConfigError,
    );
    try {
      loadConfig({ ...baseEnv, SESSION_SECRET: 'short-secret-value', DATABASE_URL: 'mysql://x' });
    } catch (error) {
      expect(String(error)).toContain('SESSION_SECRET');
      expect(String(error)).toContain('DATABASE_URL');
      expect(String(error)).not.toContain('short-secret-value');
    }
  });
});

describe('permission catalog', () => {
  it('forbids invoices.delete and malformed or duplicate keys', () => {
    const def = (key: string) => ({ key, module: 't', description: 'd' });
    expect(() => validatePermissionCatalog([def('invoices.delete')])).toThrow(
      PermissionCatalogError,
    );
    expect(() => validatePermissionCatalog([def('Invoices.Delete')])).toThrow(
      PermissionCatalogError,
    );
    expect(() => validatePermissionCatalog([def('a.b'), def('a.b')])).toThrow(
      PermissionCatalogError,
    );
    expect(() =>
      validatePermissionCatalog([def('invoices.delete_draft'), def('invoices.void')]),
    ).not.toThrow();
  });

  it('defines the approved Phase 1 catalog and templates', () => {
    expect(permissionCatalog.map((p) => p.key).sort()).toEqual([
      'audit.read',
      'members.invite',
      'members.manage',
      'members.read',
      'organization.read',
      'organization.update',
      'roles.manage',
      'roles.read',
    ]);
    const templates = Object.fromEntries(roleTemplateDefinitions.map((t) => [t.key, t]));
    expect(templates.owner?.permissions).toBe('all');
    expect(templates.owner?.isOwner).toBe(true);
    expect(templates.administrator?.permissions).toHaveLength(8);
    expect(templates.member?.permissions).toEqual(['organization.read', 'members.read']);
  });
});

describe('session rules', () => {
  const policy = { idleTimeoutMs: 30 * 60_000, absoluteLifetimeMs: 7 * 24 * 60 * 60_000 };
  const start = new Date('2026-01-01T00:00:00Z');
  const session = (overrides: Partial<Session> = {}): Session => ({
    id: 's',
    userId: 'u',
    tokenHash: Buffer.alloc(32),
    activeOrganizationId: null,
    createdAt: start,
    lastSeenAt: start,
    expiresAt: new Date(start.getTime() + policy.absoluteLifetimeMs),
    reauthenticatedAt: start,
    revokedAt: null,
    revokedReason: null,
    ipAddress: null,
    userAgent: null,
    ...overrides,
  });
  const at = (ms: number) => new Date(start.getTime() + ms);
  const active = { status: 'active' as const };

  it('evaluates revocation, disablement, idle timeout and absolute expiry', () => {
    expect(evaluateSession(session(), active, at(29 * 60_000), policy)).toBe('valid');
    expect(evaluateSession(session(), active, at(30 * 60_000), policy)).toBe('idle_timeout');
    expect(
      evaluateSession(
        session({ lastSeenAt: at(policy.absoluteLifetimeMs - 60_000) }),
        active,
        at(policy.absoluteLifetimeMs),
        policy,
      ),
    ).toBe('expired');
    expect(
      evaluateSession(
        session({ revokedAt: start, revokedReason: 'logout' }),
        active,
        start,
        policy,
      ),
    ).toBe('revoked');
    expect(evaluateSession(session(), { status: 'disabled' }, start, policy)).toBe('user_disabled');
  });
});

describe('audit metadata', () => {
  it('drops secret-looking keys at any depth', () => {
    expect(
      sanitizeMetadata({
        email: 'a@example.test',
        password: 'x',
        nested: { resetToken: 'y', keep: 1, list: [{ sessionSecret: 'z', ok: true }] },
      }),
    ).toEqual({ email: 'a@example.test', nested: { keep: 1, list: [{ ok: true }] } });
  });
});

describe('invitation status', () => {
  it('treats lapsed pending invitations as expired', () => {
    const invitation = {
      status: 'pending',
      expiresAt: new Date('2026-01-04T00:00:00Z'),
    } as Invitation;
    expect(effectiveInvitationStatus(invitation, new Date('2026-01-03T23:59:59Z'))).toBe('pending');
    expect(effectiveInvitationStatus(invitation, new Date('2026-01-04T00:00:00Z'))).toBe('expired');
    expect(
      effectiveInvitationStatus({ ...invitation, status: 'accepted' }, new Date('2027-01-01')),
    ).toBe('accepted');
  });
});
