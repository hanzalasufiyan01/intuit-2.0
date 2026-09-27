import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function createRole(owner: TestClient, name: string, permissionKeys: string[]) {
  const response = await owner.post('/organizations/current/roles', { name, permissionKeys });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function setPolicy(client: TestClient, actionKey: string, steps: object[]) {
  const response = await client.put(`/approvals/policies/${actionKey}`, { steps });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.data;
}

async function roleIdByName(owner: TestClient, name: string) {
  const roles = (await owner.get('/organizations/current/roles')).body.data as {
    id: string;
    name: string;
  }[];
  return roles.find((r) => r.name === name)!.id;
}

describe('approval workflow', () => {
  let org: AccountingOrg;
  let admin: Awaited<ReturnType<typeof joinWithRole>>;

  beforeAll(async () => {
    org = await setUpAccountingOrg(ctx);
    admin = await joinWithRole(ctx, org.owner, 'Administrator');
    await setPolicy(org.owner, 'accounting.journal.post', [
      {
        name: 'Administrator approval',
        requiredApprovals: 1,
        roleIds: [await roleIdByName(org.owner, 'Administrator')],
      },
    ]);
  });

  it('blocks direct posting when approval is required', async () => {
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    const direct = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('submit -> approve -> post, with self-approval prohibited', async () => {
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    const submitted = await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');

    const early = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(early.body.error.code).toBe('APPROVAL_REQUIRED');

    // The owner holds accounting.journals.approve but cannot approve their own journal.
    const own = await org.owner.post(`/accounting/journals/${draft.id}/approve`);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('SELF_APPROVAL_PROHIBITED');

    const approved = await admin.client.post(`/accounting/journals/${draft.id}/approve`, {
      comment: 'Looks right',
    });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.approvalStatus).toBe('approved');
    expect((await admin.client.post(`/accounting/journals/${draft.id}/approve`)).status).toBe(409);

    const posted = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(posted.body.data.status).toBe('POSTED');

    const detail = (await org.owner.get(`/accounting/journals/${draft.id}`)).body.data;
    expect(detail.approval).toMatchObject({ status: 'approved', satisfied: true });
    expect(detail.approval.decisions[0]).toMatchObject({
      approverUserId: admin.userId,
      comment: 'Looks right',
    });
    const actions = (await org.owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['journal.approved', 'approval.approved', 'journal.posted']),
    );
  });

  it('prohibits approval by the preparer even when someone else submitted', async () => {
    const draft = (await admin.client.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    const response = await admin.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(response.body.error.code).toBe('SELF_APPROVAL_PROHIBITED');
  });

  it('rejected journals return to draft and can be resubmitted', async () => {
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    const first = (await org.owner.post(`/accounting/journals/${draft.id}/submit`)).body.data;
    const rejected = await admin.client.post(`/accounting/journals/${draft.id}/reject`, {
      comment: 'Wrong account',
    });
    expect(rejected.body.data).toMatchObject({ status: 'DRAFT', approvalStatus: 'rejected' });
    const resubmitted = (await org.owner.post(`/accounting/journals/${draft.id}/submit`)).body.data;
    expect(resubmitted.approvalRequestId).not.toBe(first.approvalRequestId);
    const audit = (await org.owner.get('/organizations/current/audit-events')).body.data;
    expect(
      audit.find((e: { action: string }) => e.action === 'journal.rejected').metadata.comment,
    ).toBe('Wrong account');
  });

  it('rejects approval and posting by unauthorized users', async () => {
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    const approve = await member.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(approve.status).toBe(403);
    expect(approve.body.error.code).toBe('PERMISSION_DENIED');
    const post = await member.client.post(`/accounting/journals/${draft.id}/post`);
    expect(post.body.error.code).toBe('PERMISSION_DENIED');
    // Members can view but not change accounting data.
    expect((await member.client.get('/accounting/journals')).status).toBe(200);
    expect((await member.client.get('/accounting/ledger')).status).toBe(200);
    expect((await member.client.post('/accounting/journals', cashSale(org))).status).toBe(403);
    expect(
      (await member.client.post('/accounting/accounts', { code: 'X1', name: 'X', type: 'ASSET' }))
        .status,
    ).toBe(403);
    expect((await member.client.get('/approvals/policies')).status).toBe(403);
  });
});

describe('configurable authority', () => {
  it('supports "Finance Manager plus CFO" (two AND-ed steps, distinct people)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const perms = ['accounting.journals.view', 'accounting.journals.approve'];
    const fmRole = await createRole(org.owner, 'Finance Manager', perms);
    const cfoRole = await createRole(org.owner, 'CFO', perms);
    const fm = await joinWithRole(ctx, org.owner, 'Finance Manager');
    const cfo = await joinWithRole(ctx, org.owner, 'CFO');
    await setPolicy(org.owner, 'accounting.journal.post', [
      { name: 'Finance Manager', requiredApprovals: 1, roleIds: [fmRole] },
      { name: 'CFO', requiredApprovals: 1, roleIds: [cfoRole] },
    ]);

    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    const first = await fm.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(first.body.data.approvalStatus).toBe('pending');
    expect((await org.owner.post(`/accounting/journals/${draft.id}/post`)).body.error.code).toBe(
      'APPROVAL_REQUIRED',
    );
    const again = await fm.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    const second = await cfo.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(second.body.data.approvalStatus).toBe('approved');
    expect((await org.owner.post(`/accounting/journals/${draft.id}/post`)).status).toBe(200);
  });

  it('supports "Partner A or Partner B" (named members, any one) and rejects others', async () => {
    const org = await setUpAccountingOrg(ctx);
    const partnerA = await joinWithRole(ctx, org.owner, 'Administrator');
    const partnerB = await joinWithRole(ctx, org.owner, 'Administrator');
    const outsider = await joinWithRole(ctx, org.owner, 'Administrator');
    await setPolicy(org.owner, 'accounting.journal.post', [
      {
        name: 'Either partner',
        requiredApprovals: 1,
        membershipIds: [partnerA.membershipId, partnerB.membershipId],
      },
    ]);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    const notEligible = await outsider.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(notEligible.status).toBe(403);
    expect(notEligible.body.error.code).toBe('NOT_ELIGIBLE_APPROVER');
    const approved = await partnerB.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(approved.body.data.approvalStatus).toBe('approved');
  });

  it('snapshots the policy at submission', async () => {
    const org = await setUpAccountingOrg(ctx);
    const approver = await joinWithRole(ctx, org.owner, 'Administrator');
    await setPolicy(org.owner, 'accounting.journal.post', [
      { name: 'One approver', requiredApprovals: 1, membershipIds: [approver.membershipId] },
    ]);
    const draft = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    await org.owner.post(`/accounting/journals/${draft.id}/submit`);
    // Tightening the policy afterwards does not change the in-flight request.
    await setPolicy(org.owner, 'accounting.journal.post', [
      { name: 'One approver', requiredApprovals: 2, membershipIds: [approver.membershipId] },
    ]);
    const approved = await approver.client.post(`/accounting/journals/${draft.id}/approve`);
    expect(approved.body.data.approvalStatus).toBe('approved');
  });

  it('policy changes are sensitive, validated and audited', async () => {
    const org = await setUpAccountingOrg(ctx);
    const invalid = await org.owner.put('/approvals/policies/accounting.journal.post', {
      steps: [{ name: 'Nobody', requiredApprovals: 1 }],
    });
    expect(invalid.status).toBe(400);
    const unknown = await org.owner.put('/approvals/policies/payroll.run', {
      steps: [{ name: 'x', requiredApprovals: 1, membershipIds: [org.ownerMembershipId] }],
    });
    expect(unknown.status).toBe(400);
    await setPolicy(org.owner, 'accounting.journal.post', [
      { name: 'Owner', requiredApprovals: 1, membershipIds: [org.ownerMembershipId] },
    ]);
    expect((await org.owner.delete('/approvals/policies/accounting.journal.post')).status).toBe(
      204,
    );
    const actions = (await org.owner.get('/organizations/current/audit-events')).body.data.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['approval_policy.updated', 'approval_policy.deleted']),
    );
    // Without a policy, direct posting is allowed again.
    await postJournal(org);
  });
});

