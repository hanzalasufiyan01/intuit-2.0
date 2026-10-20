import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Effective-dated salary and payslip availability notices (FP-25, migration 0083). A salary change
 * inside a period is split by days; the payslip keeps the segments it used; history is append-only;
 * announcing payslips sends no figures. Real PostgreSQL.
 */

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

async function payrollOrg(proration: 'calendar_days' | 'none' = 'calendar_days') {
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
    proration,
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
    email: `ahmed-${Math.random().toString(36).slice(2, 8)}@example.test`,
    hireDate: '2025-01-01',
    basicSalary: '8000',
    linkedMembershipId: staff.membershipId,
    components: [],
  });
  expect(employee.status, JSON.stringify(employee.body)).toBe(201);
  return { ...org, staff, employee: employee.body.data };
}
type Org = Awaited<ReturnType<typeof payrollOrg>>;

const change = (o: Org, body: object) =>
  o.owner.put(`/payroll/employees/${o.employee.id}`, {
    version: o.employee.version,
    displayName: 'Ahmed Ali',
    email: o.employee.email,
    hireDate: '2025-01-01',
    linkedMembershipId: o.staff.membershipId,
    components: [],
    basicSalary: '8000',
    ...body,
  });

async function run(o: Org, start: string, end: string, post = false) {
  const created = await o.owner.post('/payroll/runs', {
    periodStart: start,
    periodEnd: end,
    payDate: end,
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

describe('effective-dated salary', () => {
  it('splits a mid-period change by days and keeps the segments on the payslip', async () => {
    const o = await payrollOrg();
    const changed = await change(o, {
      basicSalary: '9000',
      salaryEffectiveFrom: '2026-03-16',
      salaryReason: 'Promotion',
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.data.basicSalary).toBe('9000'); // the most recent salary
    const history = (await o.owner.get(`/payroll/employees/${o.employee.id}/salary-history`)).body
      .data;
    expect(history).toEqual([
      expect.objectContaining({
        effectiveFrom: '2026-03-16',
        basicSalary: '9000',
        reason: 'Promotion',
      }),
      expect.objectContaining({ effectiveFrom: '2025-01-01', basicSalary: '8000' }),
    ]);
    // March: 15 days at 8000 and 16 days at 9000, over 31 calendar days.
    const march = await run(o, '2026-03-01', '2026-03-31');
    const slip = march.payslips[0];
    expect(slip.basicSalary).toBe('8516.13'); // (8000 * 15 + 9000 * 16) / 31
    expect(slip.salarySegments).toEqual([
      { from: '2026-03-01', to: '2026-03-15', salary: '8000.0000', days: 15 },
      { from: '2026-03-16', to: '2026-03-31', salary: '9000.0000', days: 16 },
    ]);
    // April is all at the new salary, with no segments.
    const april = await run(o, '2026-04-01', '2026-04-30');
    expect(april.payslips[0].basicSalary).toBe('9000');
    expect(april.payslips[0].salarySegments).toBeNull();
    // A run before the change uses the old salary.
    const feb = await run(o, '2026-02-01', '2026-02-28');
    expect(feb.payslips[0].basicSalary).toBe('8000');
  });

  it('treats a salary entered without a date as a correction of the current one', async () => {
    const o = await payrollOrg();
    const corrected = await change(o, { basicSalary: '8500' });
    expect(corrected.status).toBe(200);
    const history = (await o.owner.get(`/payroll/employees/${o.employee.id}/salary-history`)).body
      .data;
    expect(history).toHaveLength(2); // both kept: the original and its correction
    expect(history[0]).toMatchObject({ effectiveFrom: '2025-01-01', basicSalary: '8500' });
    expect((await run(o, '2026-03-01', '2026-03-31')).payslips[0].basicSalary).toBe('8500');
  });

  it('refuses dates before hire or inside a posted period, and uses the salary at period end without proration', async () => {
    const o = await payrollOrg();
    await run(o, '2026-03-01', '2026-03-31', true);
    const into = await change(o, { basicSalary: '9000', salaryEffectiveFrom: '2026-03-20' });
    expect(into.status).toBe(400);
    expect(JSON.stringify(into.body)).toContain('already posted');
    expect(
      (await change(o, { basicSalary: '9000', salaryEffectiveFrom: '2024-12-31' })).status,
    ).toBe(400);
    expect((await change(o, { basicSalary: '9000', salaryEffectiveFrom: 'x' })).status).toBe(400);
    expect(
      (await change(o, { basicSalary: '9000', salaryEffectiveFrom: '2026-04-16' })).status,
    ).toBe(200);
    const none = await payrollOrg('none');
    await change(none, { basicSalary: '9000', salaryEffectiveFrom: '2026-03-16' });
    expect((await run(none, '2026-03-01', '2026-03-31')).payslips[0].basicSalary).toBe('9000'); // salary at period end
  });

  it('keeps history append-only and tenant isolated', async () => {
    const o = await payrollOrg();
    const other = await payrollOrg();
    await expect(
      db.query(`UPDATE payroll_salary_history SET basic_salary = 1 WHERE employee_id = $1`, [
        o.employee.id,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(`DELETE FROM payroll_salary_history WHERE employee_id = $1`, [o.employee.id]),
    ).rejects.toThrow();
    expect(
      (await other.owner.get(`/payroll/employees/${o.employee.id}/salary-history`)).status,
    ).toBe(404);
    expect(
      (await o.staff.client.get(`/payroll/employees/${o.employee.id}/salary-history`)).status,
    ).toBe(403);
    expect(
      (await ctx.client().get(`/payroll/employees/${o.employee.id}/salary-history`)).status,
    ).toBe(401);
    const audit = await db.query(
      `SELECT metadata::text AS m FROM audit_events WHERE organization_id = $1 AND action = 'payroll.employee_updated'`,
      [o.organizationId],
    );
    for (const r of audit.rows) expect(r.m).not.toMatch(/9000|8000/); // no salary figures in the audit trail
  });
});

describe('announcing payslips', () => {
  it('sends a figure-free notice once per payslip to employees who can sign in', async () => {
    const o = await payrollOrg();
    const noMail = await o.owner.post('/payroll/employees', {
      displayName: 'No Mail',
      hireDate: '2025-01-01',
      basicSalary: '5000',
      components: [],
    });
    expect(noMail.status).toBe(201);
    const draft = await run(o, '2026-03-01', '2026-03-31');
    expect((await o.owner.post(`/payroll/runs/${draft.id}/announce-payslips`, {})).status).toBe(
      409,
    );
    const posted = await run(o, '2026-04-01', '2026-04-30', true);
    const sent = await o.owner.post(`/payroll/runs/${posted.id}/announce-payslips`, {});
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.data).toMatchObject({ sent: 1, alreadySent: 0, failed: 0 });
    expect(sent.body.data.skipped).toEqual([{ employee: 'No Mail', reason: 'no e-mail address' }]);
    const mail = ctx.email.lastTo(o.employee.email);
    expect(mail?.template).toBe('payroll.payslip_available');
    expect(mail?.text).toContain('/payroll/my-payslips');
    expect(`${mail?.subject} ${mail?.text}`).not.toMatch(/8000|net|salary/i);
    const again = await o.owner.post(`/payroll/runs/${posted.id}/announce-payslips`, {});
    expect(again.body.data).toMatchObject({ sent: 0, alreadySent: 1 });
    const audit = await db.query(
      `SELECT metadata FROM audit_events WHERE organization_id = $1 AND action = 'payroll.payslips_announced' ORDER BY occurred_at`,
      [o.organizationId],
    );
    expect(audit.rows[0].metadata).toMatchObject({ sent: 1, failed: 0 });
    expect(JSON.stringify(audit.rows)).not.toContain(o.employee.email);
    await expect(
      db.query(`DELETE FROM payroll_payslip_notifications WHERE organization_id = $1`, [
        o.organizationId,
      ]),
    ).rejects.toThrow();
  });

  it('needs the pay permission and stays in its organization', async () => {
    const o = await payrollOrg();
    const other = await payrollOrg();
    const posted = await run(o, '2026-04-01', '2026-04-30', true);
    expect(
      (await o.staff.client.post(`/payroll/runs/${posted.id}/announce-payslips`, {})).status,
    ).toBe(403);
    expect(
      (await other.owner.post(`/payroll/runs/${posted.id}/announce-payslips`, {})).status,
    ).toBe(404);
    expect(
      (await ctx.client().post(`/payroll/runs/${posted.id}/announce-payslips`, {})).status,
    ).toBe(401);
    expect(
      (await o.owner.post(`/payroll/runs/${posted.id}/announce-payslips`, { extra: 1 })).status,
    ).toBe(400);
  });
});
