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
 * Phase 3B steps 12–13: credit notes (Decisions 38, 41; D7; §M) and invoice void (D8, R35, E2).
 * The AR subledger — open invoices less customer credit — equals the AR control account.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface SalesOrg extends AccountingOrg {
  customerId: string;
  gst: string;
}

async function salesOrg(currencyCode = 'MVR'): Promise<SalesOrg> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const gst = codes.find((c) => c.code === 'GST')!.id;
  const settings = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: gst,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Atoll Hotels' },
    currencyCode,
  });
  expect(customer.status, JSON.stringify(customer.body)).toBe(201);
  return { ...org, customerId: customer.body.data.id, gst };
}

async function invoice(o: SalesOrg, lines: object[], invoiceDate = '2026-03-10') {
  const created = await o.owner.post('/sales/invoices', {
    customerId: o.customerId,
    invoiceDate,
    lines,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const issued = await o.owner.post(`/sales/invoices/${created.body.data.id}/issue`, {
    version: created.body.data.version,
  });
  expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  return issued.body.data;
}

const twoLines = [
  { description: 'Room nights', quantity: '1', unitPrice: '250' },
  { description: 'Transfers', quantity: '1', unitPrice: '250' },
];

async function draftCredit(client: TestClient, body: object) {
  const res = await client.post('/sales/credit-notes', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

async function issueCredit(client: TestClient, note: { id: string; version: number }) {
  return client.post(`/sales/credit-notes/${note.id}/issue`, { version: note.version });
}

async function withOwnerDb<T>(work: (db: Awaited<ReturnType<typeof connectAs>>) => Promise<T>) {
  const db = await connectAs('owner');
  try {
    return await work(db);
  } finally {
    await db.end();
  }
}

async function balance(organizationId: string, accountId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2)::text AS b
         FROM accounting_journal_lines l
         JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
      [organizationId, accountId],
    );
    return rows[0].b as string;
  });
}

async function subledger(organizationId: string) {
  return withOwnerDb(async (db) => {
    const { rows } = await db.query(
      `SELECT ((SELECT coalesce(sum(base_due), 0) FROM sales_invoices WHERE organization_id = $1 AND status = 'ISSUED')
             - (SELECT coalesce(sum(base_unallocated), 0) FROM sales_receipts WHERE organization_id = $1 AND status = 'RECORDED')
             - (SELECT coalesce(sum(base_unapplied), 0) FROM sales_credit_notes WHERE organization_id = $1 AND status = 'ISSUED')
             )::numeric(28,2)::text AS b`,
      [organizationId],
    );
    return rows[0].b as string;
  });
}

async function expectReconciled(o: SalesOrg) {
  expect(await balance(o.organizationId, o.accounts['1130']!)).toBe(
    await subledger(o.organizationId),
  );
}

// ---------------------------------------------------------------------------

