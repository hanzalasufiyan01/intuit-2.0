import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Payroll v1 (FP-25): the module switch, settings, components, employees, the pay-run workflow
 * (draft, approve, post, pay, void), the ledger result, duplicate protection, permissions, tenant
 * isolation, employee self-service and the database guards. Real PostgreSQL.
 */

let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

interface PayrollOrg extends AccountingOrg {
  accrued: string; // net pay payable
  pensionPayable: string;
  allowance: string; // component ids
  pension: string;
  employerPension: string;
}

async function newAccount(
  o: AccountingOrg,
  code: string,
  name: string,
  type: string,
  subtype: string,
) {
  const res = await o.owner.post('/accounting/accounts', { code, name, type, subtype });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

async function payrollOrg(
  options: { enable?: boolean; separateApprover?: boolean } = {},
): Promise<PayrollOrg> {
  const org = await setUpAccountingOrg(ctx);
  if (options.enable !== false) {
    const enabled = await org.owner.put('/organizations/current/modules/payroll', {
      enabled: true,
    });
    expect(enabled.status, JSON.stringify(enabled.body)).toBe(200);
  }
  const accrued = await newAccount(
    org,
    '2150',
    'Net pay payable',
    'LIABILITY',
    'OTHER_CURRENT_LIABILITY',
  );
  const pensionPayable = await newAccount(
    org,
    '2160',
    'Pension payable',
    'LIABILITY',
    'OTHER_CURRENT_LIABILITY',
  );
  const allowanceExpense = await newAccount(
    org,
    '5210',
    'Allowances',
    'EXPENSE',
    'OPERATING_EXPENSE',
  );
  const pensionExpense = await newAccount(
    org,
    '5220',
    'Employer pension',
    'EXPENSE',
    'OPERATING_EXPENSE',
  );
  const result = {
    ...org,
    accrued,
    pensionPayable,
    allowance: '',
    pension: '',
    employerPension: '',
  };
  if (options.enable === false) return result;
  const settings = await org.owner.put('/payroll/settings', {
    version: 0,
    basicSalaryExpenseAccountId: org.accounts['5200'],
    netPayPayableAccountId: accrued,
    proration: 'calendar_days',
    requireSeparateApprover: options.separateApprover ?? true,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const component = async (body: object) => {
    const res = await org.owner.post('/payroll/components', body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data.id as string;
  };
  result.allowance = await component({
    code: 'ALLOW',
    name: 'Housing allowance',
    kind: 'earning',
    calculation: 'fixed',
    defaultValue: '500',
    expenseAccountId: allowanceExpense,
  });
  result.pension = await component({
    code: 'PENS',
    name: 'Employee pension',
    kind: 'deduction',
    calculation: 'percent_of_basic',
    defaultValue: '7',
    liabilityAccountId: pensionPayable,
  });
  result.employerPension = await component({
    code: 'EPENS',
    name: 'Employer pension',
    kind: 'employer_contribution',
    calculation: 'percent_of_basic',
    defaultValue: '7',
    expenseAccountId: pensionExpense,
    liabilityAccountId: pensionPayable,
  });
  return result;
}

async function employee(o: PayrollOrg, name: string, salary: string, extra: object = {}) {
  const res = await o.owner.post('/payroll/employees', {
    displayName: name,
    hireDate: '2025-01-01',
    basicSalary: salary,
    components: [
      { componentId: o.allowance },
      { componentId: o.pension },
      { componentId: o.employerPension },
    ],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const createRun = (
  o: PayrollOrg,
  period = { periodStart: '2026-03-01', periodEnd: '2026-03-31', payDate: '2026-04-02' },
) => o.owner.post('/payroll/runs', period);

async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await owner.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

describe('module switch', () => {
  it('keeps payroll off until an administrator enables it, and audits the change', async () => {
    const o = await payrollOrg({ enable: false });
    const off = await o.owner.get('/payroll/employees');
    expect(off.status).toBe(403);
    expect(off.body.error.code).toBe('MODULE_DISABLED');
    expect((await o.owner.get('/organizations/current/modules')).body.data.modules).toEqual({
      payroll: false,
      projects: false,
      clinic: false,
    });
    const on = await o.owner.put('/organizations/current/modules/payroll', { enabled: true });
    expect(on.body.data.modules.payroll).toBe(true);
    expect((await o.owner.get('/payroll/employees')).status).toBe(200);
    const { rows } = await owner.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'organization.module_%'`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['organization.module_enabled']);
    expect(
      (await o.owner.put('/organizations/current/modules/unknown', { enabled: true })).status,
    ).toBe(400);
    expect(
      (await o.owner.put('/organizations/current/modules/payroll', { enabled: 'yes' })).status,
    ).toBe(400);
    // A member cannot switch modules.
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.put('/organizations/current/modules/payroll', { enabled: false }))
        .status,
    ).toBe(403);
    // Another organization is unaffected.
    const other = await payrollOrg({ enable: false });
    expect((await other.owner.get('/payroll/employees')).body.error.code).toBe('MODULE_DISABLED');
  });
});

describe('settings, components and employees', () => {
  it('validates accounts by role and keeps components consistent', async () => {
    const o = await payrollOrg();
    const wrong = await o.owner.put('/payroll/settings', {
      version: 1,
      basicSalaryExpenseAccountId: o.accounts['1120'], // a bank account
      netPayPayableAccountId: o.accounts['2110'], // the AP control account
      proration: 'none',
      requireSeparateApprover: true,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'basicSalaryExpenseAccountId',
      'netPayPayableAccountId',
    ]);
    const stale = await o.owner.put('/payroll/settings', {
      version: 9,
      basicSalaryExpenseAccountId: o.accounts['5200'],
      netPayPayableAccountId: o.accrued,
      proration: 'none',
      requireSeparateApprover: true,
    });
    expect(stale.status).toBe(409);
    const badComponents = [
      {
        code: 'lower',
        name: 'x',
        kind: 'earning',
        calculation: 'fixed',
        defaultValue: '1',
        expenseAccountId: o.accounts['5200'],
      },
      {
        code: 'GROSS',
        name: 'x',
        kind: 'earning',
        calculation: 'percent_of_gross',
        defaultValue: '1',
        expenseAccountId: o.accounts['5200'],
      },
      { code: 'NOACC', name: 'x', kind: 'earning', calculation: 'fixed', defaultValue: '1' },
      {
        code: 'BIGPCT',
        name: 'x',
        kind: 'deduction',
        calculation: 'percent_of_basic',
        defaultValue: '101',
        liabilityAccountId: o.accrued,
      },
      {
        code: 'WRONGKIND',
        name: 'x',
        kind: 'deduction',
        calculation: 'fixed',
        defaultValue: '1',
        liabilityAccountId: o.accounts['5200'],
      },
      {
        code: 'ALLOW',
        name: 'dup',
        kind: 'earning',
        calculation: 'fixed',
        defaultValue: '1',
        expenseAccountId: o.accounts['5200'],
      },
    ];
    for (const body of badComponents) {
      const res = await o.owner.post('/payroll/components', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await o.owner.post('/payroll/components', { ...badComponents[0], extra: 1 })).status,
    ).toBe(400);
  });

  it('creates employees with masked national ids, numbers them and links a member for self-service', async () => {
    const o = await payrollOrg();
    const aisha = await employee(o, 'Aisha Mohamed', '10000', { nationalId: 'A123456' });
    const ahmed = await employee(o, 'Ahmed Ali', '8000');
    expect([aisha.number, ahmed.number]).toEqual(['EMP-00001', 'EMP-00002']);
    expect(aisha.nationalId).toBe('••••456');
    expect(JSON.stringify((await o.owner.get('/payroll/employees')).body)).not.toContain('A123456');
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const linked = await o.owner.put(`/payroll/employees/${ahmed.id}`, {
      version: ahmed.version,
      displayName: 'Ahmed Ali',
      hireDate: '2025-01-01',
      basicSalary: '8000',
      linkedMembershipId: member.membershipId,
      components: [{ componentId: o.pension, value: '5' }],
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data.linked).toBe(true);
    expect(linked.body.data.components).toEqual([{ componentId: o.pension, value: '5' }]);
    // One member, one employee.
    const again = await o.owner.put(`/payroll/employees/${aisha.id}`, {
      version: aisha.version,
      displayName: 'Aisha Mohamed',
      hireDate: '2025-01-01',
      basicSalary: '10000',
      linkedMembershipId: member.membershipId,
      components: [],
    });
    expect(again.status).toBe(400);
    expect(again.body.error.details.issues[0].path).toBe('linkedMembershipId');
    // Stale version and bad dates.
    expect(
      (
        await o.owner.put(`/payroll/employees/${ahmed.id}`, {
          version: 1,
          displayName: 'x',
          hireDate: '2025-01-01',
          basicSalary: '1',
          components: [],
        })
      ).status,
    ).toBe(409);
    const badDates = await o.owner.post('/payroll/employees', {
      displayName: 'Bad',
      hireDate: '2025-05-01',
      terminationDate: '2025-04-01',
      basicSalary: '1',
      components: [],
    });
    expect(badDates.status).toBe(400);
  });
});

describe('pay run workflow', () => {
  it('calculates, approves, posts and pays, with the ledger matching the payslips', async () => {
    const o = await payrollOrg({ separateApprover: false });
    await employee(o, 'Aisha Mohamed', '10000');
    await employee(o, 'Ahmed Ali', '8000');
    const created = await createRun(o);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run = created.body.data;
    expect(run).toMatchObject({
      number: 'PAY-00001',
      status: 'DRAFT',
      employeeCount: 2,
      grossTotal: '19000',
      deductionsTotal: '1260',
      netTotal: '17740',
      employerCostTotal: '1260',
    });
    const slip = run.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Aisha Mohamed',
    );
    expect(slip).toMatchObject({
      gross: '10500',
      deductions: '700',
      net: '9800',
      employerCost: '700',
    });
    expect(slip.lines.map((l: { code: string }) => l.code)).toEqual([
      'BASIC',
      'ALLOW',
      'PENS',
      'EPENS',
    ]);

    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    // The run is frozen once approved: no recalculation.
    expect(
      (
        await o.owner.post(`/payroll/runs/${run.id}/recalculate`, {
          version: approved.body.data.version,
        })
      ).status,
    ).toBe(409);

    const posted = await o.owner.post(`/payroll/runs/${run.id}/post`, {
      version: approved.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    const journal = (await o.owner.get(`/accounting/journals/${posted.body.data.journalId}`)).body
      .data;
    expect(journal.entryDate ?? journal.date).toBe('2026-03-31');
    expect(journal.sourceDocument).toMatchObject({ documentType: 'run', number: 'PAY-00001' });
    const debit = journal.lines.reduce(
      (s: number, l: { debit: string | null }) => s + Number(l.debit ?? 0),
      0,
    );
    const credit = journal.lines.reduce(
      (s: number, l: { credit: string | null }) => s + Number(l.credit ?? 0),
      0,
    );
    expect(debit).toBe(credit);
    expect(debit).toBe(20260); // gross 19000 + employer pension 1260
    expect(await glBalance(o.organizationId, o.accounts['5200']!)).toBe('18000.00'); // basic
    expect(await glBalance(o.organizationId, o.accrued)).toBe('-17740.00'); // net pay owed
    expect(await glBalance(o.organizationId, o.pensionPayable)).toBe('-2520.00'); // 1260 + 1260

    const bank = o.accounts['1120']!;
    const bankBefore = await glBalance(o.organizationId, bank);
    const paid = await o.owner.post(`/payroll/runs/${run.id}/pay`, {
      version: posted.body.data.version,
      bankAccountId: bank,
      paymentDate: '2026-04-02',
    });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.data.status).toBe('PAID');
    expect(await glBalance(o.organizationId, o.accrued)).toBe('0.00');
    expect(Number(await glBalance(o.organizationId, bank)) - Number(bankBefore)).toBe(-17740);
    // Paid is final.
    const voidPaid = await o.owner.post(`/payroll/runs/${run.id}/void`, {
      version: paid.body.data.version,
      reason: 'x',
    });
    expect(voidPaid.status).toBe(409);
    // Paying or posting again is refused.
    expect(
      (
        await o.owner.post(`/payroll/runs/${run.id}/pay`, {
          version: paid.body.data.version,
          bankAccountId: bank,
          paymentDate: '2026-04-02',
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.owner.post(`/payroll/runs/${run.id}/post`, { version: paid.body.data.version }))
        .status,
    ).toBe(409);
    // Audit trail.
    const { rows } = await owner.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'payroll.run_%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'payroll.run_created',
      'payroll.run_approved',
      'payroll.run_posted',
      'payroll.run_paid',
    ]);
  });

  it('refuses to approve a run the same person prepared, unless the organization allows it', async () => {
    const o = await payrollOrg();
    await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const self = await o.owner.post(`/payroll/runs/${run.id}/approve`, { version: run.version });
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('SELF_APPROVAL_PROHIBITED');
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    const approved = await admin.client.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const settings = (await o.owner.get('/payroll/settings')).body.data;
    expect(settings.requireSeparateApprover).toBe(true);
  });

  it('protects against a second run for the same or an overlapping period, and replays idempotent creates', async () => {
    const o = await payrollOrg({ separateApprover: false });
    await employee(o, 'Aisha Mohamed', '10000');
    const key = randomUUID();
    const first = await o.owner.post(
      '/payroll/runs',
      { periodStart: '2026-03-01', periodEnd: '2026-03-31', payDate: '2026-04-02' },
      { 'idempotency-key': key },
    );
    const replay = await o.owner.post(
      '/payroll/runs',
      { periodStart: '2026-03-01', periodEnd: '2026-03-31', payDate: '2026-04-02' },
      { 'idempotency-key': key },
    );
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect((await o.owner.get('/payroll/runs')).body.data).toHaveLength(1);
    const same = await createRun(o);
    expect(same.status).toBe(409);
    const overlap = await createRun(o, {
      periodStart: '2026-03-15',
      periodEnd: '2026-04-14',
      payDate: '2026-04-15',
    });
    expect(overlap.status).toBe(409);
    // A void run frees the period.
    const run = first.body.data;
    const voided = await o.owner.post(`/payroll/runs/${run.id}/void`, {
      version: run.version,
      reason: 'Wrong salary',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    expect((await createRun(o)).status).toBe(201);
    // The database enforces the same rule.
    await expect(
      owner.query(
        `INSERT INTO payroll_runs (organization_id, number, period_start, period_end, pay_date, employee_count,
           gross_total, deductions_total, net_total, employer_cost_total, created_by_user_id, created_at, updated_at)
         SELECT organization_id, 'DUP-1', period_start, period_end, pay_date, employee_count, gross_total,
                deductions_total, net_total, employer_cost_total, created_by_user_id, now(), now()
           FROM payroll_runs WHERE organization_id = $1 AND status = 'DRAFT'`,
        [o.organizationId],
      ),
    ).rejects.toThrow(/payroll_runs_period_idx/);
  });

  it('recalculates a draft after a salary change, and voiding a posted run reverses the ledger', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    await o.owner.put(`/payroll/employees/${aisha.id}`, {
      version: aisha.version,
      displayName: 'Aisha Mohamed',
      hireDate: '2025-01-01',
      basicSalary: '12000',
      components: [{ componentId: o.allowance }],
    });
    const recalculated = await o.owner.post(`/payroll/runs/${run.id}/recalculate`, {
      version: run.version,
    });
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    expect(recalculated.body.data).toMatchObject({
      grossTotal: '12500',
      deductionsTotal: '0',
      netTotal: '12500',
    });
    expect(recalculated.body.data.payslips).toHaveLength(1);
    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: recalculated.body.data.version,
    });
    const posted = await o.owner.post(`/payroll/runs/${run.id}/post`, {
      version: approved.body.data.version,
    });
    expect(posted.status).toBe(200);
    expect(await glBalance(o.organizationId, o.accrued)).toBe('-12500.00');
    const voided = await o.owner.post(`/payroll/runs/${run.id}/void`, {
      version: posted.body.data.version,
      reason: 'Posted by mistake',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.voidJournalId).toBeTruthy();
    expect(await glBalance(o.organizationId, o.accrued)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['5200']!)).toBe('0.00');
    // The payroll journal cannot be reversed generically.
    const generic = await o.owner.post(
      `/accounting/journals/${posted.body.data.journalId}/reverse`,
      { reason: 'x', reversalDate: '2026-04-05' },
    );
    expect(generic.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses runs that cannot be paid correctly', async () => {
    const o = await payrollOrg({ separateApprover: false });
    // No employees at all.
    const none = await createRun(o);
    expect(none.status).toBe(400);
    // Deductions above gross.
    const big = await o.owner.post('/payroll/components', {
      code: 'HUGE',
      name: 'Huge deduction',
      kind: 'deduction',
      calculation: 'fixed',
      defaultValue: '5000',
      liabilityAccountId: o.pensionPayable,
    });
    await o.owner.post('/payroll/employees', {
      displayName: 'Low Pay',
      hireDate: '2025-01-01',
      basicSalary: '1000',
      components: [{ componentId: big.body.data.id }],
    });
    const negative = await createRun(o);
    expect(negative.status).toBe(400);
    expect(JSON.stringify(negative.body)).toContain('Low Pay');
    // A closed period blocks posting.
    const ok = await payrollOrg({ separateApprover: false });
    await employee(ok, 'Aisha', '1000');
    const run = (await createRun(ok)).body.data;
    const approved = await ok.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    const march = ok.periods.find((p) => p.startDate <= '2026-03-31' && '2026-03-31' <= p.endDate)!;
    const closed = await ok.owner.post(`/accounting/periods/${march.id}/close`, {});
    if (closed.status === 200) {
      const blocked = await ok.owner.post(`/payroll/runs/${run.id}/post`, {
        version: approved.body.data.version,
      });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PERIOD_CLOSED');
    }
    // The bank account must be a bank or cash account.
    const o2 = await payrollOrg({ separateApprover: false });
    await employee(o2, 'Aisha', '1000');
    const r2 = (await createRun(o2)).body.data;
    const a2 = await o2.owner.post(`/payroll/runs/${r2.id}/approve`, { version: r2.version });
    const p2 = await o2.owner.post(`/payroll/runs/${r2.id}/post`, {
      version: a2.body.data.version,
    });
    const badBank = await o2.owner.post(`/payroll/runs/${r2.id}/pay`, {
      version: p2.body.data.version,
      bankAccountId: o2.accounts['5200'],
      paymentDate: '2026-04-02',
    });
    expect(badBank.status).toBe(400);
  });
});

describe('access control and isolation', () => {
  it('needs payroll permissions, hides payroll from members, and isolates tenants', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const member = await joinWithRole(ctx, o.owner, 'Member');
    for (const path of [
      '/payroll/employees',
      '/payroll/components',
      '/payroll/runs',
      '/payroll/settings',
      `/payroll/runs/${run.id}`,
      `/payroll/employees/${aisha.id}`,
    ]) {
      expect((await member.client.get(path)).status, path).toBe(403);
    }
    expect(
      (
        await member.client.post('/payroll/runs', {
          periodStart: '2026-05-01',
          periodEnd: '2026-05-31',
          payDate: '2026-06-01',
        })
      ).status,
    ).toBe(403);
    // A role with view only cannot run the workflow.
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Payroll viewer',
      permissionKeys: ['payroll.view'],
    });
    expect(role.status).toBe(201);
    const viewer = await joinWithRole(ctx, o.owner, 'Payroll viewer');
    expect((await viewer.client.get('/payroll/runs')).status).toBe(200);
    expect(
      (await viewer.client.post(`/payroll/runs/${run.id}/approve`, { version: run.version }))
        .status,
    ).toBe(403);
    expect(
      (
        await viewer.client.post(`/payroll/runs/${run.id}/void`, {
          version: run.version,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await viewer.client.put('/payroll/settings', {
          version: 1,
          basicSalaryExpenseAccountId: null,
          netPayPayableAccountId: null,
          proration: 'none',
          requireSeparateApprover: false,
        })
      ).status,
    ).toBe(403);
    // Another organization sees nothing of this one.
    const other = await payrollOrg();
    expect((await other.owner.get('/payroll/employees')).body.data).toEqual([]);
    expect((await other.owner.get(`/payroll/runs/${run.id}`)).status).toBe(404);
    expect((await other.owner.get(`/payroll/employees/${aisha.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/payroll/runs/${run.id}/approve`, { version: run.version })).status,
    ).toBe(404);
    // A foreign account or component is refused.
    const foreign = await other.owner.post('/payroll/employees', {
      displayName: 'X',
      hireDate: '2025-01-01',
      basicSalary: '1',
      components: [{ componentId: o.allowance }],
    });
    expect(foreign.status).toBe(400);
  });

  it('lets a linked employee read only their own payslips from posted runs', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    const mine = await employee(o, 'Ahmed Ali', '8000', {
      linkedMembershipId: member.membershipId,
    });
    await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    expect((await member.client.get('/payroll/my-payslips')).body.data).toEqual([]); // draft is not visible
    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    await o.owner.post(`/payroll/runs/${run.id}/post`, { version: approved.body.data.version });
    const slips = (await member.client.get('/payroll/my-payslips')).body.data;
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ runNumber: 'PAY-00001', gross: '8500', net: '7940' });
    // Employer contributions are not on the employee's view.
    expect(slips[0].lines.map((l: { kind: string }) => l.kind)).not.toContain(
      'employer_contribution',
    );
    expect(JSON.stringify(slips)).not.toContain('Aisha');
    expect(mine.linked).toBe(true);
    // Someone not linked sees an empty list.
    const stranger = await joinWithRole(ctx, o.owner, 'Member');
    expect((await stranger.client.get('/payroll/my-payslips')).body.data).toEqual([]);
  });
});

describe('database guards', () => {
  it('freezes a run once it leaves draft, forbids deletes, and keeps payslips immutable', async () => {
    const o = await payrollOrg({ separateApprover: false });
    await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    await expect(
      owner.query(`UPDATE payroll_runs SET net_total = 1, gross_total = 1 WHERE id = $1`, [run.id]),
    ).rejects.toThrow(/frozen/);
    await expect(owner.query(`DELETE FROM payroll_runs WHERE id = $1`, [run.id])).rejects.toThrow(
      /never deleted/,
    );
    await expect(
      owner.query(`UPDATE payroll_runs SET status = 'DRAFT' WHERE id = $1`, [run.id]),
    ).rejects.toThrow(/cannot move/);
    await expect(
      owner.query(`DELETE FROM payroll_payslips WHERE run_id = $1`, [run.id]),
    ).rejects.toThrow(/not a draft/);
    await expect(
      owner.query(`UPDATE payroll_payslips SET net = 0, gross = 0 WHERE run_id = $1`, [run.id]),
    ).rejects.toThrow(/never updated/);
    await expect(
      owner.query(
        `DELETE FROM payroll_payslip_lines WHERE payslip_id IN (SELECT id FROM payroll_payslips WHERE run_id = $1)`,
        [run.id],
      ),
    ).rejects.toThrow(/not a draft/);
    const posted = await o.owner.post(`/payroll/runs/${run.id}/post`, {
      version: approved.body.data.version,
    });
    const paid = await o.owner.post(`/payroll/runs/${run.id}/pay`, {
      version: posted.body.data.version,
      bankAccountId: o.accounts['1120'],
      paymentDate: '2026-04-02',
    });
    expect(paid.status).toBe(200);
    await expect(
      owner.query(`UPDATE payroll_runs SET void_reason = 'x' WHERE id = $1`, [run.id]),
    ).rejects.toThrow(/immutable/);
  });
});

describe('concurrent and repeated operations', () => {
  it('posts an approved run exactly once when two requests race, and pays it exactly once', async () => {
    const o = await payrollOrg({ separateApprover: false });
    await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    const version = approved.body.data.version;
    const posts = await Promise.all([
      o.owner.post(`/payroll/runs/${run.id}/post`, { version }),
      o.owner.post(`/payroll/runs/${run.id}/post`, { version }),
    ]);
    expect(posts.map((r) => r.status).sort()).toEqual([200, 409]);
    const journals = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries
        WHERE organization_id = $1 AND source_module = 'payroll' AND source_id = $2`,
      [o.organizationId, run.id],
    );
    expect(journals.rows[0].n).toBe(1);
    expect(await glBalance(o.organizationId, o.accrued)).toBe('-9800.00');
    const posted = posts.find((r) => r.status === 200)!.body.data;
    const payBody = {
      version: posted.version,
      bankAccountId: o.accounts['1120'],
      paymentDate: '2026-04-02',
    };
    const pays = await Promise.all([
      o.owner.post(`/payroll/runs/${run.id}/pay`, payBody),
      o.owner.post(`/payroll/runs/${run.id}/pay`, payBody),
    ]);
    expect(pays.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await glBalance(o.organizationId, o.accrued)).toBe('0.00');
  });

  it('creates one run when two identical creates race without an idempotency key', async () => {
    const o = await payrollOrg({ separateApprover: false });
    await employee(o, 'Aisha Mohamed', '10000');
    const results = await Promise.all([createRun(o), createRun(o)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await o.owner.get('/payroll/runs')).body.data).toHaveLength(1);
  });

  it('records every payroll change in the audit trail without salary or id numbers in metadata', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '98765', { nationalId: 'A1234567' });
    await o.owner.put(`/payroll/employees/${aisha.id}`, {
      version: aisha.version,
      displayName: 'Aisha Mohamed',
      hireDate: '2025-01-01',
      basicSalary: '99999',
      components: [],
    });
    const { rows } = await owner.query(
      `SELECT action, metadata::text AS metadata FROM audit_events
        WHERE organization_id = $1 AND action LIKE 'payroll.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    const actions = rows.map((r: { action: string }) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'payroll.settings_updated',
        'payroll.component_created',
        'payroll.employee_created',
        'payroll.employee_updated',
      ]),
    );
    const all = rows.map((r: { metadata: string }) => r.metadata).join(' ');
    expect(all).not.toContain('A1234567');
    expect(all).not.toContain('98765');
    expect(all).not.toContain('99999');
  });
});

describe('audited salary reads and the payroll register', () => {
  it('audits every read of salary data without names or amounts, and sums the register from posted runs only', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000', { nationalId: 'A1234567' });
    await employee(o, 'Ahmed Ali', '8000');
    const created = await createRun(o);
    const run = created.body.data;

    // A draft run is not in the register yet.
    const empty = await o.owner.get('/payroll/reports/register?from=2026-03-01&to=2026-03-31');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data.runs).toEqual([]);
    expect(empty.body.data.totals.gross).toBe('0');

    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: run.version,
    });
    const posted = await o.owner.post(`/payroll/runs/${run.id}/post`, {
      version: approved.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);

    const register = await o.owner.get('/payroll/reports/register?from=2026-03-01&to=2026-03-31');
    expect(register.body.data.totals).toEqual({
      gross: '19000',
      deductions: '1260',
      net: '17740',
      employerCost: '1260',
    });
    expect(
      register.body.data.employees.map((e: { employeeName: string }) => e.employeeName),
    ).toEqual(['Aisha Mohamed', 'Ahmed Ali']);
    const byCode = Object.fromEntries(
      register.body.data.components.map((c: { code: string; amount: string }) => [
        c.code,
        c.amount,
      ]),
    );
    expect(byCode).toMatchObject({ BASIC: '18000', ALLOW: '1000', PENS: '1260', EPENS: '1260' });
    // Outside the range nothing is counted; a bad range is refused.
    expect(
      (await o.owner.get('/payroll/reports/register?from=2026-04-01&to=2026-04-30')).body.data.runs,
    ).toEqual([]);
    expect(
      (await o.owner.get('/payroll/reports/register?from=2026-05-01&to=2026-04-30')).status,
    ).toBe(400);

    // Every read of salary data leaves an audit event.
    await o.owner.get('/payroll/employees');
    await o.owner.get(`/payroll/employees/${aisha.id}`);
    await o.owner.get(`/payroll/employees/${aisha.id}/salary-history`);
    await o.owner.get(`/payroll/runs/${run.id}`);
    const slipId = (await o.owner.get(`/payroll/runs/${run.id}`)).body.data.payslips[0].id;
    await o.owner.get(`/payroll/payslips/${slipId}`);
    const { rows } = await owner.query(
      `SELECT action, metadata::text AS metadata FROM audit_events
        WHERE organization_id = $1 AND action LIKE 'payroll.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        'payroll.employees_listed',
        'payroll.employee_viewed',
        'payroll.salary_history_viewed',
        'payroll.run_viewed',
        'payroll.payslip_viewed',
        'payroll.register_viewed',
      ]),
    );
    const text = rows.map((r: { metadata: string }) => r.metadata).join(' ');
    for (const secret of ['A1234567', '10000', '8000', 'Aisha', 'Ahmed']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('keeps the register behind payroll.view and inside the tenant', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.get('/payroll/reports/register?from=2026-03-01&to=2026-03-31')).status,
    ).toBe(403);
    const other = await payrollOrg({ separateApprover: false });
    await employee(other, 'Other Person', '5000');
    const mine = await o.owner.get('/payroll/reports/register?from=2026-01-01&to=2026-12-31');
    expect(mine.body.data.employees).toEqual([]);
  });
});

describe('one-off pay-run amounts: bonus, commission, overtime pay (master specification section 17)', () => {
  it('adds and removes amounts on a draft run, recalculating it, and nothing derived is statutory', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000');
    await employee(o, 'Ahmed Ali', '8000');
    const expense = await newAccount(o, '5230', 'Bonuses', 'EXPENSE', 'OPERATING_EXPENSE');
    const bonus = await o.owner.post('/payroll/components', {
      code: 'BONUS',
      name: 'Bonus',
      kind: 'earning',
      calculation: 'fixed',
      defaultValue: '0',
      expenseAccountId: expense,
    });
    expect(bonus.status, JSON.stringify(bonus.body)).toBe(201);
    const run = (await createRun(o)).body.data;
    expect(run).toMatchObject({ grossTotal: '19000', netTotal: '17740' });

    const added = await o.owner.post(`/payroll/runs/${run.id}/adjustments`, {
      employeeId: aisha.id,
      componentId: bonus.body.data.id,
      amount: '300',
      note: 'March sales bonus',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data).toMatchObject({ grossTotal: '19300', netTotal: '18040' });
    const slip = added.body.data.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Aisha Mohamed',
    );
    expect(slip.lines.find((l: { code: string }) => l.code === 'BONUS')).toMatchObject({
      kind: 'earning',
      amount: '300',
    });
    // The percentage deduction is on the basic salary only, so the bonus changes nothing else.
    expect(slip).toMatchObject({ deductions: '700', gross: '10800', net: '10100' });

    const listed = await o.owner.get(`/payroll/runs/${run.id}/adjustments`);
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        employeeNumber: aisha.number,
        componentCode: 'BONUS',
        amount: '300',
        note: 'March sales bonus',
      }),
    ]);
    const removed = await o.owner.delete(
      `/payroll/runs/${run.id}/adjustments/${listed.body.data[0].id}`,
    );
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.data).toMatchObject({ grossTotal: '19000', netTotal: '17740' });
    expect((await o.owner.get(`/payroll/runs/${run.id}/adjustments`)).body.data).toEqual([]);

    // The audit names the employee number and component, never the amount, name or note.
    await o.owner.post(`/payroll/runs/${run.id}/adjustments`, {
      employeeId: aisha.id,
      componentId: bonus.body.data.id,
      amount: '456.78',
      note: 'Private note',
    });
    const { rows } = await owner.query(
      `SELECT action, metadata::text AS metadata FROM audit_events
        WHERE organization_id = $1 AND action LIKE 'payroll.adjustment%'`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining(['payroll.adjustment_added', 'payroll.adjustment_removed']),
    );
    const text = rows.map((r: { metadata: string }) => r.metadata).join(' ');
    for (const secret of ['456.78', 'Private note', 'Aisha', '300']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('refuses unsuitable components, bad amounts and runs that are no longer drafts', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const url = `/payroll/runs/${run.id}/adjustments`;
    const post = (body: object) => o.owner.post(url, body);
    // A percentage component and an employer contribution cannot take a typed amount.
    expect(
      (await post({ employeeId: aisha.id, componentId: o.pension, amount: '10' })).status,
    ).toBe(400);
    expect(
      (await post({ employeeId: aisha.id, componentId: o.employerPension, amount: '10' })).status,
    ).toBe(400);
    for (const amount of ['0', '-5', '1.23456', 'abc']) {
      expect(
        (await post({ employeeId: aisha.id, componentId: o.allowance, amount })).status,
        amount,
      ).toBe(400);
    }
    // A deduction larger than the pay fails the whole change and stores nothing.
    const huge = await post({ employeeId: aisha.id, componentId: o.allowance, amount: '5' });
    expect(huge.status).toBe(201);
    const failing = await o.owner.post('/payroll/components', {
      code: 'FINE',
      name: 'Fine',
      kind: 'deduction',
      calculation: 'fixed',
      defaultValue: '0',
      liabilityAccountId: o.pensionPayable,
    });
    const tooMuch = await post({
      employeeId: aisha.id,
      componentId: failing.body.data.id,
      amount: '999999',
    });
    expect(tooMuch.status).toBe(400);
    expect((await o.owner.get(url)).body.data).toHaveLength(1);

    // Once approved, amounts are frozen: the service and the database both refuse.
    const approved = await o.owner.post(`/payroll/runs/${run.id}/approve`, {
      version: (await o.owner.get(`/payroll/runs/${run.id}`)).body.data.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(
      (await post({ employeeId: aisha.id, componentId: o.allowance, amount: '10' })).status,
    ).toBe(409);
    await expect(
      owner.query(
        `INSERT INTO payroll_run_adjustments (organization_id, run_id, employee_id, component_id, amount, created_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, 1, $5, now())`,
        [o.organizationId, run.id, aisha.id, o.allowance, o.ownerMembershipId],
      ),
    ).rejects.toThrow();
  });

  it('needs payroll.runs.create and stays inside the tenant', async () => {
    const o = await payrollOrg({ separateApprover: false });
    const aisha = await employee(o, 'Aisha Mohamed', '10000');
    const run = (await createRun(o)).body.data;
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post(`/payroll/runs/${run.id}/adjustments`, {
          employeeId: aisha.id,
          componentId: o.allowance,
          amount: '10',
        })
      ).status,
    ).toBe(403);
    expect((await member.client.get(`/payroll/runs/${run.id}/adjustments`)).status).toBe(403);
    const other = await payrollOrg({ separateApprover: false });
    expect((await other.owner.get(`/payroll/runs/${run.id}/adjustments`)).status).toBe(404);
    expect(
      (
        await other.owner.post(`/payroll/runs/${run.id}/adjustments`, {
          employeeId: aisha.id,
          componentId: other.allowance,
          amount: '10',
        })
      ).status,
    ).toBe(404);
  });
});