describe('period reopening under an approval policy', () => {
  it('opens a request; the period reopens only when approved by an eligible approver', async () => {
    const org = await setUpAccountingOrg(ctx);
    const approver = await joinWithRole(ctx, org.owner, 'Administrator');
    const member = await joinWithRole(ctx, org.owner, 'Member');
    const period = org.periods[0]!;
    await org.owner.post(`/accounting/periods/${period.id}/close`);
    await setPolicy(org.owner, 'accounting.period.reopen', [
      {
        name: 'Second person',
        requiredApprovals: 1,
        roleIds: [await roleIdByName(org.owner, 'Administrator')],
      },
    ]);

    expect(
      (await member.client.post(`/accounting/periods/${period.id}/reopen`, { reason: 'Please' }))
        .status,
    ).toBe(403);

    const requested = await org.owner.post(`/accounting/periods/${period.id}/reopen`, {
      reason: 'Missed accrual',
    });
    expect(requested.status).toBe(202);
    expect(requested.body.data.status).toBe('PENDING_APPROVAL');
    const periods = (await org.owner.get('/accounting/periods')).body.data;
    expect(periods.find((p: { id: string }) => p.id === period.id).status).toBe('CLOSED');

    const queue = (await approver.client.get('/approvals/requests')).body.data;
    const request = queue.find((r: { subjectId: string }) => r.subjectId === period.id);
    expect(request).toMatchObject({
      actionKey: 'accounting.period.reopen',
      canDecide: true,
      reason: 'Missed accrual',
    });
    const ownQueue = (await org.owner.get('/approvals/requests')).body.data;
    expect(ownQueue.find((r: { id: string }) => r.id === request.id).canDecide).toBe(false);

    const approved = await approver.client.post(`/approvals/requests/${request.id}/approve`);
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.data.requestStatus).toBe('approved');
    const after = (await org.owner.get('/accounting/periods')).body.data;
    expect(after.find((p: { id: string }) => p.id === period.id)).toMatchObject({
      status: 'OPEN',
      reopenReason: 'Missed accrual',
    });
    const audit = (await org.owner.get('/organizations/current/audit-events')).body.data;
    const reopened = audit.find((e: { action: string }) => e.action === 'period.reopened');
    expect(reopened.metadata).toMatchObject({
      reason: 'Missed accrual',
      approvalRequestId: request.id,
      finalApproverUserId: approver.userId,
    });
  });
});