describe('credit notes (Decision 41, §M)', () => {
  it('reverses revenue and tax, and applies a linked credit to its invoice', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, twoLines); // 540
    const note = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      invoiceId: inv.id,
      memo: 'Transfer not used',
      lines: [{ description: 'Transfers', quantity: '1', unitPrice: '250' }],
    });
    expect(note).toMatchObject({
      status: 'DRAFT',
      total: '270.00',
      invoiceId: inv.id,
      number: null,
    });
    const res = await issueCredit(o.owner, note);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'ISSUED',
      number: 'CN-00001',
      amountUnapplied: '0.00',
      baseTotal: '270.0000',
    });
    const journal = (await o.owner.get(`/accounting/journals/${res.body.data.journalId}`)).body
      .data;
    expect(journal).toMatchObject({
      source: 'event',
      sourceModule: 'sales',
      sourceType: 'credit_note',
    });
    const debit = (id: string) =>
      journal.lines
        .filter((l: { accountId: string }) => l.accountId === id)
        .map((l: { debit: string }) => l.debit);
    expect(debit(o.accounts['4100']!)).toEqual(['250.0000']);
    expect(debit(o.accounts['2130']!)).toEqual(['20.0000']);
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.amountDue).toBe('270.00');
    expect(await balance(o.organizationId, o.accounts['2130']!)).toBe('-20.00');
    await expectReconciled(o);
  });

  it('keeps a standalone credit as customer credit and applies it later', async () => {
    const o = await salesOrg();
    const note = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-05',
      taxTreatment: 'no_tax',
      lines: [{ description: 'Goodwill', quantity: '1', unitPrice: '100' }],
    });
    const issued = (await issueCredit(o.owner, note)).body.data;
    expect(issued).toMatchObject({ amountUnapplied: '100.00', invoiceId: null });
    await expectReconciled(o);
    const inv = await invoice(o, [{ description: 'Stay', quantity: '1', unitPrice: '500' }]);
    const applied = await o.owner.post('/sales/customer-credit/apply', {
      sourceType: 'credit_note',
      sourceId: note.id,
      date: '2026-03-12',
      allocations: [{ invoiceId: inv.id, amount: '100' }],
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.data).toMatchObject({ sourceType: 'credit_note', amountRemaining: '0.00' });
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.amountDue).toBe('440.00');
    expect((await o.owner.get(`/sales/credit-notes/${note.id}`)).body.data.amountUnapplied).toBe(
      '0.00',
    );
    await expectReconciled(o);
  });

  it('applies only up to the open balance and never credits beyond the invoice total', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, twoLines); // 540
    const receipt = await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-03-12',
      amount: '400',
      allocations: [{ invoiceId: inv.id, amount: '400' }],
    });
    expect(receipt.status).toBe(201);
    const first = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      invoiceId: inv.id,
      lines: [{ description: 'Room nights', quantity: '1', unitPrice: '250' }],
    });
    const issued = (await issueCredit(o.owner, first)).body.data;
    expect(issued.amountUnapplied).toBe('130.00'); // 270 credit, 140 open
    expect((await o.owner.get(`/sales/invoices/${inv.id}`)).body.data.amountDue).toBe('0.00');
    const tooMuch = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-16',
      invoiceId: inv.id,
      lines: [{ description: 'Everything', quantity: '1', unitPrice: '251' }],
    });
    const refused = await issueCredit(o.owner, tooMuch);
    expect(refused.status).toBe(400);
    await expectReconciled(o);
  });

  it('posts a linked foreign credit at its invoice rate', async () => {
    const o = await salesOrg('USD');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const inv = await invoice(o, [
      { description: 'Charter', quantity: '1', unitPrice: '1000', taxCodeId: null },
    ]);
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-12',
      rate: '15.60',
    });
    const note = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      invoiceId: inv.id,
      lines: [{ description: 'Charter', quantity: '1', unitPrice: '1000', taxCodeId: null }],
    });
    const issued = (await issueCredit(o.owner, note)).body.data;
    expect(issued).toMatchObject({
      exchangeRate: '15.4200000000',
      exchangeRateSource: 'invoice',
      baseTotal: '15420.0000',
      amountUnapplied: '0.00',
    });
    expect(await balance(o.organizationId, o.accounts['1130']!)).toBe('0.00');
    await expectReconciled(o);
    const mismatch = await o.owner.post('/sales/credit-notes', {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      invoiceId: inv.id,
      currencyCode: 'MVR',
      lines: [{ description: 'x', quantity: '1', unitPrice: '1' }],
    });
    expect(mismatch.status).toBe(400);
  });

  it('validates the linked invoice', async () => {
    const o = await salesOrg();
    const other = await o.owner.post('/customers', {
      party: { kind: 'organization', displayName: 'Other' },
    });
    const inv = await invoice(o, twoLines);
    const draftInvoice = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      lines: twoLines,
    });
    for (const [body, path] of [
      [{ customerId: other.body.data.id, invoiceId: inv.id }, 'invoiceId'],
      [{ invoiceId: draftInvoice.body.data.id }, 'invoiceId'],
      [{ invoiceId: inv.id, creditDate: '2026-03-01' }, 'invoiceId'],
    ] as const) {
      const res = await o.owner.post('/sales/credit-notes', {
        customerId: o.customerId,
        creditDate: '2026-03-15',
        lines: [{ description: 'x', quantity: '1', unitPrice: '1' }],
        ...body,
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.issues[0].path).toBe(path);
    }
  });

  it('uses credit_notes.create for drafts and credit_notes.issue with re-authentication to issue', async () => {
    const o = await salesOrg();
    const role = await o.owner.post('/organizations/current/roles', {
      name: 'Credit clerk',
      permissionKeys: ['credit_notes.view', 'credit_notes.create', 'customers.view'],
    });
    expect(role.status).toBe(201);
    const clerk = await joinWithRole(ctx, o.owner, 'Credit clerk');
    const body = {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      lines: [{ description: 'Refund', quantity: '1', unitPrice: '50' }],
    };
    const note = await draftCredit(clerk.client, body);
    const edited = await clerk.client.put(`/sales/credit-notes/${note.id}`, {
      ...body,
      version: 1,
      memo: 'Edited',
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await issueCredit(clerk.client, edited.body.data)).status).toBe(403);
    const disposable = await draftCredit(clerk.client, body);
    expect(
      (await clerk.client.delete(`/sales/credit-notes/${disposable.id}?version=1`)).status,
    ).toBe(200);

    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await issueCredit(o.owner, edited.body.data);
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.owner.reauthenticate();
    const issued = await issueCredit(o.owner, edited.body.data);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    // Issued credit notes are immutable (Decision 41).
    expect(
      (
        await clerk.client.put(`/sales/credit-notes/${note.id}`, {
          ...body,
          version: issued.body.data.version,
        })
      ).body.error.code,
    ).toBe('INVALID_STATE_TRANSITION');
    const app = await connectAs('app');
    try {
      for (const statement of [
        `UPDATE sales_credit_notes SET total = 1 WHERE id = '${note.id}'`,
        `DELETE FROM sales_credit_notes WHERE id = '${note.id}'`,
        `UPDATE sales_credit_note_lines SET unit_price = 1 WHERE credit_note_id = '${note.id}'`,
      ]) {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [o.organizationId]);
          await expect(app.query(statement), statement).rejects.toMatchObject({ code: '23514' });
        } finally {
          await app.query('ROLLBACK');
        }
      }
    } finally {
      await app.end();
    }
  });

  it('can require approval before issue', async () => {
    const o = await salesOrg();
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const policy = await o.owner.put('/approvals/policies/sales.credit_note.issue', {
      steps: [
        {
          name: 'Controller',
          requiredApprovals: 1,
          roleIds: [roles.find((r) => r.name === 'Administrator')!.id],
          membershipIds: [],
          conditions: { minBaseAmount: '100' },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = await joinWithRole(ctx, o.owner, 'Administrator');
    const note = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      lines: [{ description: 'Refund', quantity: '1', unitPrice: '200' }],
    });
    expect((await issueCredit(o.owner, note)).body.error.code).toBe('APPROVAL_REQUIRED');
    const pending = (
      await o.owner.post(`/sales/credit-notes/${note.id}/submit`, { version: note.version })
    ).body.data;
    expect(pending.status).toBe('PENDING_APPROVAL');
    const approved = await admin.client.post(
      `/approvals/requests/${pending.approval.requestId}/approve`,
      {},
    );
    expect(approved.body.data.requestStatus).toBe('approved');
    const issued = await issueCredit(o.owner, pending);
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
  });
});

