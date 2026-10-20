import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/** Payslip PDFs (payroll) and expense claims by claimant (management report). */

let ctx: TestContext;
let db: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  db = await connectAs('owner');
});
afterAll(async () => {
  await db.end();
  await ctx.close();
});

async function payrollOrg() {
  const org = await setUpAccountingOrg(ctx);
  expect(
    (await org.owner.put('/organizations/current/modules/payroll', { enabled: true })).status,
  ).toBe(200);
  const liability = await org.owner.post('/accounting/accounts', {
    code: '2150',
    name: 'Net pay payable',
    type: 'LIABILITY',
    subtype: 'OTHER_CURRENT_LIABILITY',
  });
  const settings = await org.owner.put('/payroll/settings', {
    version: 0,
    basicSalaryExpenseAccountId: org.accounts['5200'],
    netPayPayableAccountId: liability.body.data.id,
    proration: 'calendar_days',
    requireSeparateApprover: false,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  await org.owner.post('/organizations/current/roles', {
    name: 'Staff',
    permissionKeys: ['organization.read'],
  });
  const staff = await joinWithRole(ctx, org.owner, 'Staff');
  const employee = await org.owner.post('/payroll/employees', {
    displayName: 'Ahmed Ali',
    hireDate: '2025-01-01',
    basicSalary: '8000',
    linkedMembershipId: staff.membershipId,
    components: [],
  });
  expect(employee.status, JSON.stringify(employee.body)).toBe(201);
  return { ...org, staff };
}

async function run(o: Awaited<ReturnType<typeof payrollOrg>>, post: boolean) {
  const created = await o.owner.post('/payroll/runs', {
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    payDate: '2026-03-31',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  if (!post) return created.body.data;
  const approved = await o.owner.post(`/payroll/runs/${created.body.data.id}/approve`, {
    version: created.body.data.version,
  });
  const posted = await o.owner.post(`/payroll/runs/${created.body.data.id}/post`, {
    version: approved.body.data.version,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data;
}

describe('payslip PDF', () => {
  it('renders a posted payslip for the employee and for payroll managers, and audits each download', async () => {
    const o = await payrollOrg();
    const posted = await run(o, true);
    const slipId = posted.payslips[0].id;
    const mine = await o.staff.client.get(`/payroll/my-payslips/${slipId}/pdf`);
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.headers['content-type']).toBe('application/pdf');
    expect(mine.headers['cache-control']).toBe('no-store');
    expect(mine.headers['content-disposition']).toContain('.pdf');
    expect(mine.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const manager = await o.owner.get(`/payroll/payslips/${slipId}/pdf`);
    expect(manager.status).toBe(200);
    expect(manager.raw.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const audit = await db.query(
      `SELECT metadata->>'scope' AS scope FROM audit_events WHERE organization_id = $1 AND action = 'payroll.payslip_downloaded' ORDER BY occurred_at`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { scope: string }) => r.scope)).toEqual(['own', 'any']);
  });

  it('keeps payslips private: other people, other organizations, draft runs for employees', async () => {
    const o = await payrollOrg();
    const other = await payrollOrg();
    const draftRun = await run(o, false);
    const draftId = draftRun.payslips[0].id;
    // An employee cannot fetch a payslip of an unposted run.
    expect((await o.staff.client.get(`/payroll/my-payslips/${draftId}/pdf`)).status).toBe(404);
    // A manager can, and the page says it is not final (the PDF is rendered either way).
    expect((await o.owner.get(`/payroll/payslips/${draftId}/pdf`)).status).toBe(200);
    // Staff without payroll.view cannot use the manager route; others cannot use the self route.
    expect((await o.staff.client.get(`/payroll/payslips/${draftId}/pdf`)).status).toBe(403);
    const posted = await run(other, true);
    const foreignId = posted.payslips[0].id;
    expect((await o.owner.get(`/payroll/payslips/${foreignId}/pdf`)).status).toBe(404);
    expect((await o.staff.client.get(`/payroll/my-payslips/${foreignId}/pdf`)).status).toBe(404);
    expect((await ctx.client().get(`/payroll/my-payslips/${foreignId}/pdf`)).status).toBe(401);
    expect((await o.owner.get('/payroll/payslips/not-a-uuid/pdf')).status).toBe(400);
  });
});

describe('expense claims by claimant', () => {
  async function claimOrg() {
    const org = await setUpAccountingOrg(ctx);
    expect(
      (
        await org.owner.put('/purchases/settings', {
          version: 0,
          apAccountId: org.accounts['2110'],
          defaultExpenseAccountId: org.accounts['5400'],
          defaultPaymentAccountId: org.accounts['1120'],
          defaultTaxCodeId: null,
          defaultTaxTreatment: 'exclusive',
          defaultPaymentTermsDays: 30,
        })
      ).status,
    ).toBe(200);
    return org;
  }
  const claimant = async (o: AccountingOrg, name: string) =>
    (
      await o.owner.post('/parties', {
        kind: 'individual',
        displayName: name,
        roles: ['employee'],
      })
    ).body.data.id as string;
  const claim = async (o: AccountingOrg, partyId: string, amount: string, date: string) => {
    const created = await o.owner.post('/expense-claims', {
      employeePartyId: partyId,
      claimDate: date,
      memo: 'Trip',
      lines: [{ expenseDate: date, description: 'Taxi', amount }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const submitted = await o.owner.post(`/expense-claims/${created.body.data.id}/submit`, {
      version: created.body.data.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return submitted.body.data;
  };

  it('totals approved claims per claimant for a date range and respects permissions and tenants', async () => {
    const o = await claimOrg();
    const aisha = await claimant(o, 'Aishath Ali');
    const hassan = await claimant(o, 'Hassan Rasheed');
    await claim(o, aisha, '60.00', '2026-03-10');
    await claim(o, aisha, '40.50', '2026-03-20');
    await claim(o, hassan, '99.00', '2026-03-12');
    await claim(o, hassan, '500.00', '2026-05-01'); // outside the range
    const res = await o.owner.get(
      '/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.claimants).toEqual([
      expect.objectContaining({
        displayName: 'Aishath Ali',
        claims: 2,
        approved: '100.5',
        total: '100.5',
      }),
      expect.objectContaining({
        displayName: 'Hassan Rasheed',
        claims: 1,
        approved: '99',
        total: '99',
      }),
    ]);
    expect(res.body.data.totals).toEqual({ claims: 3, total: '199.5' });
    const other = await claimOrg();
    expect(
      (await other.owner.get('/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31'))
        .body.data.claimants,
    ).toEqual([]);
    expect(
      (await o.owner.get('/expense-claims/reports/by-claimant?from=2026-03-31&to=2026-03-01'))
        .status,
    ).toBe(400);
    expect(
      (await o.owner.get('/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31&x=1'))
        .status,
    ).toBe(400);
    await o.owner.post('/organizations/current/roles', {
      name: 'Staff',
      permissionKeys: ['organization.read'],
    });
    const staff = await joinWithRole(ctx, o.owner, 'Staff');
    expect(
      (await staff.client.get('/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31'))
        .status,
    ).toBe(403);
    expect(
      (await ctx.client().get('/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31'))
        .status,
    ).toBe(401);
  });
});
