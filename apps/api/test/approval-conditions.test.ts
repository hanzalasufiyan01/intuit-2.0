import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import {
  cashSale,
  joinWithRole,
  line,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3A S10: conditional approvals (Decisions 22, 56, 77; S10-01 to S10-12). Policy validation
 * (strict bodies), server-derived facts, matching-step snapshots, no match = direct action, the
 * posting-time re-check, every registered action (journals of each transaction type, opening
 * balances, period reopening), self-approval, database guards, RLS and a policy/submit race.
 * Runs in the serial project (it drives the job worker for the journal import).
 */

let ctx: TestContext;
const origin = { requestId: 'approval-conditions-test', ipAddress: null, userAgent: 'vitest' };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const JOURNAL_POLICY = '/approvals/policies/accounting.journal.post';

interface Org extends AccountingOrg {
  adminRoleId: string;
  admin1: TestClient;
  admin2: TestClient;
}

async function org(): Promise<Org> {
  const base = await setUpAccountingOrg(ctx);
  const roles = (await base.owner.get('/organizations/current/roles')).body.data as {
    id: string;
    name: string;
  }[];
  const admin1 = await joinWithRole(ctx, base.owner, 'Administrator');
  const admin2 = await joinWithRole(ctx, base.owner, 'Administrator');
  return {
    ...base,
    adminRoleId: roles.find((r) => r.name === 'Administrator')!.id,
    admin1: admin1.client,
    admin2: admin2.client,
  };
}

const step = (name: string, roleIds: string[], conditions?: Record<string, unknown>) => ({
  name,
  requiredApprovals: 1,
  roleIds,
  membershipIds: [],
  ...(conditions ? { conditions } : {}),
});

async function setPolicy(client: TestClient, path: string, steps: unknown[]) {
  const res = await client.put(path, { steps });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function draftJournal(o: Org, amount: string, entryDate = '2026-03-15') {
  const res = await o.owner.post('/accounting/journals', cashSale(o, amount, entryDate));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

const journal = async (client: TestClient, id: string) =>
  (await client.get(`/accounting/journals/${id}`)).body.data;

async function submit(client: TestClient, id: string) {
  const res = await client.post(`/accounting/journals/${id}/submit`, {});
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function requestSnapshot(organizationId: string, requestId: string) {
  const owner = await connectAs('owner');
  try {
    const { rows } = await owner.query(
      `SELECT policy_snapshot FROM approval_requests WHERE organization_id = $1 AND id = $2`,
      [organizationId, requestId],
    );
    return rows[0].policy_snapshot as {
      steps: { order: number; name: string }[];
      facts: Record<string, unknown>;
    };
  } finally {
    await owner.end();
  }
}

describe('policy validation (S10-01, S10-10)', () => {
  it('rejects unknown fields and invalid conditions, and stores valid ones', async () => {
    const o = await org();
    const valid = step('Large', [o.adminRoleId], { minBaseAmount: '10000' });
    for (const body of [
      { steps: [valid], allowUncovered: true },
      { steps: [{ ...valid, priority: 1 }] },
      { steps: [{ ...valid, conditions: { minBaseAmount: '10000', thresholdCurrency: 'MVR' } }] },
      { steps: [step('x', [o.adminRoleId], { minBaseAmount: '-1' })] },
    ]) {
      const res = await o.owner.put(JOURNAL_POLICY, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    for (const conditions of [
      { minBaseAmount: '100', maxBaseAmount: '100' },
      { minBaseAmount: '1.005' },
      { transactionTypes: ['invoice'] },
      { transactionTypes: [] },
    ]) {
      const res = await o.owner.put(JOURNAL_POLICY, {
        steps: [step('x', [o.adminRoleId], conditions)],
      });
      expect(res.status, JSON.stringify(conditions)).toBe(400);
    }
    const reopenAmount = await o.owner.put('/approvals/policies/accounting.period.reopen', {
      steps: [step('x', [o.adminRoleId], { minBaseAmount: '1' })],
    });
    expect(reopenAmount.status).toBe(400);
    expect(JSON.stringify(reopenAmount.body)).toMatch(/no amount/);

    const saved = await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Supervisor', [o.adminRoleId], { minBaseAmount: '10000', maxBaseAmount: '50000.50' }),
      step('Imports', [o.adminRoleId], { transactionTypes: ['imported', 'manual', 'imported'] }),
      step('Always', [o.adminRoleId]),
    ]);
    expect(saved.steps.map((s: any) => s.conditions)).toEqual([
      {
        minBaseAmount: '10000',
        maxBaseAmount: '50000.5',
        transactionTypes: null,
        thresholdCurrency: 'MVR',
      },
      {
        minBaseAmount: null,
        maxBaseAmount: null,
        transactionTypes: ['imported', 'manual'],
        thresholdCurrency: null,
      },
      { minBaseAmount: null, maxBaseAmount: null, transactionTypes: null, thresholdCurrency: null },
    ]);
    const listed = (await o.owner.get('/approvals/policies')).body.data;
    expect(listed.baseCurrency).toBe('MVR');
    expect(listed.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actionKey: 'accounting.journal.post',
          conditions: {
            amount: true,
            transactionTypes: ['manual', 'imported', 'accounting_event'],
          },
        }),
        expect.objectContaining({
          actionKey: 'accounting.opening_balance.post',
          conditions: { amount: true, transactionTypes: ['opening_balance'] },
        }),
        expect.objectContaining({
          actionKey: 'accounting.period.reopen',
          conditions: { amount: false, transactionTypes: ['period_reopen'] },
        }),
      ]),
    );
    const audit = (await o.owner.get('/organizations/current/audit-events?limit=20')).body.data;
    const updated = audit.find((e: any) => e.action === 'approval_policy.updated');
    expect(updated.metadata.after[0].conditions).toMatchObject({ minBaseAmount: '10000' });
  });
});