describe('invoice void (D8, E2)', () => {
  it('voids an unpaid invoice by reversing its journal through Sales', async () => {
    const o = await salesOrg();
    const inv = await invoice(o, twoLines);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post(`/sales/invoices/${inv.id}/void`, {
          version: inv.version,
          reason: 'Wrong',
        })
      ).status,
    ).toBe(403);
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/sales/invoices/${inv.id}/void`, {
      version: inv.version,
      reason: 'Wrong customer',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    await o.owner.reauthenticate();
    const voided = await o.owner.post(`/sales/invoices/${inv.id}/void`, {
      version: inv.version,
      reason: 'Wrong customer',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({
      status: 'VOID',
      amountDue: '0.00',
      voidReason: 'Wrong customer',
    });
    expect((await o.owner.get(`/accounting/journals/${inv.journalId}`)).body.data.status).toBe(
      'REVERSED',
    );
    expect(await balance(o.organizationId, o.accounts['1130']!)).toBe('0.00');
    expect(await balance(o.organizationId, o.accounts['4100']!)).toBe('0.00');
    await expectReconciled(o);
    const reversal = await o.owner.post(
      `/accounting/journals/${voided.body.data.voidJournalId}/reverse`,
      {
        reason: 'Manual attempt',
      },
    );
    expect(reversal.body.error.code).toBe('SYSTEM_JOURNAL');
    const again = await o.owner.post(`/sales/invoices/${inv.id}/void`, {
      version: voided.body.data.version,
      reason: 'Again',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('refuses to void paid or credited invoices and drafts', async () => {
    const o = await salesOrg();
    const paid = await invoice(o, twoLines);
    await o.owner.post('/sales/receipts', {
      customerId: o.customerId,
      receiptDate: '2026-03-12',
      amount: '10',
      allocations: [{ invoiceId: paid.id, amount: '10' }],
    });
    const current = (await o.owner.get(`/sales/invoices/${paid.id}`)).body.data;
    const refused = await o.owner.post(`/sales/invoices/${paid.id}/void`, {
      version: current.version,
      reason: 'x',
    });
    expect(refused.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const credited = await invoice(o, twoLines, '2026-03-11');
    const note = await draftCredit(o.owner, {
      customerId: o.customerId,
      creditDate: '2026-03-15',
      invoiceId: credited.id,
      lines: [{ description: 'Room nights', quantity: '1', unitPrice: '100' }],
    });
    expect((await issueCredit(o.owner, note)).status).toBe(200);
    const creditedNow = (await o.owner.get(`/sales/invoices/${credited.id}`)).body.data;
    const refused2 = await o.owner.post(`/sales/invoices/${credited.id}/void`, {
      version: creditedNow.version,
      reason: 'x',
    });
    expect(refused2.body.error.code).toBe('INVALID_STATE_TRANSITION');

    const draft = await o.owner.post('/sales/invoices', {
      customerId: o.customerId,
      invoiceDate: '2026-03-10',
      lines: twoLines,
    });
    const refused3 = await o.owner.post(`/sales/invoices/${draft.body.data.id}/void`, {
      version: 1,
      reason: 'x',
    });
    expect(refused3.body.error.code).toBe('INVALID_STATE_TRANSITION');
    await expectReconciled(o);
  });
});
