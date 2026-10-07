import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { createTestContext, MINUTE, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 4B-10: the foreign-currency revaluation user workflow (ADR 0004 P4-52, Decision 9) over
 * HTTP, on the frozen S9 engine: preview, post, conditional approval on the S9 PENDING_APPROVAL
 * state, the approved post that must equal the approved calculation, withdrawal, rejection,
 * cancellation, the AR and AP document providers, permissions and tenant isolation.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const ACTION = 'accounting.revaluation.post';

async function createAccount(o: AccountingOrg, body: Record<string, unknown>): Promise<string> {
  const res = await o.owner.post('/accounting/accounts', {
    type: 'ASSET',
    parentId: o.accounts['1100'],
    currencyCode: 'USD',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id;
}

async function rate(o: AccountingOrg, rateDate: string, value: string) {
  const res = await o.owner.post('/accounting/exchange-rates', {
    fromCurrency: 'USD',
    rateDate,
    rate: value,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

interface Org extends AccountingOrg {
  usdBank: string;
}

/** FY2026; a USD bank holding 1,000 USD deposited on 2026-01-15 at 15.42; 15.50 on 2026-03-31. */
async function org(): Promise<Org> {
  const base = await setUpAccountingOrg(ctx);
  const usdBank = await createAccount(base, { code: '1125', name: 'Bank USD', subtype: 'BANK' });
  await rate(base, '2026-01-01', '15.42');
  await postJournal(base, {
    entryDate: '2026-01-15',
    description: 'USD deposit',
    currency: 'USD',
    lines: [line(usdBank, 'debit', '1000.00'), line(base.accounts['4100']!, 'credit', '1000.00')],
  } as never);
  await rate(base, '2026-03-31', '15.50');
  return { ...base, usdBank };
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** A policy needing one approval from a role holding accounting.journals.approve. */
async function withPolicy(threshold: string) {
  const o = await org();
  const roleId = await createRole(o.owner, 'Revaluation approver', [
    'accounting.journals.view',
    'accounting.journals.approve',
  ]);
  const policy = await o.owner.put(`/approvals/policies/${ACTION}`, {
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
  const approver = await joinWithRole(ctx, o.owner, 'Revaluation approver');
  return { o, approver: approver.client };
}

async function auditActions(o: AccountingOrg) {
  const res = await o.owner.get('/organizations/current/audit-events?limit=100');
  return (res.body.data as { action: string }[]).map((a) => a.action);
}

describe('revaluation preview, post and cancel over HTTP', () => {
  it('previews without writing, then posts with the S9 journals and an idempotent retry', async () => {
    const o = await org();
    const preview = await o.owner.post('/accounting/revaluations/preview', {
      revaluationDate: '2026-03-31',
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data).toMatchObject({
      approvalRequired: false,
      revaluationDate: '2026-03-31',
      reversalDate: '2026-04-01',
      errors: [],
      totals: { gain: '80', loss: '0', net: '80' },
    });
    expect((await o.owner.get('/accounting/revaluations')).body.data).toHaveLength(0);

    const key = { 'Idempotency-Key': randomUUID() };
    const posted = await o.owner.post(
      '/accounting/revaluations',
      { revaluationDate: '2026-03-31' },
      key,
    );
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    expect(posted.body.data).toMatchObject({
      status: 'POSTED',
      method: 'REVERSING',
      totalGain: '80',
      journalCount: 1,
    });
    const retry = await o.owner.post(
      '/accounting/revaluations',
      { revaluationDate: '2026-03-31' },
      key,
    );
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(posted.body.data.id);
    // A second run for the same date is refused while the first stands.
    const again = await o.owner.post('/accounting/revaluations', { revaluationDate: '2026-03-31' });
    expect(again.status).toBe(409);
    const detail = (await o.owner.get(`/accounting/revaluations/${posted.body.data.id}`)).body.data;
    expect(detail.journals.map((j: { role: string }) => j.role).sort()).toEqual([
      'REVALUATION',
      'SCHEDULED_REVERSAL',
    ]);
    expect(detail.approval).toMatchObject({ readyToIssue: false, requestId: null });
    expect((await o.owner.get('/accounting/revaluations')).body.data).toHaveLength(1);
  });

  it('needs a recent password confirmation to post and to cancel, and cancels with a reason', async () => {
    const o = await org();
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post('/accounting/revaluations', { revaluationDate: '2026-03-31' });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const run = (await o.owner.post('/accounting/revaluations', { revaluationDate: '2026-03-31' }))
      .body.data;
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const needsAuth = await o.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
      version: run.version,
      reason: 'Wrong rate',
    });
    expect(needsAuth.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const short = await o.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
      version: run.version,
      reason: 'x',
    });
    expect(short.status).toBe(400);
    const stale2 = await o.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
      version: run.version + 5,
      reason: 'Wrong rate',
    });
    expect(stale2.body.error.code).toBe('VERSION_CONFLICT');
    const cancelled = await o.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
      version: run.version,
      reason: 'Wrong rate',
    });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'REVERSED', reversalReason: 'Wrong rate' });
    const twice = await o.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
      version: cancelled.body.data.version,
      reason: 'Again',
    });
    expect(twice.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // The date can be revalued again once its run is reversed.
    const reposted = await o.owner.post('/accounting/revaluations', {
      revaluationDate: '2026-03-31',
    });
    expect(reposted.status, JSON.stringify(reposted.body)).toBe(201);
  });

  it('validates the date, accepts a stale-rate date and takes no manual rates', async () => {
    const o = await org();
    const noRate = await o.owner.post('/accounting/revaluations', {
      revaluationDate: '2026-02-28',
    });
    expect(noRate.status).toBe(201); // the January rate is in effect: stale but usable
    const empty = await o.owner.post('/accounting/revaluations/preview', {
      revaluationDate: 'not-a-date',
    });
    expect(empty.status).toBe(400);
    expect(
      (await o.owner.post('/accounting/revaluations', { revaluationDate: '2026-03-31', rates: {} }))
        .status,
    ).toBe(400);
  });
});

