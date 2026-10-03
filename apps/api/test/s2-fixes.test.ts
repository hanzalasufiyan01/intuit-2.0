import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { readMigrationFiles } from '../src/database/migrator.js';
import {
  cashSale,
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  createTestContext,
  scopeBackfillToOrganizations,
  type TestContext,
} from './helpers.js';

/** Regression tests for the approved S2 discrepancy fixes (Decisions 80, 83, 90, 91). */

let ctx: TestContext;
const origin = { requestId: null, ipAddress: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

type SystemLine = {
  accountId: string;
  description: string;
  kind: 'normal' | 'base_only';
  debit: string | null;
  credit: string | null;
  baseDebit: string | null;
  baseCredit: string | null;
};
const normalLine = (accountId: string, side: 'debit' | 'credit', amount: string): SystemLine => ({
  accountId,
  description: '',
  kind: 'normal',
  debit: side === 'debit' ? amount : null,
  credit: side === 'credit' ? amount : null,
  baseDebit: null,
  baseCredit: null,
});
const baseOnlyLine = (accountId: string, side: 'debit' | 'credit', amount: string): SystemLine => ({
  accountId,
  description: '',
  kind: 'base_only',
  debit: null,
  credit: null,
  baseDebit: side === 'debit' ? amount : null,
  baseCredit: side === 'credit' ? amount : null,
});

function systemJournal(org: AccountingOrg, type: string, lines: SystemLine[]) {
  return inTransaction(ctx.database.db, { organizationId: org.organizationId }, async (tx) => {
    await setDbContext(tx, { organizationId: org.organizationId });
    return ctx.services.journals.postSystemJournal(
      tx,
      {
        organizationId: org.organizationId,
        userId: null,
        source: { module: 'accounting', type, id: randomUUID() },
        entryDate: '2026-03-31',
        description: type,
        reference: '',
        currency: 'MVR',
        exchangeRate: null,
        lines,
      },
      origin,
    );
  });
}

describe('Decision 80 — generic reversal refuses system FX/revaluation journals by type', () => {
  it('rejects realized FX, revaluation and revaluation reversal; allows ordinary journals', async () => {
    const org = await setUpAccountingOrg(ctx);
    const usd = await org.owner.post('/accounting/accounts', {
      code: '1128',
      name: 'USD bank',
      type: 'ASSET',
      subtype: 'BANK',
      currencyCode: 'USD',
    });
    const journals = [
      // Realized FX made only of normal lines (no base-only line to detect).
      await systemJournal(org, 'realized_fx', [
        normalLine(org.accounts['1110']!, 'debit', '2.00'),
        normalLine(org.accounts['4950']!, 'credit', '2.00'),
      ]),
      await systemJournal(org, 'revaluation', [
        baseOnlyLine(usd.body.data.id, 'debit', '3.00'),
        baseOnlyLine(org.accounts['4960']!, 'credit', '3.00'),
      ]),
      await systemJournal(org, 'revaluation_reversal', [
        normalLine(org.accounts['4960']!, 'debit', '3.00'),
        normalLine(org.accounts['1110']!, 'credit', '3.00'),
      ]),
    ];
    for (const journal of journals) {
      const attempt = await org.owner.post(`/accounting/journals/${journal.id}/reverse`, {
        reason: 'manual correction attempt',
      });
      expect(attempt.status, journal.sourceType ?? '').toBe(409);
      expect(attempt.body.error.code).toBe('SYSTEM_JOURNAL');
      expect((await org.owner.get(`/accounting/journals/${journal.id}`)).body.data.status).toBe(
        'POSTED',
      );
    }

    // S8-14 (approved, supersedes the earlier expectation here): opening-balance journals are
    // reversed only with their whole opening batch, never through generic reversal.
    const opening = await systemJournal(org, 'opening_balance', [
      normalLine(org.accounts['1110']!, 'debit', '1.00'),
      normalLine(org.accounts['3900']!, 'credit', '1.00'),
    ]);
    const openingAttempt = await org.owner.post(`/accounting/journals/${opening.id}/reverse`, {
      reason: 'opening fix',
    });
    expect(openingAttempt.status).toBe(409);
    expect(openingAttempt.body.error.code).toBe('SYSTEM_JOURNAL');
    // User journals keep the normal reversal workflow.
    const manual = await postJournal(org);
    const reversed = await org.owner.post(`/accounting/journals/${manual.id}/reverse`, {
      reason: 'ordinary correction',
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.original.status).toBe('REVERSED');
  });
});

describe('Decision 83 — strict journal action contracts', () => {
  it('rejects unknown fields on approve, reject and reverse; valid bodies still work', async () => {
    const org = await setUpAccountingOrg(ctx);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    const roles = (await org.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    await org.owner.put('/approvals/policies/accounting.journal.post', {
      steps: [
        {
          name: 'Admin',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
        },
      ],
    });
    const pending = async () => {
      const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
      expect((await org.owner.post(`/accounting/journals/${draft.id}/submit`, {})).status).toBe(
        200,
      );
      return draft.id as string;
    };
    const first = await pending();
    expect(
      (await admin.client.post(`/accounting/journals/${first}/approve`, { comment: 'ok', x: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await admin.client.post(`/accounting/journals/${first}/approve`, { comment: 'ok' })).status,
    ).toBe(200);
    const second = await pending();
    expect(
      (await admin.client.post(`/accounting/journals/${second}/reject`, { because: 'no' })).status,
    ).toBe(400);
    expect((await admin.client.post(`/accounting/journals/${second}/reject`, {})).status).toBe(200);

    expect((await org.owner.post(`/accounting/journals/${first}/post`, {})).status).toBe(200);
    expect(
      (await org.owner.post(`/accounting/journals/${first}/reverse`, { reason: 'fix', hack: 1 }))
        .status,
    ).toBe(400);
    expect(
      (await org.owner.post(`/accounting/journals/${first}/reverse`, { reason: 'valid reason' }))
        .status,
    ).toBe(200);
  });

  it('accepts only an empty object on submit, post and withdraw', async () => {
    const org = await setUpAccountingOrg(ctx);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    expect(
      (await org.owner.post(`/accounting/journals/${draft.id}/submit`, { force: true })).status,
    ).toBe(400);
    expect((await org.owner.get(`/accounting/journals/${draft.id}`)).body.data.status).toBe(
      'DRAFT',
    );
    // As the web client sends it: an empty object.
    expect((await org.owner.post(`/accounting/journals/${draft.id}/submit`, {})).status).toBe(200);
    expect(
      (await org.owner.post(`/accounting/journals/${draft.id}/withdraw`, { reason: 'x' })).status,
    ).toBe(400);
    expect((await org.owner.post(`/accounting/journals/${draft.id}/withdraw`, {})).status).toBe(
      200,
    );
    expect(
      (await org.owner.post(`/accounting/journals/${draft.id}/post`, { skipApproval: true }))
        .status,
    ).toBe(400);
    expect((await org.owner.get(`/accounting/journals/${draft.id}`)).body.data.status).toBe(
      'DRAFT',
    );
    // No body at all is equivalent to {}.
    expect((await org.owner.post(`/accounting/journals/${draft.id}/post`)).status).toBe(200);
  });
});

describe('Decision 90 — additive dimension permission backfill (migration 0008)', () => {
  let owner: pg.Client;
  beforeAll(async () => {
    owner = await connectAs('owner');
  });
  afterAll(async () => {
    await owner.end();
  });

  it('grants Administrator, Member and Owner their keys, audited, and leaves custom roles alone', async () => {
    const backfillSql = readMigrationFiles().find(
      (m) => m.version === '0008_dimension_permission_backfill',
    )!.sql;
    const client = ctx.client();
    const { session } = await client.register();
    const orgId = session.activeOrganization.id;
    const other = ctx.client();
    const otherOrgId = (await other.register()).session.activeOrganization.id;
    const custom = await client.post('/organizations/current/roles', {
      name: 'Custom journals',
      permissionKeys: ['accounting.journals.view', 'accounting.journals.create'],
    });
    expect(custom.status).toBe(201);

    // The backfill spans every organization, so test files registering organizations in
    // parallel can make PostgreSQL choose this transaction as a deadlock victim (40P01).
    // Retry the whole transaction then; the assertions are unchanged.
    for (let attempt = 1; ; attempt += 1) {
      await owner.query('BEGIN');
      await scopeBackfillToOrganizations(owner, [orgId, otherOrgId]);
      try {
        // Simulate a pre-S2 organization: its system roles lack the dimension keys, and the
        // Member role carries an extra customization that must survive.
        await owner.query(
          `DELETE FROM role_permissions WHERE organization_id = $1
           AND permission_key LIKE 'accounting.dimensions.%'`,
          [orgId],
        );
        await owner.query(
          `INSERT INTO role_permissions (role_id, organization_id, permission_key)
         SELECT id, organization_id, 'audit.read' FROM roles
          WHERE organization_id = $1 AND template_key = 'member'`,
          [orgId],
        );
        const before = await owner.query(
          `SELECT count(*)::int AS n FROM role_permissions WHERE organization_id = $1`,
          [otherOrgId],
        );
        await owner.query(backfillSql);
        // Idempotent: a second run adds nothing (temp tables normally drop at commit).
        await owner.query('DROP TABLE s2_dimension_backfill_grants, s2_dimension_backfilled');
        await owner.query(backfillSql);

        const { rows } = await owner.query(
          `SELECT r.name, array_agg(rp.permission_key ORDER BY rp.permission_key)
                  FILTER (WHERE rp.permission_key LIKE 'accounting.dimensions.%') AS dims,
                array_agg(rp.permission_key ORDER BY rp.permission_key) AS keys
           FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
          WHERE r.organization_id = $1 GROUP BY r.name`,
          [orgId],
        );
        const byRole = Object.fromEntries(rows.map((r) => [r.name, r]));
        expect(byRole.Owner.dims).toEqual([
          'accounting.dimensions.manage',
          'accounting.dimensions.view',
        ]);
        expect(byRole.Administrator.dims).toEqual([
          'accounting.dimensions.manage',
          'accounting.dimensions.view',
        ]);
        expect(byRole.Member.dims).toEqual(['accounting.dimensions.view']);
        expect(byRole.Member.keys).toContain('audit.read'); // customization preserved
        expect(byRole['Custom journals'].keys).toEqual([
          'accounting.journals.create',
          'accounting.journals.view',
        ]);

        const audit = await owner.query(
          `SELECT metadata FROM audit_events
          WHERE organization_id = $1 AND action = 'role.permissions_backfilled'
            AND request_id = 'migration:0008_dimension_permission_backfill'`,
          [orgId],
        );
        expect(audit.rows.map((r) => r.metadata.roleName).sort()).toEqual([
          'Administrator',
          'Member',
          'Owner',
        ]);

        // Another organization that already had its keys is unchanged.
        const after = await owner.query(
          `SELECT count(*)::int AS n FROM role_permissions WHERE organization_id = $1`,
          [otherOrgId],
        );
        expect(after.rows[0].n).toBe(before.rows[0].n);
      } catch (error) {
        if ((error as { code?: string }).code === '40P01' && attempt < 5) continue;
        throw error;
      } finally {
        await owner.query('ROLLBACK');
      }
      break;
    }
  });

  it('is applied in sequence and recorded', async () => {
    const versions = readMigrationFiles().map((m) => m.version);
    expect(versions.slice(3)).toEqual([
      '0004_accounting_currency_classification',
      '0005_accounting_designations',
      '0006_journal_fx_lines_source_refs',
      '0007_dimensions',
      '0008_dimension_permission_backfill',
      '0009_reports_permission_backfill', // S3-02
      '0010_organization_profile', // S4
      '0011_parties', // S4
      '0012_files', // S5
      '0013_jobs', // S5
      '0014_data_exchange', // S6
      '0015_mfa', // S7
      '0016_opening_balances', // S8
      '0017_revaluation_support', // S9
      '0018_approval_conditions', // S10
      '0019_idempotency_keys', // 3B step 1
      '0020_tax_codes', // 3B step 2
      '0021_customers_items_sales_settings', // 3B steps 3-5
      '0022_sales_documents', // 3B steps 6-7, 12
      '0023_receipts_allocations', // 3B steps 8-11
      '0024_sales_integrations', // 3B steps 14-15, 18
      '0025_sales_opening_invoices', // 3B step 16
      '0026_sales_permission_backfill', // 3B step 21
      '0027_subledger_control_ownership', // 4A-1
      '0028_control_account_integrity', // 4A-1 guard (P4-08 amendment)
      '0029_vendors', // 4A-3 vendors (P4-03)
      '0030_purchases_settings_catalog', // 4A-4 (P4-05, P4-07, P4-51)
      '0031_catalog_items_permission_backfill', // 4A-4 (P4-06)
      '0032_input_tax', // input-tax stage (P4-11, P4-12, P4-13)
      '0033_bills', // 4A-5 bills (P4-15 to P4-22)
      '0034_opening_balance_ap_guard', // P4-36
    ]);
    const { rows } = await owner.query(
      `SELECT version FROM schema_migrations WHERE version = '0008_dimension_permission_backfill'`,
    );
    expect(rows).toHaveLength(1);
  });
});

describe('Decision 91 — dimension view permission on journals', () => {
  async function setUp() {
    const org = await setUpAccountingOrg(ctx);
    const type = (
      await org.owner.post('/accounting/dimensions', { code: 'DEPT', name: 'Department' })
    ).body.data;
    const sales = (
      await org.owner.post(`/accounting/dimensions/${type.id}/values`, { code: 'S', name: 'Sales' })
    ).body.data.id as string;
    const ops = (
      await org.owner.post(`/accounting/dimensions/${type.id}/values`, { code: 'O', name: 'Ops' })
    ).body.data.id as string;
    await org.owner.post('/organizations/current/roles', {
      name: 'Journal clerk',
      permissionKeys: [
        'accounting.journals.view',
        'accounting.journals.create',
        'accounting.journals.edit_draft',
      ],
    });
    const clerk = await joinWithRole(ctx, org.owner, 'Journal clerk');
    const tag = (valueId: string) => [{ dimensionTypeId: type.id, dimensionValueId: valueId }];
    return { org, clerk: clerk.client, typeId: type.id as string, sales, ops, tag };
  }

  const body = (org: AccountingOrg, dims?: object[]) => ({
    entryDate: '2026-03-15',
    description: 'Sale',
    currency: 'MVR',
    lines: [
      line(org.accounts['1110']!, 'debit', '10.00'),
      { ...line(org.accounts['4100']!, 'credit', '10.00'), ...(dims ? { dimensions: dims } : {}) },
    ],
  });

  it('forbids adding new assignments without accounting.dimensions.view', async () => {
    const { org, clerk, sales, ops, tag } = await setUp();
    expect((await clerk.post('/accounting/journals', body(org, tag(sales)))).status).toBe(403);
    const plain = await clerk.post('/accounting/journals', body(org));
    expect(plain.status).toBe(201);
    expect(
      (await clerk.patch(`/accounting/journals/${plain.body.data.id}`, body(org, tag(sales))))
        .status,
    ).toBe(403);

    // A journal tagged by someone with the permission.
    const tagged = (await org.owner.post('/accounting/journals', body(org, tag(sales)))).body.data;
    // Unrelated edits keep the existing assignment.
    expect(
      (await clerk.patch(`/accounting/journals/${tagged.id}`, { description: 'Renamed' })).status,
    ).toBe(200);
    // Lines sent without dimensions (as the web editor does for this user) keep them too.
    const relined = await clerk.patch(`/accounting/journals/${tagged.id}`, {
      lines: [
        line(org.accounts['1110']!, 'debit', '12.00'),
        line(org.accounts['4100']!, 'credit', '12.00'),
      ],
    });
    expect(relined.status).toBe(200);
    // Re-sending the existing assignment explicitly is not a new assignment.
    expect(
      (await clerk.patch(`/accounting/journals/${tagged.id}`, body(org, tag(sales)))).status,
    ).toBe(200);
    // Swapping it for another value is.
    expect(
      (await clerk.patch(`/accounting/journals/${tagged.id}`, body(org, tag(ops)))).status,
    ).toBe(403);
    const lines = (await org.owner.get(`/accounting/journals/${tagged.id}`)).body.data.lines;
    expect(lines[1].dimensions).toEqual([expect.objectContaining({ dimensionValueId: sales })]);
  });

  it('omits dimension details from journal responses without the permission', async () => {
    const { org, clerk, sales, tag } = await setUp();
    const tagged = (await org.owner.post('/accounting/journals', body(org, tag(sales)))).body.data;
    expect(tagged.lines[1].dimensions).toEqual([
      expect.objectContaining({
        typeName: 'Department',
        valueName: 'Sales',
        dimensionValueId: sales,
      }),
    ]);
    const seen = (await clerk.get(`/accounting/journals/${tagged.id}`)).body.data;
    for (const l of seen.lines) expect(l).not.toHaveProperty('dimensions');
    expect(JSON.stringify(seen)).not.toContain(sales);
    // Mutation responses follow the same rule.
    const edited = (await clerk.patch(`/accounting/journals/${tagged.id}`, { description: 'x' }))
      .body.data;
    expect(edited.lines[1]).not.toHaveProperty('dimensions');
  });
});

describe('Decision 92 — ledger dimension filter permission', () => {
  async function setUp() {
    const org = await setUpAccountingOrg(ctx);
    const type = (
      await org.owner.post('/accounting/dimensions', { code: 'DEPT', name: 'Department' })
    ).body.data;
    const value = (
      await org.owner.post(`/accounting/dimensions/${type.id}/values`, {
        code: 'SALES',
        name: 'Sales',
      })
    ).body.data.id as string;
    await postJournal(org, {
      entryDate: '2026-03-15',
      description: 'Tagged sale',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '30.00'),
        {
          ...line(org.accounts['4100']!, 'credit', '30.00'),
          dimensions: [{ dimensionTypeId: type.id, dimensionValueId: value }],
        },
      ],
    } as never);
    await postJournal(org, cashSale(org, '5.00'));
    await org.owner.post('/organizations/current/roles', {
      name: 'Ledger reader',
      permissionKeys: ['accounting.ledger.view'],
    });
    await org.owner.post('/organizations/current/roles', {
      name: 'Ledger analyst',
      permissionKeys: ['accounting.ledger.view', 'accounting.dimensions.view'],
    });
    const reader = (await joinWithRole(ctx, org.owner, 'Ledger reader')).client;
    const analyst = (await joinWithRole(ctx, org.owner, 'Ledger analyst')).client;
    return { org, reader, analyst, value };
  }

  it('allows dimension filtering with ledger.view and dimensions.view', async () => {
    const { org, analyst, value } = await setUp();
    const filtered = await analyst.get(
      `/accounting/ledger?accountId=${org.accounts['4100']}&dimensionValueIds=${value}`,
    );
    expect(filtered.status).toBe(200);
    expect(filtered.body.data).toMatchObject({
      taggedActivityOnly: true,
      dimensionFilter: [expect.objectContaining({ typeName: 'Department', valueName: 'Sales' })],
      totals: { baseDebit: '0', baseCredit: '30.0000' },
    });
    expect(filtered.body.data.rows).toHaveLength(1);
    const unfiltered = (await analyst.get(`/accounting/ledger?accountId=${org.accounts['4100']}`))
      .body.data;
    expect(unfiltered).toMatchObject({ taggedActivityOnly: false, dimensionFilter: [] });
    expect(unfiltered.totals.baseCredit).toBe('35.0000');
  });

  it('returns 403 without dimensions.view and reveals no dimension metadata', async () => {
    const { org, reader, value } = await setUp();
    const denied = await reader.get(`/accounting/ledger?dimensionValueIds=${value}`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('PERMISSION_DENIED');
    const text = JSON.stringify(denied.body);
    for (const leak of ['Department', 'Sales', 'DEPT', 'SALES', 'taggedActivityOnly', 'rows']) {
      expect(text).not.toContain(leak);
    }
    // An unknown or foreign value id gets the same 403: the check precedes any lookup.
    expect((await reader.get(`/accounting/ledger?dimensionValueIds=${randomUUID()}`)).status).toBe(
      403,
    );
    // The unfiltered ledger is unchanged for this user.
    const unfiltered = await reader.get(`/accounting/ledger?accountId=${org.accounts['4100']}`);
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.data).toMatchObject({ taggedActivityOnly: false, dimensionFilter: [] });
    expect(unfiltered.body.data.totals.baseCredit).toBe('35.0000');
  });

  it('keeps tenant isolation for authorized users', async () => {
    const a = await setUp();
    const b = await setUp();
    // B's analyst cannot filter by A's value: it is unknown in B's organization.
    const cross = await b.analyst.get(`/accounting/ledger?dimensionValueIds=${a.value}`);
    expect(cross.status).toBe(400);
    expect(JSON.stringify(cross.body)).not.toContain('Sales');
    // B's own filter only sees B's activity.
    const own = (await b.analyst.get(`/accounting/ledger?dimensionValueIds=${b.value}`)).body.data;
    expect(own.rows.every((r: { journalId: string }) => typeof r.journalId === 'string')).toBe(
      true,
    );
    expect(own.totals.baseCredit).toBe('30.0000');
    expect(a.org.organizationId).not.toBe(b.org.organizationId);
  });
});
