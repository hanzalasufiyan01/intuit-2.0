import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Employee expense claims: the employee role, drafts and receipts, conditional approval, posting
 * as a bill from the employee as a vendor (the AP engine), reimbursement through a vendor payment,
 * cancellation and voids, and security. A claim never writes the ledger itself.
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

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');

interface ClaimOrg extends AccountingOrg {
  employeeId: string;
}

async function claimOrg(): Promise<ClaimOrg> {
  const org = await setUpAccountingOrg(ctx);
  const purchases = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
  const employee = await org.owner.post('/parties', {
    kind: 'individual',
    displayName: 'Aishath Ali',
    roles: ['employee'],
  });
  expect(employee.status, JSON.stringify(employee.body)).toBe(201);
  return { ...org, employeeId: employee.body.data.id as string };
}

const draft = (o: ClaimOrg, overrides: Record<string, unknown> = {}) => ({
  employeePartyId: o.employeeId,
  claimDate: '2026-03-20',
  memo: 'Site visit',
  lines: [
    {
      expenseDate: '2026-03-18',
      description: 'Taxi to the airport',
      accountId: undefined,
      amount: '60.00',
    },
    { expenseDate: '2026-03-19', description: 'Lunch with client', amount: '140.50' },
  ],
  ...overrides,
});

