import { describe, expect, it } from 'vitest';
import { permissionCatalog } from '../src/application/permission-catalog.js';
import { roleTemplateDefinitions } from '../src/application/role-templates.js';
import {
  createSourceDocumentRegistry,
  SourceDocumentRegistry,
} from '../src/application/source-documents.js';
import { settleApCredit, settlePayment, settleRefund } from '../src/modules/documents/index.js';
import { decimal } from '../src/domain/money.js';
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
  // S7-09: a test-only key ring (never a real key).
  MFA_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
  MFA_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
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

  it('defines the approved Phase 1 – Phase 4 catalog and templates', () => {
    const keys = permissionCatalog.map((p) => p.key).sort();
    expect(keys).toEqual([
      'accounting.accounts.archive',
      'accounting.accounts.create',
      'accounting.accounts.delete',
      'accounting.accounts.update',
      'accounting.accounts.view',
      'accounting.dimensions.manage', // Phase 3A (Decision 65)
      'accounting.dimensions.view', // Phase 3A (Decision 65)
      'accounting.journals.approve',
      'accounting.journals.create',
      'accounting.journals.edit_draft',
      'accounting.journals.post',
      'accounting.journals.reverse',
      'accounting.journals.submit',
      'accounting.journals.view',
      'accounting.ledger.view',
      'accounting.periods.close',
      'accounting.periods.reopen',
      'accounting.periods.view',
      'accounting.reports.view', // Phase 3A S3 (Decision 65, S3-01)
      'accounting.setup',
      'approvals.manage',
      'audit.read',
      'bills.approve', // Phase 4A-5 (ADR 0004 P4-39)
      'bills.create',
      'bills.delete_draft',
      'bills.edit_draft',
      'bills.post',
      'bills.view',
      'bills.void',
      'catalog.items.manage', // Phase 4A-4 (ADR 0004 P4-06)
      'credit_notes.approve', // Phase 3B (D11, Decision 30)
      'credit_notes.create',
      'credit_notes.issue',
      'credit_notes.view',
      'customers.archive', // Phase 3B (D11)
      'customers.create',
      'customers.update',
      'customers.view',
      'invoices.approve', // Phase 3B (D11, Decision 30)
      'invoices.create',
      'invoices.delete_draft',
      'invoices.edit_draft',
      'invoices.issue',
      'invoices.view',
      'invoices.void',
      'members.invite',
      'members.manage',
      'members.read',
      'organization.read',
      'organization.update',
      'parties.archive', // Phase 3A S4 (Decision 65)
      'parties.create',
      'parties.update',
      'parties.view',
      'purchases.reports.view', // Phase 4B-5 (ADR 0004 P4-39, PD3)
      'purchases.settings.manage', // Phase 4A-4 (ADR 0004 P4-39)
      'receipts.create', // Phase 3B (D11, Decision 40)
      'receipts.view',
      'receipts.void',
      'roles.manage',
      'roles.read',
      'sales.items.manage', // Phase 3B (Decision 31)
      'sales.reports.view',
      'sales.settings.manage',
      'tax.codes.manage', // Phase 3B (Decision 60)
      'vendor_credits.approve', // Phase 4B-1 (ADR 0004 P4-39)
      'vendor_credits.create',
      'vendor_credits.post',
      'vendor_credits.view',
      'vendor_credits.void',
      'vendor_payments.approve', // Phase 4B-2 (ADR 0004 P4-39)
      'vendor_payments.create',
      'vendor_payments.view',
      'vendor_payments.void',
      'vendors.archive', // Phase 4 (ADR 0004 P4-39)
      'vendors.create',
      'vendors.update',
      'vendors.view',
    ]);
    const templates = Object.fromEntries(roleTemplateDefinitions.map((t) => [t.key, t]));
    expect(templates.owner?.permissions).toBe('all');
    expect(templates.owner?.isOwner).toBe(true);
    // Decision F25: Administrator gets every permission; Member gets accounting view access.
    expect([...(templates.administrator?.permissions ?? [])].sort()).toEqual(keys);
    expect([...(templates.member?.permissions ?? [])].sort()).toEqual([
      'accounting.accounts.view',
      'accounting.dimensions.view', // Phase 3A (Decision 65)
      'accounting.journals.view',
      'accounting.ledger.view',
      'accounting.periods.view',
      'accounting.reports.view', // Phase 3A S3 (Decision 65, S3-01)
      'bills.view', // Phase 4A-5 (ADR 0004 P4-40)
      'credit_notes.view', // Phase 3B (D14): Sales view-only
      'customers.view',
      'invoices.view',
      'members.read',
      'organization.read',
      'parties.view', // Phase 3A S4 (Decision 65)
      'purchases.reports.view', // Phase 4B-5 (P4-40, PD3)
      'receipts.view',
      'sales.reports.view',
      'vendor_credits.view', // Phase 4B-1 (P4-40)
      'vendor_payments.view', // Phase 4B-2 (P4-40)
      'vendors.view', // Phase 4 (ADR 0004 P4-40)
    ]);
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
    mfaPendingUntil: null,
    mfaMethod: null,
    mfaVerifiedAt: null,
    mfaFailedAttempts: 0,
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

describe('source-document registry (P4-10, 4B-2 A5)', () => {
  it('resolves only registered references and refuses duplicate resolvers', async () => {
    const registry = new SourceDocumentRegistry();
    const tx = {} as never;
    expect(await registry.resolve(tx, 'org', null)).toBeNull();
    expect(
      await registry.resolve(tx, 'org', { module: 'payroll', type: 'run', id: 'x' }),
    ).toBeNull();
    registry.register('purchases', 'bill', async () => null);
    expect(() => registry.register('purchases', 'bill', async () => null)).toThrow(/already/);
    // The built-in registry covers the subledger documents that post journals.
    expect(() => createSourceDocumentRegistry()).not.toThrow();
  });
});

describe('AP settlement (4B-2, the AP FX sign)', () => {
  const open = (amountDue: string, baseDue: string) => ({
    amountDue: decimal(amountDue),
    baseDue: decimal(baseDue),
  });
  it('values parts at the payment rate and relieves historical base (positive fx = gain)', () => {
    const settled = settlePayment({
      amount: decimal('250'),
      rate: decimal('15.5'),
      baseCurrency: 'MVR',
      allocations: [
        { billId: 'a', amount: decimal('100'), open: open('100', '1542') },
        { billId: 'b', amount: decimal('100'), open: open('100', '1560') },
      ],
    });
    expect(settled.parts.map((p) => [p.billId, p.sourceBase.toFixed(2), p.fx.toFixed(2)])).toEqual([
      ['a', '1550.00', '-8.00'],
      ['b', '1550.00', '10.00'],
    ]);
    expect(settled.unallocated.toFixed(2)).toBe('50.00');
    expect(settled.baseAmount.toFixed(2)).toBe('3875.00');
  });
  it('releases credit at its historical base and relieves the final balance in full', () => {
    const parts = settleApCredit({
      source: open('50', '775'),
      baseCurrency: 'MVR',
      allocations: [
        { billId: 'a', amount: decimal('30'), open: open('30', '462.6') },
        { billId: 'b', amount: decimal('20'), open: open('100', '1542') },
      ],
    });
    expect(
      parts.map((p) => [p.sourceBase.toFixed(2), p.baseRelieved.toFixed(2), p.fx.toFixed(2)]),
    ).toEqual([
      ['465.00', '462.60', '-2.40'],
      ['310.00', '308.40', '-1.60'],
    ]);
  });
});

describe('vendor refund settlement (4B-3, fx = received − released)', () => {
  it('releases the historical base proportionally and realizes the difference (positive = gain)', () => {
    const source = { amountDue: decimal('100'), baseDue: decimal('1542') };
    const gain = settleRefund({
      amount: decimal('50'),
      rate: decimal('15.5'),
      baseCurrency: 'MVR',
      source,
    });
    expect([gain.baseReceived, gain.baseReleased, gain.fx].map((d) => d.toFixed(2))).toEqual([
      '775.00',
      '771.00',
      '4.00',
    ]);
    const loss = settleRefund({
      amount: decimal('100'),
      rate: decimal('15.3'),
      baseCurrency: 'MVR',
      source,
    });
    // The final refund releases the whole remaining base.
    expect([loss.baseReleased, loss.fx].map((d) => d.toFixed(2))).toEqual(['1542.00', '-12.00']);
    const flat = settleRefund({
      amount: decimal('40'),
      rate: decimal('1'),
      baseCurrency: 'MVR',
      source: { amountDue: decimal('40'), baseDue: decimal('40') },
    });
    expect(flat.fx.isZero()).toBe(true);
  });
});