describe('revaluation approval (P4-52, S9 PENDING_APPROVAL)', () => {
  it('refuses a direct post when a policy applies; approval authorizes and the approved post equals the calculation', async () => {
    const { o, approver } = await withPolicy('50');
    const direct = await o.owner.post('/accounting/revaluations', {
      revaluationDate: '2026-03-31',
    });
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(
      (await o.owner.post('/accounting/revaluations/preview', { revaluationDate: '2026-03-31' }))
        .body.data.approvalRequired,
    ).toBe(true);
    const submitted = await o.owner.post('/accounting/revaluations/submit', {
      revaluationDate: '2026-03-31',
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(201);
    const run = submitted.body.data;
    expect(run).toMatchObject({ status: 'PENDING_APPROVAL', totalGain: '80', journalCount: 0 });
    expect(run.approval).toMatchObject({ required: true, readyToIssue: false });
    // The date is held while the run waits; journals are not posted.
    expect(
      (await o.owner.post('/accounting/revaluations/submit', { revaluationDate: '2026-03-31' }))
        .status,
    ).toBe(409);
    expect((await o.owner.get(`/accounting/revaluations/${run.id}`)).body.data.journals).toEqual(
      [],
    );
    // Posting before approval is refused.
    const early = await o.owner.post(`/accounting/revaluations/${run.id}/post`, {
      version: run.version,
    });
    expect(early.body.error.code).toBe('APPROVAL_REQUIRED');
    const requestId = run.approval.requestId;
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    const approved = await approver.post(`/approvals/requests/${requestId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = (await o.owner.get(`/accounting/revaluations/${run.id}`)).body.data;
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', journalCount: 0 });
    expect(after.approval).toMatchObject({ readyToIssue: true, requestStatus: 'approved' });
    const done = await o.owner.post(`/accounting/revaluations/${run.id}/post`, {
      version: after.version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'POSTED', totalGain: '80', journalCount: 1 });
    expect(done.body.data.approvalRequestId).toBe(requestId);
    expect(await auditActions(o)).toEqual(
      expect.arrayContaining([
        'revaluation.submitted',
        'revaluation.approved',
        'revaluation.posted',
      ]),
    );
    // Posted once only.
    expect(
      (
        await o.owner.post(`/accounting/revaluations/${run.id}/post`, {
          version: done.body.data.version,
        })
      ).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('posts directly below the threshold and has nothing to submit', async () => {
    const { o } = await withPolicy('500');
    const small = await o.owner.post('/accounting/revaluations/submit', {
      revaluationDate: '2026-03-31',
    });
    expect(small.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // Submitting rolled back: no run was left behind and the date is free.
    expect((await o.owner.get('/accounting/revaluations')).body.data).toHaveLength(0);
    const direct = await o.owner.post('/accounting/revaluations', {
      revaluationDate: '2026-03-31',
    });
    expect(direct.status, JSON.stringify(direct.body)).toBe(201);
  });

  it('refuses the approved post when balances or rates moved since approval', async () => {
    const { o, approver } = await withPolicy('50');
    const run = (
      await o.owner.post('/accounting/revaluations/submit', { revaluationDate: '2026-03-31' })
    ).body.data;
    expect(
      (await approver.post(`/approvals/requests/${run.approval.requestId}/approve`, {})).status,
    ).toBe(200);
    // A new deposit changes the USD balance the approvers saw.
    await postJournal(o, {
      entryDate: '2026-02-10',
      description: 'More USD',
      currency: 'USD',
      lines: [line(o.usdBank, 'debit', '500.00'), line(o.accounts['4100']!, 'credit', '500.00')],
    } as never);
    const res = await o.owner.post(`/accounting/revaluations/${run.id}/post`, {
      version: (await o.owner.get(`/accounting/revaluations/${run.id}`)).body.data.version,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('have changed since this revaluation was submitted');
    expect((await o.owner.get(`/accounting/revaluations/${run.id}`)).body.data.status).toBe(
      'PENDING_APPROVAL',
    );
  });

  it('needs a reason to reject and frees the date; withdrawal does the same', async () => {
    const { o, approver } = await withPolicy('0');
    const first = (
      await o.owner.post('/accounting/revaluations/submit', { revaluationDate: '2026-03-31' })
    ).body.data;
    const requestId = first.approval.requestId;
    const noReason = await approver.post(`/approvals/requests/${requestId}/reject`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.issues[0].path).toBe('comment');
    const rejected = await approver.post(`/approvals/requests/${requestId}/reject`, {
      comment: 'Check the rate',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await o.owner.get(`/accounting/revaluations/${first.id}`)).status).toBe(404);
    const second = (
      await o.owner.post('/accounting/revaluations/submit', { revaluationDate: '2026-03-31' })
    ).body.data;
    expect(
      (await o.owner.post(`/accounting/revaluations/${second.id}/withdraw`, { version: 99 })).body
        .error.code,
    ).toBe('VERSION_CONFLICT');
    const withdrawn = await o.owner.post(`/accounting/revaluations/${second.id}/withdraw`, {
      version: second.version,
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect((await o.owner.get(`/accounting/revaluations/${second.id}`)).status).toBe(404);
    expect(await auditActions(o)).toEqual(
      expect.arrayContaining(['revaluation.rejected', 'revaluation.withdrawn']),
    );
    // The date is free again.
    expect(
      (await o.owner.post('/accounting/revaluations/submit', { revaluationDate: '2026-03-31' }))
        .status,
    ).toBe(201);
  });
});

describe('document exposures (AR and AP providers)', () => {
  it('revalues an open foreign-currency bill through the AP provider', async () => {
    const base = await setUpAccountingOrg(ctx);
    const settings = await base.owner.put('/purchases/settings', {
      version: 0,
      apAccountId: base.accounts['2110'],
      defaultExpenseAccountId: base.accounts['5400'],
      defaultPaymentAccountId: base.accounts['1120'],
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const vendor = await base.owner.post('/vendors', {
      party: { kind: 'organization', displayName: 'Island Supplies' },
      currencyCode: 'USD',
    });
    expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
    await rate(base, '2026-01-01', '15.42');
    const bill = await base.owner.post('/purchases/bills', {
      vendorId: vendor.body.data.id,
      billDate: '2026-02-10',
      vendorReference: 'SI-1',
      lines: [{ description: 'Engine part', quantity: '1', unitPrice: '100', taxCodeId: null }],
    });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    expect(
      (
        await base.owner.post(`/purchases/bills/${bill.body.data.id}/post`, {
          version: bill.body.data.version,
        })
      ).status,
    ).toBe(200);
    await rate(base, '2026-03-31', '15.50');
    const preview = await base.owner.post('/accounting/revaluations/preview', {
      revaluationDate: '2026-03-31',
    });
    expect(preview.status, JSON.stringify(preview.body)).toBe(200);
    expect(preview.body.data.errors).toEqual([]);
    expect(preview.body.data.totals).toMatchObject({ gain: '0', loss: '8', net: '-8' });
    const posted = await base.owner.post('/accounting/revaluations', {
      revaluationDate: '2026-03-31',
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(201);
    const documentLine = posted.body.data.lines.find(
      (l: { exposureKind: string }) => l.exposureKind === 'DOCUMENT',
    );
    expect(documentLine).toMatchObject({
      currency: 'USD',
      document: { module: 'purchases', type: 'bill', id: bill.body.data.id },
      adjustment: '-8',
    });
  });
});

describe('revaluation security', () => {
  it('follows the journal permissions for each action and isolates tenants', async () => {
    const o = await org();
    await createRole(o.owner, 'Journal viewer', ['accounting.journals.view']);
    await createRole(o.owner, 'Journal poster', [
      'accounting.journals.view',
      'accounting.journals.post',
    ]);
    const viewer = await joinWithRole(ctx, o.owner, 'Journal viewer');
    const poster = await joinWithRole(ctx, o.owner, 'Journal poster');
    const run = (await o.owner.post('/accounting/revaluations', { revaluationDate: '2026-03-31' }))
      .body.data;
    // A viewer reads and previews but never writes.
    expect((await viewer.client.get('/accounting/revaluations')).status).toBe(200);
    expect((await viewer.client.get(`/accounting/revaluations/${run.id}`)).status).toBe(200);
    expect(
      (
        await viewer.client.post('/accounting/revaluations/preview', {
          revaluationDate: '2026-03-31',
        })
      ).status,
    ).toBe(200);
    expect(
      (await viewer.client.post('/accounting/revaluations', { revaluationDate: '2026-04-30' }))
        .status,
    ).toBe(403);
    expect(
      (
        await viewer.client.post('/accounting/revaluations/submit', {
          revaluationDate: '2026-04-30',
        })
      ).status,
    ).toBe(403);
    // A poster may post but not cancel.
    expect(
      (
        await poster.client.post(`/accounting/revaluations/${run.id}/cancel`, {
          version: run.version,
          reason: 'No right',
        })
      ).status,
    ).toBe(403);
    // Another organization sees nothing.
    const other = await org();
    expect((await other.owner.get(`/accounting/revaluations/${run.id}`)).status).toBe(404);
    expect((await other.owner.get('/accounting/revaluations')).body.data).toHaveLength(0);
    expect(
      (
        await other.owner.post(`/accounting/revaluations/${run.id}/cancel`, {
          version: run.version,
          reason: 'Not mine',
        })
      ).status,
    ).toBe(404);
  });
});