describe('journal posting (S10-03, S10-06)', () => {
  it('posts below the threshold directly and requires approval from it upwards', async () => {
    const o = await org();
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Supervisor', [o.adminRoleId], { minBaseAmount: '10000' }),
      step('Director', [o.adminRoleId], { minBaseAmount: '50000' }),
    ]);

    const small = await draftJournal(o, '9999.99');
    const smallView = await journal(o.owner, small);
    expect(smallView).toMatchObject({
      approvalRequiredForPosting: false,
      approvalFacts: { transactionType: 'manual', baseAmount: '9999.99', baseCurrency: 'MVR' },
      approvalSteps: [],
    });
    const direct = await o.owner.post(`/accounting/journals/${small}/post`);
    expect(direct.status, JSON.stringify(direct.body)).toBe(200);

    const boundary = await draftJournal(o, '10000.00');
    const boundaryView = await journal(o.owner, boundary);
    expect(boundaryView.approvalRequiredForPosting).toBe(true);
    expect(boundaryView.approvalSteps.map((s: any) => s.order)).toEqual([1]);
    const refused = await o.owner.post(`/accounting/journals/${boundary}/post`);
    expect(refused.body.error.code).toBe('APPROVAL_REQUIRED');

    const submitted = await submit(o.owner, boundary);
    const snapshot = await requestSnapshot(o.organizationId, submitted.approvalRequestId);
    expect(snapshot.steps.map((s) => s.order)).toEqual([1]);
    expect(snapshot.facts).toEqual({
      transactionType: 'manual',
      baseAmount: '10000',
      baseCurrency: 'MVR',
    });
    const queue = (await o.admin1.get('/approvals/requests')).body.data as any[];
    expect(queue.find((r) => r.id === submitted.approvalRequestId)).toMatchObject({
      facts: { transactionType: 'manual', baseAmount: '10000' },
      appliedSteps: [{ order: 1, name: 'Supervisor', conditions: { minBaseAmount: '10000' } }],
      canDecide: true,
    });
    const self = await o.owner.post(
      `/approvals/requests/${submitted.approvalRequestId}/approve`,
      {},
    );
    expect(self.body.error.code).toBe('SELF_APPROVAL_PROHIBITED');
    const approved = await o.admin1.post(
      `/approvals/requests/${submitted.approvalRequestId}/approve`,
      {},
    );
    expect(approved.body.data.requestStatus).toBe('approved');
    expect((await o.owner.post(`/accounting/journals/${boundary}/post`)).status).toBe(200);
  });

  it('snapshots both steps above the upper band and needs distinct approvers', async () => {
    const o = await org();
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Supervisor', [o.adminRoleId], { minBaseAmount: '10000' }),
      step('Director', [o.adminRoleId], { minBaseAmount: '50000' }),
    ]);
    const big = await draftJournal(o, '60000.00');
    const submitted = await submit(o.owner, big);
    const requestId = submitted.approvalRequestId as string;
    expect((await requestSnapshot(o.organizationId, requestId)).steps.map((s) => s.order)).toEqual([
      1, 2,
    ]);
    const first = await o.admin1.post(`/approvals/requests/${requestId}/approve`, {});
    expect(first.body.data.requestStatus).toBe('pending');
    const again = await o.admin1.post(`/approvals/requests/${requestId}/approve`, {});
    expect(again.body.error.code).toBe('ALREADY_DECIDED');
    expect((await o.owner.post(`/accounting/journals/${big}/post`)).body.error.code).toBe(
      'APPROVAL_REQUIRED',
    );
    const second = await o.admin2.post(`/approvals/requests/${requestId}/approve`, {});
    expect(second.body.data.requestStatus).toBe('approved');
    expect((await o.owner.post(`/accounting/journals/${big}/post`)).status).toBe(200);
  });

  it('re-checks at posting time and keeps pending snapshots when the policy changes', async () => {
    const o = await org();
    // Submitted while no policy applied: pending without a request.
    const id = await draftJournal(o, '20000.00');
    expect((await submit(o.owner, id)).approvalRequestId).toBeNull();
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Supervisor', [o.adminRoleId], { minBaseAmount: '10000' }),
    ]);
    const blocked = await o.owner.post(`/accounting/journals/${id}/post`);
    expect(blocked.body.error.code).toBe('APPROVAL_REQUIRED');
    expect(blocked.body.error.message).toMatch(/withdraw it and submit it again/);
    expect((await o.owner.post(`/accounting/journals/${id}/withdraw`, {})).status).toBe(200);
    const resubmitted = await submit(o.owner, id);
    expect(resubmitted.approvalRequestId).not.toBeNull();

    // A later policy edit never changes the pending request's snapshot.
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Supervisor', [o.adminRoleId], { minBaseAmount: '100000' }),
    ]);
    expect(
      (await requestSnapshot(o.organizationId, resubmitted.approvalRequestId)).steps.map(
        (s) => s.name,
      ),
    ).toEqual(['Supervisor']);
    expect((await o.owner.post(`/accounting/journals/${id}/post`)).body.error.code).toBe(
      'APPROVAL_REQUIRED',
    );
    await o.admin1.post(`/approvals/requests/${resubmitted.approvalRequestId}/approve`, {});
    expect((await o.owner.post(`/accounting/journals/${id}/post`)).status).toBe(200);

    // No policy at all: direct action, as before S10.
    const other = await org();
    const plain = await draftJournal(other, '1000000.00');
    expect((await journal(other.owner, plain)).approvalRequiredForPosting).toBe(false);
    expect((await other.owner.post(`/accounting/journals/${plain}/post`)).status).toBe(200);
  });

  it('applies transaction-type conditions to imported journals only', async () => {
    const o = await org();
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Import review', [o.adminRoleId], { transactionTypes: ['imported'] }),
    ]);
    const manual = await draftJournal(o, '500.00');
    expect((await journal(o.owner, manual)).approvalFacts.transactionType).toBe('manual');
    expect((await o.owner.post(`/accounting/journals/${manual}/post`)).status).toBe(200);

    const created = await o.owner.post('/imports', { domain: 'manual_journals', options: {} });
    const importId = created.body.data.id as string;
    const file = Buffer.from(
      'journal_key,date,description,reference,account_code,debit,credit\r\n' +
        'JE-1,2026-03-10,Imported float,REF-1,1110,300.00,\r\n' +
        'JE-1,,,,4100,,300.00\r\n',
    );
    expect(
      (await o.owner.upload(`/files?linkType=import_batch&linkId=${importId}`, file, 'j.csv'))
        .status,
    ).toBe(201);
    const inspected = await o.owner.post(`/imports/${importId}/inspect`, {});
    await o.owner.put(`/imports/${importId}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        const res = await o.owner.get(`/imports/${importId}`);
        if (!['validating', 'committing'].includes(res.body.data.status)) return res.body.data;
        await ctx.worker.runOnce();
      }
      throw new Error('import did not settle');
    };
    const validated = await settle();
    await o.owner.post(`/imports/${importId}/commit`, { version: validated.version });
    expect((await settle()).status).toBe('committed');
    const rows = (await o.owner.get(`/imports/${importId}/rows?limit=10`)).body.data.rows as any[];
    const importedId = rows.find((r) => r.recordId).recordId as string;

    const imported = await journal(o.owner, importedId);
    expect(imported).toMatchObject({
      approvalRequiredForPosting: true,
      approvalFacts: { transactionType: 'imported', baseAmount: '300' },
    });
    expect((await o.owner.post(`/accounting/journals/${importedId}/post`)).body.error.code).toBe(
      'APPROVAL_REQUIRED',
    );
    const submitted = await submit(o.owner, importedId);
    expect(
      (await requestSnapshot(o.organizationId, submitted.approvalRequestId)).facts.transactionType,
    ).toBe('imported');
  });

  it('holds accounting-event journals as drafts only when a step applies', async () => {
    const o = await org();
    await setPolicy(o.owner, JOURNAL_POLICY, [
      step('Events', [o.adminRoleId], {
        transactionTypes: ['accounting_event'],
        minBaseAmount: '20',
      }),
    ]);
    const eventType = `test_s10_${randomInt(1e9)}.issued`;
    ctx.services.journals.registerEventHandler(eventType, ({ payload }) => ({
      entryDate: '2026-05-10',
      description: `Event ${String(payload.id)}`,
      reference: '',
      currency: 'MVR',
      exchangeRate: null,
      sourceRef: { module: 'test-sales', type: 'invoice', id: String(payload.id) },
      lines: [
        line(o.accounts['1110']!, 'debit', String(payload.amount)),
        line(o.accounts['4100']!, 'credit', String(payload.amount)),
      ],
    }));
    const receive = (amount: string) =>
      inTransaction(ctx.database.db, { organizationId: o.organizationId }, async (tx) => {
        await setDbContext(tx, { organizationId: o.organizationId });
        const id = randomUUID();
        return ctx.services.journals.receiveEventInTransaction(tx, {
          organizationId: o.organizationId,
          sourceModule: 'test-sales',
          eventType,
          eventKey: id,
          payload: { id, amount },
          occurredAt: new Date(),
          origin,
        });
      });
    const held = await receive('25.00');
    const heldView = await journal(o.owner, held.journalId!);
    expect(heldView).toMatchObject({
      status: 'DRAFT',
      approvalRequiredForPosting: true,
      approvalFacts: { transactionType: 'accounting_event', baseAmount: '25' },
    });
    const posted = await receive('10.00');
    expect((await journal(o.owner, posted.journalId!)).status).toBe('POSTED');
  });
});

describe('opening balances and period reopening (S10-03)', () => {
  async function openingOrg() {
    const o = await org();
    const usd = await o.owner.post('/accounting/accounts', {
      code: '1125',
      name: 'Bank USD',
      type: 'ASSET',
      parentId: o.accounts['1100'],
      currencyCode: 'USD',
      subtype: 'BANK',
    });
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-04-01' });
    const batch = (await o.owner.post('/accounting/opening-balances', {})).body.data;
    const saved = await o.owner.put(`/accounting/opening-balances/${batch.id}/lines`, {
      version: batch.version,
      lines: [
        { accountId: o.accounts['1110'], debit: '25000.00', credit: null },
        { accountId: o.accounts['2510'], debit: null, credit: '10000.00' },
        { accountId: usd.body.data.id, debit: '1000.00', credit: null },
      ],
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return { o, batchId: batch.id as string };
  }
  const OPENING_POLICY = '/approvals/policies/accounting.opening_balance.post';

  it('uses the canonical S8 amount, equal to what posting records', async () => {
    const { o, batchId } = await openingOrg();
    await setPolicy(o.owner, OPENING_POLICY, [
      step('Large conversions', [o.adminRoleId], { minBaseAmount: '40000' }),
    ]);
    const detail = (await o.owner.get(`/accounting/opening-balances/${batchId}`)).body.data;
    // MVR 25,000 (the OBE credit balances 10,000 of credits; not added) + USD 1,000 x 15.42.
    expect(detail.approval).toMatchObject({
      required: true,
      readyToPost: false,
      facts: { transactionType: 'opening_balance', baseAmount: '40420', baseCurrency: 'MVR' },
      appliedSteps: [{ order: 1, name: 'Large conversions' }],
    });
    const direct = await o.owner.post(`/accounting/opening-balances/${batchId}/post`, {
      version: detail.version,
    });
    expect(direct.body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = await o.owner.post(`/accounting/opening-balances/${batchId}/submit`, {
      version: detail.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const requestId = submitted.body.data.approval.requestId as string;
    expect((await requestSnapshot(o.organizationId, requestId)).facts.baseAmount).toBe('40420');
    await o.admin1.post(`/approvals/requests/${requestId}/approve`, {});
    const posted = await o.owner.post(`/accounting/opening-balances/${batchId}/post`, {
      version: submitted.body.data.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    const totals = await Promise.all(
      (posted.body.data.journals as { id: string }[]).map(
        async (j) => (await journal(o.owner, j.id)).totalBaseDebit as string,
      ),
    );
    expect(totals.reduce((sum, t) => sum + Number(t), 0)).toBe(40420);
  });

  it('proceeds directly when no step applies to the batch', async () => {
    const { o, batchId } = await openingOrg();
    await setPolicy(o.owner, OPENING_POLICY, [
      step('Very large', [o.adminRoleId], { minBaseAmount: '40420.01' }),
    ]);
    const detail = (await o.owner.get(`/accounting/opening-balances/${batchId}`)).body.data;
    expect(detail.approval).toMatchObject({ required: false, readyToPost: true, appliedSteps: [] });
    const submitNone = await o.owner.post(`/accounting/opening-balances/${batchId}/submit`, {
      version: detail.version,
    });
    expect(submitNone.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const posted = await o.owner.post(`/accounting/opening-balances/${batchId}/post`, {
      version: detail.version,
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  });

  it('matches period reopening by transaction type only', async () => {
    const o = await org();
    await setPolicy(o.owner, '/approvals/policies/accounting.period.reopen', [
      step('Controller', [o.adminRoleId], { transactionTypes: ['period_reopen'] }),
    ]);
    const period = o.periods[0]!.id;
    expect((await o.owner.post(`/accounting/periods/${period}/close`)).status).toBe(200);
    const reopen = await o.owner.post(`/accounting/periods/${period}/reopen`, {
      reason: 'Late invoice',
    });
    expect(reopen.status, JSON.stringify(reopen.body)).toBe(202);
    const snapshot = await requestSnapshot(o.organizationId, reopen.body.data.approvalRequestId);
    expect(snapshot.facts).toEqual({
      transactionType: 'period_reopen',
      baseAmount: null,
      baseCurrency: 'MVR',
    });
    expect(snapshot.steps.map((s) => s.name)).toEqual(['Controller']);
  });
});

describe('database guards, RLS and concurrency (S10-08, S10-09)', () => {
  it('keeps requests immutable apart from their resolution, and checks step conditions', async () => {
    const o = await org();
    await setPolicy(o.owner, JOURNAL_POLICY, [step('Any', [o.adminRoleId])]);
    const id = await draftJournal(o, '100.00');
    const requestId = (await submit(o.owner, id)).approvalRequestId as string;
    const other = await org();
    const app = await connectAs('app');
    try {
      const inTenant = async (organizationId: string, statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      for (const statement of [
        `UPDATE approval_requests SET policy_snapshot = '{"steps":[]}' WHERE id = '${requestId}'`,
        `UPDATE approval_requests SET excluded_user_ids = '{}' WHERE id = '${requestId}'`,
        `UPDATE approval_requests SET reason = 'changed' WHERE id = '${requestId}'`,
      ]) {
        await expect(inTenant(o.organizationId, statement), statement).rejects.toMatchObject({
          code: '23514',
        });
      }
      for (const statement of [
        `UPDATE approval_policy_steps SET min_base_amount = 10 WHERE organization_id = '${o.organizationId}'`,
        `UPDATE approval_policy_steps SET min_base_amount = 10, max_base_amount = 5, threshold_currency = 'MVR' WHERE organization_id = '${o.organizationId}'`,
        `UPDATE approval_policy_steps SET transaction_types = '{"Bad Type"}' WHERE organization_id = '${o.organizationId}'`,
      ]) {
        await expect(inTenant(o.organizationId, statement), statement).rejects.toMatchObject({
          code: '23514',
        });
      }
      await expect(
        inTenant(o.organizationId, `DELETE FROM approval_requests WHERE id = '${requestId}'`),
      ).rejects.toMatchObject({ code: '42501' });
      // A resolved request cannot move again.
      await o.admin1.post(`/approvals/requests/${requestId}/approve`, {});
      await expect(
        inTenant(
          o.organizationId,
          `UPDATE approval_requests SET status = 'rejected' WHERE id = '${requestId}'`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const hidden = await inTenant(
        other.organizationId,
        `SELECT count(*)::int AS n FROM approval_requests WHERE id = '${requestId}'`,
      );
      expect(hidden.rows[0].n).toBe(0);
    } finally {
      await app.end();
    }
    expect((await other.owner.post(`/approvals/requests/${requestId}/approve`, {})).status).toBe(
      404,
    );
  });

  it('never snapshots a half-replaced policy when an edit races a submit', async () => {
    const o = await org();
    const oneStep = [step('A1', [o.adminRoleId], { minBaseAmount: '10000' })];
    const twoSteps = [
      step('B1', [o.adminRoleId], { minBaseAmount: '10000' }),
      step('B2', [o.adminRoleId], { minBaseAmount: '10000' }),
    ];
    await setPolicy(o.owner, JOURNAL_POLICY, oneStep);
    const editor = o.admin1;
    for (let round = 0; round < 4; round++) {
      const id = await draftJournal(o, '20000.00');
      const [submitted] = await Promise.all([
        o.owner.post(`/accounting/journals/${id}/submit`, {}),
        editor.put(JOURNAL_POLICY, { steps: round % 2 === 0 ? twoSteps : oneStep }),
      ]);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const names = (
        await requestSnapshot(o.organizationId, submitted.body.data.approvalRequestId)
      ).steps.map((s) => s.name);
      expect([['A1'], ['B1', 'B2']]).toContainEqual(names);
    }
  });
});
