import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Payroll leave and salary advances (migration 0073): leave types, requests, balances and
 * approval; advances granted with a journal, recovered through pay runs, and given back when a
 * run is voided. Real PostgreSQL.
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

interface Org extends AccountingOrg {
  advances: string;
  netPay: string;
  employee: { id: string; version: number };
  staff: { client: Awaited<ReturnType<typeof joinWithRole>>['client']; membershipId: string };
}

async function account(
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

async function payrollOrg(): Promise<Org> {
  const org = await setUpAccountingOrg(ctx);
  expect(
    (await org.owner.put('/organizations/current/modules/payroll', { enabled: true })).status,
  ).toBe(200);
  const netPay = await account(
    org,
    '2150',
    'Net pay payable',
    'LIABILITY',
    'OTHER_CURRENT_LIABILITY',
  );
  const advances = await account(org, '1190', 'Employee advances', 'ASSET', 'OTHER_CURRENT_ASSET');
  const settings = await org.owner.put('/payroll/settings', {
    version: 0,
    basicSalaryExpenseAccountId: org.accounts['5200'],
    netPayPayableAccountId: netPay,
    advancesAccountId: advances,
    proration: 'calendar_days',
    requireSeparateApprover: false,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const role = await org.owner.post('/organizations/current/roles', {
    name: 'Staff',
    permissionKeys: ['organization.read'],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const staff = await joinWithRole(ctx, org.owner, 'Staff');
  const employee = await org.owner.post('/payroll/employees', {
    displayName: 'Ahmed Ali',
    hireDate: '2025-01-01',
    basicSalary: '8000',
    linkedMembershipId: staff.membershipId,
    components: [],
  });
  expect(employee.status, JSON.stringify(employee.body)).toBe(201);
  return {
    ...org,
    advances,
    netPay,
    employee: { id: employee.body.data.id, version: employee.body.data.version },
    staff: { client: staff.client, membershipId: staff.membershipId },
  };
}

async function glBalance(organizationId: string, accountId: string) {
  const { rows } = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [organizationId, accountId],
  );
  return rows[0].b as string;
}

const grant = (o: Org, extra: object = {}) =>
  o.owner.post('/payroll/advances', {
    employeeId: o.employee.id,
    grantedDate: '2026-02-10',
    principal: '3000',
    installment: '1000',
    bankAccountId: o.accounts['1120'],
    ...extra,
  });

async function runFor(o: Org, start: string, end: string) {
  const created = await o.owner.post('/payroll/runs', {
    periodStart: start,
    periodEnd: end,
    payDate: end,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data;
}

describe('salary advances', () => {
  it('pays the advance out with a journal, recovers instalments through pay runs, and finishes repaid', async () => {
    const o = await payrollOrg();
    const granted = await grant(o);
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body.data).toMatchObject({
      number: 'ADV-00001',
      status: 'ACTIVE',
      outstanding: '3000',
      repaid: '0',
    });
    expect(await glBalance(o.organizationId, o.advances)).toBe('3000.00');
    const journal = (await o.owner.get(`/accounting/journals/${granted.body.data.journalId}`)).body
      .data;
    expect(journal.sourceDocument).toMatchObject({ documentType: 'advance', number: 'ADV-00001' });

    // March: net = 8000 - 1000 instalment.
    const march = await runFor(o, '2026-03-01', '2026-03-31');
    expect(march).toMatchObject({ grossTotal: '8000', deductionsTotal: '1000', netTotal: '7000' });
    expect(march.payslips[0].lines.map((l: { code: string }) => l.code)).toEqual(['BASIC', 'ADV']);
    // Nothing is recovered until the run is posted.
    expect(
      (await o.owner.get(`/payroll/advances/${granted.body.data.id}`)).body.data.outstanding,
    ).toBe('3000');
    const approved = await o.owner.post(`/payroll/runs/${march.id}/approve`, {
      version: march.version,
    });
    const posted = await o.owner.post(`/payroll/runs/${march.id}/post`, {
      version: approved.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    let advance = (await o.owner.get(`/payroll/advances/${granted.body.data.id}`)).body.data;
    expect(advance).toMatchObject({ repaid: '1000', outstanding: '2000', status: 'ACTIVE' });
    expect(advance.repayments).toEqual([
      expect.objectContaining({ runNumber: march.number, amount: '1000.0000' }),
    ]);
    expect(await glBalance(o.organizationId, o.advances)).toBe('2000.00'); // asset reduced by the instalment

    // Voiding the run gives the instalment back, with nothing edited.
    const voided = await o.owner.post(`/payroll/runs/${march.id}/void`, {
      version: posted.body.data.version,
      reason: 'Wrong period',
    });
    expect(voided.status).toBe(200);
    advance = (await o.owner.get(`/payroll/advances/${granted.body.data.id}`)).body.data;
    expect(advance).toMatchObject({ repaid: '0', outstanding: '3000' });
    expect(await glBalance(o.organizationId, o.advances)).toBe('3000.00');

    // Three months recover it in full; the last instalment is capped at what is left.
    for (const [start, end] of [
      ['2026-03-01', '2026-03-31'],
      ['2026-04-01', '2026-04-30'],
      ['2026-05-01', '2026-05-31'],
    ] as const) {
      const run = await runFor(o, start, end);
      const a = await o.owner.post(`/payroll/runs/${run.id}/approve`, { version: run.version });
      const p = await o.owner.post(`/payroll/runs/${run.id}/post`, {
        version: a.body.data.version,
      });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
    advance = (await o.owner.get(`/payroll/advances/${granted.body.data.id}`)).body.data;
    expect(advance).toMatchObject({ repaid: '3000', outstanding: '0', status: 'REPAID' });
    const june = await runFor(o, '2026-06-01', '2026-06-30');
    expect(june).toMatchObject({ deductionsTotal: '0', netTotal: '8000' }); // nothing left to recover
    expect(await glBalance(o.organizationId, o.advances)).toBe('0.00');
  });

  it('caps the last instalment, refuses a deduction above pay, and cancels only when nothing was recovered', async () => {
    const o = await payrollOrg();
    const small = await grant(o, { principal: '1500', installment: '1000' });
    const m1 = await runFor(o, '2026-03-01', '2026-03-31');
    const a1 = await o.owner.post(`/payroll/runs/${m1.id}/approve`, { version: m1.version });
    await o.owner.post(`/payroll/runs/${m1.id}/post`, { version: a1.body.data.version });
    // Cannot cancel once an instalment is recovered.
    expect(
      (
        await o.owner.post(`/payroll/advances/${small.body.data.id}/cancel`, {
          version: small.body.data.version,
          reason: 'x',
        })
      ).status,
    ).toBe(409);
    const m2 = await runFor(o, '2026-04-01', '2026-04-30');
    expect(m2.deductionsTotal).toBe('500'); // only what is left
    // An advance whose instalment exceeds the month's pay blocks the run with a clear message.
    const o2 = await payrollOrg();
    await grant(o2, { principal: '9000', installment: '9000' });
    const blocked = await o2.owner.post('/payroll/runs', {
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      payDate: '2026-03-31',
    });
    expect(blocked.status).toBe(400);
    expect(JSON.stringify(blocked.body)).toContain('Ahmed Ali');
    // Cancelling an untouched advance reverses its journal.
    const fresh = await grant(o2, {
      principal: '500',
      installment: '100',
      grantedDate: '2026-02-11',
    });
    const before = await glBalance(o2.organizationId, o2.advances);
    const cancelled = await o2.owner.post(`/payroll/advances/${fresh.body.data.id}/cancel`, {
      version: fresh.body.data.version,
      reason: 'Paid in error',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'CANCELLED', outstanding: '0' });
    expect(Number(before) - Number(await glBalance(o2.organizationId, o2.advances))).toBe(500);
    await expect(
      db.query(`UPDATE payroll_advances SET principal = 1 WHERE id = $1`, [fresh.body.data.id]),
    ).rejects.toThrow(/final/);
    await expect(
      db.query(`DELETE FROM payroll_advances WHERE id = $1`, [fresh.body.data.id]),
    ).rejects.toThrow(/never deleted/);
  });

  it('validates the grant and needs the advances account, a bank account and permission', async () => {
    const o = await payrollOrg();
    for (const bad of [
      { principal: '0' },
      { installment: '5000' },
      { employeeId: o.advances },
      { bankAccountId: o.accounts['5200'] },
      { grantedDate: '2024-01-01' }, // before hire
      { grantedDate: 'x' },
      { extra: 1 },
    ]) {
      expect((await grant(o, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const noAccount = await payrollOrg();
    const s = (await noAccount.owner.get('/payroll/settings')).body.data;
    await noAccount.owner.put('/payroll/settings', { ...s, advancesAccountId: null });
    const refused = await grant(noAccount);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues[0].path).toBe('settings');
    expect((await o.staff.client.get('/payroll/advances')).status).toBe(403);
    expect((await grant({ ...o, owner: o.staff.client } as Org)).status).toBe(403);
    const other = await payrollOrg();
    const g = (await grant(o)).body.data;
    expect((await other.owner.get(`/payroll/advances/${g.id}`)).status).toBe(404);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'payroll.advance%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toContain(
      'payroll.advance_granted',
    );
  });
});

describe('leave', () => {
  async function leaveType(o: Org, extra: object = {}) {
    const res = await o.owner.post('/payroll/leave/types', {
      code: 'ANNUAL',
      name: 'Annual leave',
      daysPerYear: '10',
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  }

  it('requests, approves and tracks the balance, with the employee asking for themselves', async () => {
    const o = await payrollOrg();
    const type = await leaveType(o);
    expect(
      (
        await o.owner.post('/payroll/leave/types', {
          code: 'ANNUAL',
          name: 'dup',
          daysPerYear: '1',
        })
      ).status,
    ).toBe(400);
    const request = await o.staff.client.post('/payroll/leave/requests', {
      leaveTypeId: type.id,
      startDate: '2026-03-02',
      endDate: '2026-03-06',
      days: '4.5',
      reason: 'Family',
    });
    expect(request.status, JSON.stringify(request.body)).toBe(201);
    expect(request.body.data).toMatchObject({
      employeeName: 'Ahmed Ali',
      status: 'PENDING',
      days: '4.5',
    });
    // The employee sees their own balance (nothing taken yet, 4.5 pending).
    const mine = (await o.staff.client.get('/payroll/leave/balances?year=2026')).body.data;
    expect(mine.balances[0]).toMatchObject({
      entitlement: '10',
      taken: '0',
      pending: '4.5',
      remaining: '10',
    });
    // Overlaps and bad dates are refused.
    const body = {
      leaveTypeId: type.id,
      startDate: '2026-03-04',
      endDate: '2026-03-05',
      days: '1',
    };
    expect((await o.staff.client.post('/payroll/leave/requests', body)).status).toBe(400);
    expect(
      (
        await o.staff.client.post('/payroll/leave/requests', {
          ...body,
          startDate: '2026-04-05',
          endDate: '2026-04-01',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await o.staff.client.post('/payroll/leave/requests', {
          ...body,
          startDate: '2026-12-30',
          endDate: '2027-01-02',
          days: '2',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await o.staff.client.post('/payroll/leave/requests', {
          ...body,
          startDate: '2026-05-04',
          endDate: '2026-05-05',
          days: '3',
        })
      ).status,
    ).toBe(400); // more days than the span
    expect(
      (
        await o.staff.client.post('/payroll/leave/requests', {
          ...body,
          startDate: '2026-05-04',
          endDate: '2026-05-05',
          days: '1.3',
        })
      ).status,
    ).toBe(400);
    // The employee cannot approve; a manager does; self-approval is refused.
    expect(
      (
        await o.staff.client.post(`/payroll/leave/requests/${request.body.data.id}/approve`, {
          version: 1,
        })
      ).status,
    ).toBe(403);
    const approved = await o.owner.post(`/payroll/leave/requests/${request.body.data.id}/approve`, {
      version: request.body.data.version,
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = (
      await o.owner.get(`/payroll/leave/balances?employeeId=${o.employee.id}&year=2026`)
    ).body.data;
    expect(after.balances[0]).toMatchObject({ taken: '4.5', pending: '0', remaining: '5.5' });
    // A decided request is final in content; the requester may still cancel an approved one.
    await expect(
      db.query(`UPDATE payroll_leave_requests SET days = 1 WHERE id = $1`, [request.body.data.id]),
    ).rejects.toThrow(/fixed/);
    await expect(
      db.query(`DELETE FROM payroll_leave_requests WHERE id = $1`, [request.body.data.id]),
    ).rejects.toThrow(/never deleted/);
    const cancelled = await o.staff.client.post(
      `/payroll/leave/requests/${request.body.data.id}/cancel`,
      { version: approved.body.data.version },
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(
      (await o.owner.get(`/payroll/leave/balances?employeeId=${o.employee.id}&year=2026`)).body.data
        .balances[0].remaining,
    ).toBe('10');
  });

  it('refuses approval beyond the balance unless the type allows it, and a rejection needs a reason', async () => {
    const o = await payrollOrg();
    const strict = await leaveType(o, { daysPerYear: '3' });
    const loose = await leaveType(o, {
      code: 'SPECIAL',
      name: 'Special',
      daysPerYear: '1',
      allowNegative: true,
    });
    const r1 = (
      await o.staff.client.post('/payroll/leave/requests', {
        employeeId: o.employee.id,
        leaveTypeId: strict.id,
        startDate: '2026-06-01',
        endDate: '2026-06-05',
        days: '5',
      })
    ).body.data;
    const refused = await o.owner.post(`/payroll/leave/requests/${r1.id}/approve`, {
      version: r1.version,
    });
    expect(refused.status).toBe(409);
    expect(
      (
        await o.owner.post(`/payroll/leave/requests/${r1.id}/reject`, {
          version: r1.version,
          note: ' ',
        })
      ).status,
    ).toBe(400);
    const rejected = await o.owner.post(`/payroll/leave/requests/${r1.id}/reject`, {
      version: r1.version,
      note: 'Peak season',
    });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', decisionNote: 'Peak season' });
    const r2 = (
      await o.staff.client.post('/payroll/leave/requests', {
        employeeId: o.employee.id,
        leaveTypeId: loose.id,
        startDate: '2026-07-01',
        endDate: '2026-07-05',
        days: '5',
      })
    ).body.data;
    expect(
      (await o.owner.post(`/payroll/leave/requests/${r2.id}/approve`, { version: r2.version }))
        .status,
    ).toBe(200);
    // A manager request for someone who is not the caller needs leave.manage; others' requests are hidden from staff.
    expect(
      (
        await o.staff.client.post('/payroll/leave/requests', {
          employeeId: o.employee.id,
          leaveTypeId: strict.id,
          startDate: '2026-08-03',
          endDate: '2026-08-03',
          days: '1',
        })
      ).status,
    ).toBe(201); // their own employee record
    const peer = await joinWithRole(ctx, o.owner, 'Staff');
    expect((await peer.client.get('/payroll/leave/requests')).body.data).toEqual([]);
    expect(
      (
        await peer.client.post('/payroll/leave/requests', {
          leaveTypeId: strict.id,
          startDate: '2026-08-10',
          endDate: '2026-08-10',
          days: '1',
        })
      ).status,
    ).toBe(404);
    expect(
      (await peer.client.get(`/payroll/leave/balances?employeeId=${o.employee.id}`)).status,
    ).toBe(403);
    const other = await payrollOrg();
    expect(
      (
        await other.owner.post('/payroll/leave/requests', {
          employeeId: o.employee.id,
          leaveTypeId: strict.id,
          startDate: '2026-08-10',
          endDate: '2026-08-10',
          days: '1',
        })
      ).status,
    ).toBe(404);
    expect(
      (await other.owner.post(`/payroll/leave/requests/${r2.id}/cancel`, { version: 1 })).status,
    ).toBe(404);
  });
});