async function createClaim(o: ClaimOrg, overrides: Record<string, unknown> = {}) {
  const res = await o.owner.post('/expense-claims', draft(o, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function approvedClaim(o: ClaimOrg, overrides: Record<string, unknown> = {}) {
  const claim = await createClaim(o, overrides);
  const res = await o.owner.post(`/expense-claims/${claim.id}/submit`, { version: claim.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.data.status).toBe('APPROVED');
  return res.body.data;
}

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

async function auditActions(o: AccountingOrg, id: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = 'expense_claim' AND resource_id = $2 ORDER BY occurred_at, id`,
    [o.organizationId, id],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function reauth(client: TestClient) {
  ctx.clock.advance(16 * MINUTE);
  await client.get('/auth/session');
  expect((await client.reauthenticate()).status).toBe(200);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('expense claim drafts', () => {
  it('totals the lines on the server, defaults the account and posts nothing', async () => {
    const o = await claimOrg();
    const claim = await createClaim(o);
    expect(claim).toMatchObject({
      status: 'DRAFT',
      number: null,
      total: '200.50',
      billId: null,
      employeeName: 'Aishath Ali',
    });
    expect(claim.lines.map((l: { accountId: string }) => l.accountId)).toEqual([
      o.accounts['5400'],
      o.accounts['5400'],
    ]);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(0);
    const edited = await o.owner.put(`/expense-claims/${claim.id}`, {
      ...draft(o, { lines: [{ expenseDate: '2026-03-18', description: 'Taxi', amount: '75.00' }] }),
      version: claim.version,
    });
    expect(edited.body.data.total).toBe('75.00');
    const deleted = await o.owner.delete(
      `/expense-claims/${claim.id}?version=${edited.body.data.version}`,
    );
    expect(deleted.status).toBe(200);
  });

  it('needs an employee, sound lines and accounts that purchases can use', async () => {
    const o = await claimOrg();
    const other = await o.owner.post('/parties', {
      kind: 'individual',
      displayName: 'Not staff',
      roles: ['other'],
    });
    const notEmployee = await o.owner.post(
      '/expense-claims',
      draft(o, { employeePartyId: other.body.data.id }),
    );
    expect(notEmployee.body.error.details.issues[0].path).toBe('employeePartyId');
    const bad = await o.owner.post(
      '/expense-claims',
      draft(o, {
        lines: [
          { expenseDate: '2026-04-30', description: 'After the claim', amount: '10' },
          {
            expenseDate: '2026-03-01',
            description: 'Bank',
            accountId: o.accounts['1120'],
            amount: '10',
          },
          { expenseDate: '2026-03-01', description: 'Too precise', amount: '10.123' },
        ],
      }),
    );
    expect(bad.status).toBe(400);
    const paths = bad.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['lines.0.expenseDate', 'lines.1.accountId']));
  });
});

// ---------------------------------------------------------------------------
// Submission, receipts and approval
// ---------------------------------------------------------------------------

describe('submission, receipts and approval', () => {
  it('approves at once when no policy applies, numbers EC-, and then fixes the claim', async () => {
    const o = await claimOrg();
    const first = await approvedClaim(o);
    const second = await approvedClaim(o);
    expect([first.number, second.number]).toEqual(['EC-00001', 'EC-00002']);
    const edit = await o.owner.put(`/expense-claims/${first.id}`, {
      ...draft(o),
      version: first.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expect(
      owner.query(`UPDATE expense_claims SET total = 1 WHERE id = $1`, [first.id]),
    ).rejects.toThrow(/cannot be edited/);
    await expect(
      owner.query(`UPDATE expense_claim_lines SET amount = 1 WHERE claim_id = $1`, [first.id]),
    ).rejects.toThrow(/immutable/);
    expect(await auditActions(o, first.id)).toEqual([
      'expense_claim.created',
      'expense_claim.approved',
    ]);
  });

  it('requires a receipt above the configured amount', async () => {
    const o = await claimOrg();
    const settings = await o.owner.put('/expense-claims/settings', {
      version: 0,
      defaultExpenseAccountId: o.accounts['5400'],
      receiptRequiredOver: '100.00',
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const claim = await createClaim(o);
    const blocked = await o.owner.post(`/expense-claims/${claim.id}/submit`, {
      version: claim.version,
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.error.details.issues[0].path).toBe('receipts');
    const upload = await o.owner.upload(
      `/files?linkType=expense_claim&linkId=${claim.id}`,
      PDF,
      'lunch.pdf',
    );
    expect(upload.status, JSON.stringify(upload.body)).toBe(201);
    const ok = await o.owner.post(`/expense-claims/${claim.id}/submit`, { version: claim.version });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.receiptCount).toBe(1);
    // A receipt cannot be removed once the claim is submitted.
    expect((await o.owner.delete(`/files/${upload.body.data.id}`)).status).toBe(409);
  });

  describe('with an approval policy', () => {
    async function withPolicy(threshold: string) {
      const o = await claimOrg();
      await createRole(o.owner, 'Claim approver', [
        'expense_claims.view',
        'expense_claims.approve',
      ]);
      const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
        id: string;
        name: string;
      }[];
      const roleId = roles.find((r) => r.name === 'Claim approver')!.id;
      const policy = await o.owner.put('/approvals/policies/expense_claims.approve', {
        steps: [
          {
            name: 'Finance manager',
            requiredApprovals: 1,
            roleIds: [roleId],
            membershipIds: [],
            conditions: { minBaseAmount: threshold },
          },
        ],
      });
      expect(policy.status, JSON.stringify(policy.body)).toBe(200);
      return { o, approver: (await joinWithRole(ctx, o.owner, 'Claim approver')).client };
    }

    it('holds a large claim for approval, refuses self-approval and approves', async () => {
      const { o, approver } = await withPolicy('150');
      const small = await approvedClaim(o, {
        lines: [{ expenseDate: '2026-03-18', description: 'Taxi', amount: '60.00' }],
      });
      expect(small.status).toBe('APPROVED');
      const large = await createClaim(o);
      const submitted = await o.owner.post(`/expense-claims/${large.id}/submit`, {
        version: large.version,
      });
      expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
      const requestId = submitted.body.data.approval.requestId;
      expect(
        (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
      ).toBe('SELF_APPROVAL_PROHIBITED');
      const approved = await approver.post(`/approvals/requests/${requestId}/approve`, {});
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await o.owner.get(`/expense-claims/${large.id}`)).body.data.status).toBe('APPROVED');
    });

    it('needs a reason to reject, returns to draft and supports withdrawal', async () => {
      const { o, approver } = await withPolicy('0');
      const claim = await createClaim(o);
      const submitted = (
        await o.owner.post(`/expense-claims/${claim.id}/submit`, { version: claim.version })
      ).body.data;
      const requestId = submitted.approval.requestId;
      expect((await approver.post(`/approvals/requests/${requestId}/reject`, {})).status).toBe(400);
      expect(
        (await approver.post(`/approvals/requests/${requestId}/reject`, { comment: 'No receipt' }))
          .status,
      ).toBe(200);
      const back = (await o.owner.get(`/expense-claims/${claim.id}`)).body.data;
      expect(back.status).toBe('DRAFT');
      const again = (
        await o.owner.post(`/expense-claims/${claim.id}/submit`, { version: back.version })
      ).body.data;
      expect(again.number).toBe(submitted.number);
      const withdrawn = await o.owner.post(`/expense-claims/${claim.id}/withdraw`, {
        version: again.version,
      });
      expect(withdrawn.body.data.status).toBe('DRAFT');
    });
  });
});

// ---------------------------------------------------------------------------
// Posting and reimbursement
// ---------------------------------------------------------------------------

describe('posting and reimbursement', () => {
  it('posts as a bill from the employee as a vendor: Dr expense / Cr AP', async () => {
    const o = await claimOrg();
    const claim = await approvedClaim(o);
    const posted = await o.owner.post(`/expense-claims/${claim.id}/post`, {
      version: claim.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data).toMatchObject({ status: 'POSTED', total: '200.50' });
    expect(posted.body.data.bill).toMatchObject({
      status: 'POSTED',
      total: '200.50',
      amountDue: '200.50',
      reimbursed: false,
    });
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('200.50');
    expect(await glBalance(o.organizationId, o.accounts['2110']!)).toBe('-200.50');
    // The employee is a vendor with the claim's bill, and appears in the AP aging.
    const vendors = (await o.owner.get('/vendors?search=Aishath')).body.data.items;
    expect(vendors).toHaveLength(1);
    const bill = (await o.owner.get(`/purchases/bills/${posted.body.data.bill.id}`)).body.data;
    expect(bill).toMatchObject({ vendorReference: claim.number, vendorName: 'Aishath Ali' });
    const again = await o.owner.post(`/expense-claims/${claim.id}/post`, {
      version: claim.version,
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, claim.id)).toEqual(
      expect.arrayContaining(['expense_claim.bill_created', 'expense_claim.posted']),
    );
  });

  it('is reimbursed by an ordinary vendor payment', async () => {
    const o = await claimOrg();
    const claim = await approvedClaim(o);
    const posted = (
      await o.owner.post(`/expense-claims/${claim.id}/post`, { version: claim.version })
    ).body.data;
    const payment = await o.owner.post('/purchases/payments', {
      vendorId: (await o.owner.get('/vendors?search=Aishath')).body.data.items[0].id,
      paymentDate: '2026-03-25',
      amount: '200.50',
      allocations: [{ billId: posted.bill.id, amount: '200.50' }],
    });
    expect(payment.status, JSON.stringify(payment.body)).toBe(201);
    const recorded = await o.owner.post(`/purchases/payments/${payment.body.data.id}/record`, {
      version: payment.body.data.version,
    });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(200);
    const after = (await o.owner.get(`/expense-claims/${claim.id}`)).body.data;
    expect(after.bill).toMatchObject({ amountDue: '0.00', reimbursed: true });
    // A reimbursed claim cannot be voided: the payment comes first.
    await reauth(o.owner);
    const voided = await o.owner.post(`/expense-claims/${claim.id}/void`, {
      version: after.version,
      reason: 'Duplicate',
    });
    expect(voided.status).toBe(409);
  });

  it('resumes a claim whose bill stopped for the bill approval policy', async () => {
    const o = await claimOrg();
    await createRole(o.owner, 'Bill approver', ['bills.view', 'bills.approve']);
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const roleId = roles.find((r) => r.name === 'Bill approver')!.id;
    await o.owner.put('/approvals/policies/purchases.bill.post', {
      steps: [
        {
          name: 'Bills',
          requiredApprovals: 1,
          roleIds: [roleId],
          membershipIds: [],
          conditions: { minBaseAmount: '0' },
        },
      ],
    });
    const approver = (await joinWithRole(ctx, o.owner, 'Bill approver')).client;
    const claim = await approvedClaim(o);
    const stopped = await o.owner.post(`/expense-claims/${claim.id}/post`, {
      version: claim.version,
    });
    expect(stopped.status).toBe(409);
    expect(stopped.body.error.code).toBe('APPROVAL_REQUIRED');
    const mid = (await o.owner.get(`/expense-claims/${claim.id}`)).body.data;
    expect(mid).toMatchObject({ status: 'APPROVED' });
    expect(mid.bill).toMatchObject({ status: 'DRAFT' });
    // The bill is submitted and approved in Bills; posting the claim again finishes it.
    const bill = (await o.owner.get(`/purchases/bills/${mid.bill.id}`)).body.data;
    const submitted = await o.owner.post(`/purchases/bills/${bill.id}/submit`, {
      version: bill.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(
      (
        await approver.post(
          `/approvals/requests/${submitted.body.data.approval.requestId}/approve`,
          {},
        )
      ).status,
    ).toBe(200);
    const done = await o.owner.post(`/expense-claims/${claim.id}/post`, { version: mid.version });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('POSTED');
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM purchases_bills WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(1);
  });

  it('cancels an approved claim that has no bill, and voids a posted one through its bill', async () => {
    const o = await claimOrg();
    const cancelled = await approvedClaim(o);
    const res = await o.owner.post(`/expense-claims/${cancelled.id}/cancel`, {
      version: cancelled.version,
      reason: 'Duplicate claim',
    });
    expect(res.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Duplicate claim' });
    expect(
      (
        await o.owner.post(`/expense-claims/${cancelled.id}/post`, {
          version: res.body.data.version,
        })
      ).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');

    const claim = await approvedClaim(o);
    const posted = (
      await o.owner.post(`/expense-claims/${claim.id}/post`, { version: claim.version })
    ).body.data;
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/expense-claims/${claim.id}/void`, {
      version: posted.version,
      reason: 'Wrong employee',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/expense-claims/${claim.id}/void`, {
      version: posted.version,
      reason: 'Wrong employee',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data.status).toBe('VOID');
    expect(voided.body.data.bill.status).toBe('VOID');
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

describe('security', () => {
  it('is permissioned and tenant-isolated, and posting needs the bill permissions', async () => {
    const a = await claimOrg();
    const b = await claimOrg();
    const claim = await approvedClaim(a);
    expect((await b.owner.get(`/expense-claims/${claim.id}`)).status).toBe(404);
    expect(
      (await b.owner.post(`/expense-claims/${claim.id}/post`, { version: claim.version })).status,
    ).toBe(404);
    expect((await b.owner.get('/expense-claims')).body.data.items).toEqual([]);
    const member = await joinWithRole(ctx, a.owner, 'Member');
    expect((await member.client.get(`/expense-claims/${claim.id}`)).status).toBe(200);
    expect((await member.client.post('/expense-claims', draft(a))).status).toBe(403);
    expect(
      (await member.client.post(`/expense-claims/${claim.id}/post`, { version: claim.version }))
        .status,
    ).toBe(403);
    expect(
      (
        await member.client.put('/expense-claims/settings', {
          version: 0,
          defaultExpenseAccountId: null,
          receiptRequiredOver: null,
        })
      ).status,
    ).toBe(403);
    // A poster without the bill permissions cannot create the bill.
    await createRole(a.owner, 'Claim poster', ['expense_claims.view', 'expense_claims.post']);
    const poster = await joinWithRole(ctx, a.owner, 'Claim poster');
    const refused = await poster.client.post(`/expense-claims/${claim.id}/post`, {
      version: claim.version,
    });
    expect(refused.status).toBe(403);
    expect((await a.owner.get(`/expense-claims/${claim.id}`)).body.data.status).toBe('APPROVED');
    const client = await connectAs('app');
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      for (const table of ['expense_claims', 'expense_claim_lines']) {
        const { rows } = await client.query(`SELECT organization_id FROM ${table}`);
        expect(
          rows.every((r: { organization_id: string }) => r.organization_id === b.organizationId),
          table,
        ).toBe(true);
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
    expect(randomUUID()).toBeTruthy();
  });
});