describe('cross-tenant isolation', () => {
  it('organization A cannot read, modify, post into or query organization B', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const bJournal = (await b.owner.post('/accounting/journals', cashSale(b))).body.data;
    const bPosted = await postJournal(b);
    const bAccount = b.accounts['1110']!;
    const bPeriod = b.periods[0]!.id;

    const attempts = await Promise.all([
      a.owner.get(`/accounting/accounts/${bAccount}`),
      a.owner.patch(`/accounting/accounts/${bAccount}`, { name: 'hijack' }),
      a.owner.delete(`/accounting/accounts/${bAccount}`),
      a.owner.post(`/accounting/accounts/${bAccount}/archive`),
      a.owner.get(`/accounting/journals/${bJournal.id}`),
      a.owner.patch(`/accounting/journals/${bJournal.id}`, { description: 'hijack' }),
      a.owner.post(`/accounting/journals/${bJournal.id}/post`),
      a.owner.post(`/accounting/journals/${bPosted.id}/reverse`, { reason: 'hijack' }),
      a.owner.post(`/accounting/periods/${bPeriod}/close`),
      a.owner.get(`/accounting/ledger?accountId=${bAccount}`),
      a.owner.get(`/accounting/fiscal-years/${b.periods[0]!.id}`),
    ]);
    for (const response of attempts) expect(response.status).toBe(404);

    // Using B's account ids in A's journal is rejected.
    const foreign = await a.owner.post('/accounting/journals', {
      entryDate: '2026-03-01',
      currency: 'MVR',
      lines: [line(bAccount, 'debit', '1.00'), line(a.accounts['4100']!, 'credit', '1.00')],
    });
    expect(foreign.status).toBe(400);

    // A's lists never include B's data.
    const aJournals = (await a.owner.get('/accounting/journals')).body.data.map(
      (j: { id: string }) => j.id,
    );
    expect(aJournals).not.toContain(bJournal.id);
    const aLedger = JSON.stringify((await a.owner.get('/accounting/ledger')).body);
    expect(aLedger).not.toContain(bPosted.id);

    // B's data is unchanged.
    expect((await b.owner.get(`/accounting/journals/${bJournal.id}`)).body.data.status).toBe(
      'DRAFT',
    );
    expect((await b.owner.get('/accounting/periods')).body.data[0].status).toBe('OPEN');
  });

  it('row-level security hides other organizations from the application role', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    await postJournal(b);
    const db = await connectAs('app');
    try {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.organization_id', $1, true)`, [a.organizationId]);
      for (const table of [
        'accounting_settings',
        'accounting_accounts',
        'accounting_fiscal_years',
        'accounting_periods',
        'accounting_journal_entries',
        'accounting_journal_lines',
        'accounting_events',
        'approval_policies',
        'approval_requests',
      ]) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`,
          [b.organizationId],
        );
        expect(rows[0].n, table).toBe(0);
      }
      await db.query('SAVEPOINT s');
      await expect(
        db.query(
          `INSERT INTO accounting_accounts (organization_id, code, name, account_type, created_by_user_id)
           SELECT $1, 'HACK', 'hack', 'ASSET', created_by_user_id FROM organizations WHERE id = $2`,
          [b.organizationId, a.organizationId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await db.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await db.query('ROLLBACK');
      await db.end();
    }
  });

  it('approval decisions are append-only', async () => {
    const db = await connectAs('owner');
    try {
      await expect(
        db.query(`UPDATE approval_decisions SET decision = 'approved'`),
      ).rejects.toMatchObject({
        code: '42501',
      });
      await expect(db.query('DELETE FROM approval_decisions')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await db.end();
    }
    const app = await connectAs('app');
    try {
      await expect(app.query('DELETE FROM approval_decisions')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(app.query('DELETE FROM accounting_journal_entries')).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await app.end();
    }
  });
});

describe('accounting events', () => {
  const origin = { requestId: null, ipAddress: null, userAgent: null };

  it('are idempotent: replays never create a second journal', async () => {
    const org = await setUpAccountingOrg(ctx);
    const eventType = 'test_sale.recorded';
    ctx.services.journals.registerEventHandler(eventType, ({ payload }) => ({
      entryDate: String(payload.date),
      description: `Sale ${String(payload.saleId)}`,
      reference: String(payload.saleId),
      currency: 'MVR',
      exchangeRate: null,
      lines: [
        line(org.accounts['1130']!, 'debit', String(payload.amount)),
        line(org.accounts['4100']!, 'credit', String(payload.amount)),
      ],
    }));
    const event = {
      organizationId: org.organizationId,
      sourceModule: 'test-sales',
      eventType,
      eventKey: `sale-${randomUUID()}`,
      payload: { saleId: 'S-1', amount: '42.50', date: '2026-07-01' },
      occurredAt: new Date(),
      origin,
    };
    const first = await ctx.services.journals.receiveEvent(event);
    expect(first).toMatchObject({ outcome: 'processed', status: 'processed' });
    const replay = await ctx.services.journals.receiveEvent(event);
    expect(replay).toMatchObject({ outcome: 'duplicate', journalId: first.journalId });

    const posted = (await org.owner.get('/accounting/journals?status=POSTED')).body.data;
    expect(posted.filter((j: { reference: string }) => j.reference === 'S-1')).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: 'event', totalDebit: '42.5000' });

    await expect(
      ctx.services.journals.receiveEvent({
        ...event,
        payload: { ...event.payload, amount: '99.00' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('records events without a handler and marks invalid ones failed without partial postings', async () => {
    const org = await setUpAccountingOrg(ctx);
    const unhandled = await ctx.services.journals.receiveEvent({
      organizationId: org.organizationId,
      sourceModule: 'test-inventory',
      eventType: 'inventory.adjusted',
      eventKey: randomUUID(),
      payload: { sku: 'A' },
      occurredAt: new Date(),
      origin,
    });
    expect(unhandled).toMatchObject({ outcome: 'received', journalId: null });

    ctx.services.journals.registerEventHandler('test_bad.recorded', () => ({
      entryDate: '2026-07-01',
      description: 'unbalanced',
      reference: '',
      currency: 'MVR',
      exchangeRate: null,
      lines: [
        line(org.accounts['1130']!, 'debit', '1.00'),
        line(org.accounts['4100']!, 'credit', '2.00'),
      ],
    }));
    const failed = await ctx.services.journals.receiveEvent({
      organizationId: org.organizationId,
      sourceModule: 'test-bad',
      eventType: 'test_bad.recorded',
      eventKey: randomUUID(),
      payload: {},
      occurredAt: new Date(),
      origin,
    });
    expect(failed).toMatchObject({ outcome: 'failed', journalId: null });
    expect((await org.owner.get('/accounting/journals')).body.data).toHaveLength(0);
  });
});
