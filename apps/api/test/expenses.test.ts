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
 * Phase 4B-9: direct expenses, "spend money" (ADR 0004 P4-37, P4-39, P4-42, P4-44, P4-50, P4-51).
 * Dr expense and input tax / Cr bank, cash or card, posted through the `purchases.expense_posted`
 * accounting event; never the AP control account. Drafts, conditional approval separate from post,
 * payment-account and currency rules, the journal, voids through the Purchases reversal,
 * evidence, immutability and security.
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

interface ExpenseOrg extends AccountingOrg {
  gst: string;
  vendorId: string;
}

async function expenseOrg(options: { vendor?: Record<string, unknown> } = {}): Promise<ExpenseOrg> {
  const org = await setUpAccountingOrg(ctx);
  const codes = (await org.owner.get('/tax/codes')).body.data as { id: string; code: string }[];
  const profile = await org.owner.put('/organizations/current/profile', {
    version:
      (await org.owner.get('/organizations/current/profile')).body.data.profile?.version ?? 0,
    legalName: 'Atoll Trading Pvt Ltd',
    gstRegistered: true,
    gstRegisteredFrom: '2026-01-01',
    gstRegistrationNumber: '1000234GST501',
  });
  expect(profile.status, JSON.stringify(profile.body)).toBe(200);
  const settings = await org.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: org.accounts['2110'],
    defaultExpenseAccountId: org.accounts['5400'],
    defaultPaymentAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(settings.status, JSON.stringify(settings.body)).toBe(200);
  const vendor = await org.owner.post('/vendors', {
    party: { kind: 'organization', displayName: 'Island Supplies' },
    ...options.vendor,
  });
  expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
  return { ...org, gst: codes.find((c) => c.code === 'GST')!.id, vendorId: vendor.body.data.id };
}

const draft = (o: ExpenseOrg, overrides: Record<string, unknown> = {}) => ({
  vendorId: o.vendorId,
  expenseDate: '2026-03-10',
  lines: [{ description: 'Taxi fare', quantity: '2', unitPrice: '50', taxCodeId: null }],
  ...overrides,
});

async function createExpense(client: TestClient, body: object, headers = {}) {
  const res = await client.post('/purchases/expenses', body, headers);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

function post(client: TestClient, expense: { id: string; version: number }, headers = {}) {
  return client.post(
    `/purchases/expenses/${expense.id}/post`,
    { version: expense.version },
    headers,
  );
}

async function posted(client: TestClient, body: object) {
  const expense = await createExpense(client, body);
  const res = await post(client, expense);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    currency: string;
    exchangeRate: string | null;
    exchangeRateSource: string | null;
    sourceDocument: { documentType: string; number: string; path: string } | null;
    lines: {
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
      dimensions: { dimensionValueId: string }[];
    }[];
  };
}

/** The GL balance (base, debit − credit) of an account from posted journals. */
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

async function auditActions(o: AccountingOrg, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = 'purchases_expense' AND resource_id = $2
      ORDER BY occurred_at, id`,
    [o.organizationId, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

async function createRole(client: TestClient, name: string, permissionKeys: string[]) {
  const res = await client.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

async function usdBank(o: AccountingOrg, code = '1128') {
  const res = await o.owner.post('/accounting/accounts', {
    code,
    name: 'USD bank',
    type: 'ASSET',
    subtype: 'BANK',
    currencyCode: 'USD',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

describe('expense drafts', () => {
  it('creates a draft with defaults, computes totals on the server and takes no number', async () => {
    const o = await expenseOrg();
    const expense = await createExpense(
      o.owner,
      draft(o, {
        vendorReference: '  RCPT 55  ',
        discount: { type: 'percent', value: '10' },
        lines: [
          { description: 'Paper', quantity: '2', unitPrice: '50', taxCodeId: o.gst },
          { description: 'Toner', quantity: '1', unitPrice: '100', taxCodeId: null },
        ],
      }),
    );
    expect(expense).toMatchObject({
      status: 'DRAFT',
      number: null,
      vendorName: 'Island Supplies',
      vendorReference: 'RCPT 55',
      currencyCode: 'MVR',
      paymentAccountId: null,
      defaultPaymentAccountId: o.accounts['1120'],
      subtotal: '200.00',
      discountTotal: '20.00',
      taxTotal: '7.20',
      recoverableTaxTotal: '7.20',
      total: '187.20',
      version: 1,
    });
    expect(expense.lines[0]).toMatchObject({
      accountId: o.accounts['5400'],
      netAmount: '90.00',
      taxRecoverable: true,
    });
    expect(await auditActions(o, expense.id)).toEqual(['expense.created']);
    const { rows } = await owner.query(
      `SELECT next_number FROM purchases_number_sequences
        WHERE organization_id = $1 AND document_type = 'expense'`,
      [o.organizationId],
    );
    expect(Number(rows[0].next_number)).toBe(1);
  });

  it('edits and deletes a draft under optimistic concurrency, and rejects bad input', async () => {
    const o = await expenseOrg();
    const expense = await createExpense(o.owner, draft(o));
    const edited = await o.owner.put(`/purchases/expenses/${expense.id}`, {
      ...draft(o, { lines: [{ description: 'Lunch', quantity: '1', unitPrice: '80' }] }),
      version: expense.version,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({ total: '80.00', version: 2 });
    const stale = await o.owner.put(`/purchases/expenses/${expense.id}`, {
      ...draft(o),
      version: expense.version,
    });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(
      (await o.owner.delete(`/purchases/expenses/${expense.id}?version=${expense.version}`)).status,
    ).toBe(409);
    expect((await o.owner.delete(`/purchases/expenses/${expense.id}?version=2`)).status).toBe(200);
    expect((await o.owner.get(`/purchases/expenses/${expense.id}`)).status).toBe(404);
    // Strict schemas: unknown fields, no lines, and a bad date are refused.
    expect((await o.owner.post('/purchases/expenses', { ...draft(o), surprise: 1 })).status).toBe(
      400,
    );
    expect((await o.owner.post('/purchases/expenses', draft(o, { lines: [] }))).status).toBe(400);
    expect(
      (await o.owner.post('/purchases/expenses', draft(o, { expenseDate: '2026-13-40' }))).status,
    ).toBe(400);
    // A vendor of another organization is not found.
    const other = await expenseOrg();
    const foreign = await o.owner.post(
      '/purchases/expenses',
      draft(o, { vendorId: other.vendorId }),
    );
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.issues[0]).toEqual({
      path: 'vendorId',
      message: 'Vendor not found.',
    });
  });
});

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

describe('posting an expense', () => {
  it('posts Dr expense / Cr the payment account through the accounting event, without touching AP', async () => {
    const o = await expenseOrg();
    const expense = await posted(o.owner, draft(o));
    expect(expense).toMatchObject({
      status: 'POSTED',
      number: 'EXP-00001',
      total: '100.00',
      baseTotal: '100.0000',
      exchangeRateSource: 'base',
      paymentAccountId: o.accounts['1120'],
    });
    expect(expense.postedAt).not.toBeNull();
    const journal = await journalOf(o, expense.journalId);
    expect(journal.status).toBe('POSTED');
    const debits = journal.lines.filter((l) => l.debit !== null);
    const credits = journal.lines.filter((l) => l.credit !== null);
    expect(debits).toEqual([
      expect.objectContaining({ accountId: o.accounts['5400'], debit: '100.0000' }),
    ]);
    expect(credits).toEqual([
      expect.objectContaining({ accountId: o.accounts['1120'], credit: '100.0000' }),
    ]);
    expect(journal.sourceDocument).toMatchObject({
      documentType: 'expense',
      number: 'EXP-00001',
      path: `/purchases/expenses/${expense.id}`,
    });
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('100.00');
    expect(await glBalance(o.organizationId, o.accounts['1120']!)).toBe('-100.00');
    // An expense is not a payable: the AP control account and the AP subledger are untouched.
    expect(await glBalance(o.organizationId, o.accounts['2110']!)).toBe('0.00');
    expect((await auditActions(o, expense.id)).sort()).toEqual([
      'expense.created',
      'expense.posted',
    ]);
    // A posted expense cannot be posted again, edited or deleted.
    expect((await post(o.owner, expense)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    const edit = await o.owner.put(`/purchases/expenses/${expense.id}`, {
      ...draft(o),
      version: expense.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(
      (await o.owner.delete(`/purchases/expenses/${expense.id}?version=${expense.version}`)).status,
    ).toBe(409);
  });

  it('posts recoverable input tax to the code input account and capitalizes the rest', async () => {
    const o = await expenseOrg({ vendor: { defaultTaxRecoverable: false } });
    const expense = await posted(
      o.owner,
      draft(o, {
        lines: [
          {
            description: 'Stationery',
            quantity: '1',
            unitPrice: '100',
            taxCodeId: o.gst,
            taxRecoverable: true,
          },
          { description: 'Fuel', quantity: '1', unitPrice: '50', taxCodeId: o.gst },
        ],
      }),
    );
    expect(expense).toMatchObject({ total: '162.00', recoverableTaxTotal: '8.00' });
    const journal = await journalOf(o, expense.journalId);
    const byAccount = (id: string) => journal.lines.filter((l) => l.accountId === id);
    // Expense account: 100.00 + (50.00 + 4.00 non-recoverable tax); input tax 8.00; paid 162.00.
    expect(byAccount(o.accounts['5400']!).map((l) => l.debit)).toEqual(['154.0000']);
    expect(byAccount(o.accounts['1160']!).map((l) => l.debit)).toEqual(['8.0000']);
    expect(byAccount(o.accounts['1120']!).map((l) => l.credit)).toEqual(['162.0000']);
    const lines = (await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data.lines;
    expect(lines[0].inputTaxAccountId).toBe(o.accounts['1160']);
  });

  it('uses the chosen payment account, else the default, and applies the account rules', async () => {
    const o = await expenseOrg();
    const cash = await posted(o.owner, draft(o, { paymentAccountId: o.accounts['1110'] }));
    expect(cash.paymentAccountId).toBe(o.accounts['1110']);
    expect(await glBalance(o.organizationId, o.accounts['1110']!)).toBe('-100.00');
    for (const [accountId, message] of [
      [o.accounts['1130'], 'Choose a bank, cash or credit card account (Decision 42, P4-26).'],
      [o.accounts['4100'], 'Choose a bank, cash or credit card account (Decision 42, P4-26).'],
      [o.accounts['2110'], 'A control account cannot be used here.'],
    ] as const) {
      const refused = await o.owner.post(
        '/purchases/expenses',
        draft(o, { paymentAccountId: accountId }),
      );
      expect(refused.status, String(accountId)).toBe(400);
      expect(refused.body.error.details.issues[0]).toEqual({
        path: 'paymentAccountId',
        message,
      });
    }
    // An MVR expense cannot be paid from a USD account.
    const usd = await usdBank(o);
    const mismatch = await o.owner.post('/purchases/expenses', draft(o, { paymentAccountId: usd }));
    expect(mismatch.body.error.details.issues[0].message).toBe(
      'The payment account must be in MVR.',
    );
  });

  it('needs a payment account and a total above zero, and uses the Purchases default when unset', async () => {
    const o = await expenseOrg();
    const none = await expenseOrg();
    await owner.query(
      `UPDATE purchases_settings SET default_payment_account_id = NULL WHERE organization_id = $1`,
      [none.organizationId],
    );
    const noAccount = await createExpense(none.owner, draft(none));
    const refused = await post(none.owner, noAccount);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details.issues[0].path).toBe('paymentAccountId');
    const zero = await createExpense(
      o.owner,
      draft(o, { lines: [{ description: 'Freebie', quantity: '1', unitPrice: '0' }] }),
    );
    const zeroRefused = await post(o.owner, zero);
    expect(zeroRefused.body.error.details.issues[0].path).toBe('lines');
  });

  it('is idempotent: a retry with the same key returns the first result, and a number is not wasted', async () => {
    const o = await expenseOrg();
    const key = { 'Idempotency-Key': randomUUID() };
    const first = await o.owner.post('/purchases/expenses', draft(o), key);
    const replay = await o.owner.post('/purchases/expenses', draft(o), key);
    expect(replay.body.data.id).toBe(first.body.data.id);
    const postKey = { 'Idempotency-Key': randomUUID() };
    const one = await post(o.owner, first.body.data, postKey);
    const two = await post(o.owner, first.body.data, postKey);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.data.number).toBe('EXP-00001');
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_events
        WHERE organization_id = $1 AND event_type = 'purchases.expense_posted'`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(1);
    const next = await posted(o.owner, draft(o));
    expect(next.number).toBe('EXP-00002');
  });

  it('refuses a closed period and posts nothing', async () => {
    const o = await expenseOrg();
    const period = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    const expense = await createExpense(o.owner, draft(o));
    const res = await post(o.owner, expense);
    expect(res.body.error.code).toBe('PERIOD_CLOSED');
    expect((await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data).toMatchObject({
      status: 'DRAFT',
      number: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Foreign currency
// ---------------------------------------------------------------------------

describe('foreign-currency expenses', () => {
  it('needs a rate, converts at the table rate and posts to a base or a same-currency account', async () => {
    const o = await expenseOrg({ vendor: { currencyCode: 'USD' } });
    const expense = await createExpense(
      o.owner,
      draft(o, { lines: [{ description: 'Conference', quantity: '1', unitPrice: '200' }] }),
    );
    expect(expense.currencyCode).toBe('USD');
    const missing = await post(o.owner, expense);
    expect(missing.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const res = await post(
      o.owner,
      (await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      number: 'EXP-00001',
      exchangeRate: '15.4200000000',
      exchangeRateSource: 'table',
      baseTotal: '3084.0000',
    });
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal).toMatchObject({ currency: 'USD', exchangeRateSource: 'table' });
    expect(await glBalance(o.organizationId, o.accounts['1120']!)).toBe('-3084.00');
    // Paid from a USD account the credit is in USD at the same rate.
    const usd = await usdBank(o);
    const second = await posted(
      o.owner,
      draft(o, {
        paymentAccountId: usd,
        lines: [{ description: 'Software', quantity: '1', unitPrice: '100' }],
      }),
    );
    const j2 = await journalOf(o, second.journalId);
    const paid = j2.lines.find((l) => l.accountId === usd)!;
    expect(paid).toMatchObject({ credit: '100.0000', baseCredit: '1542.0000' });
    expect(second.baseTotal).toBe('1542.0000');
  });

  it('accepts a manual rate with a reason, keeping the table rate', async () => {
    const o = await expenseOrg({ vendor: { currencyCode: 'USD' } });
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const noReason = await o.owner.post('/purchases/expenses', draft(o, { rateOverride: '15.50' }));
    expect(noReason.body.error.details.issues[0].path).toBe('rateOverrideReason');
    const expense = await posted(
      o.owner,
      draft(o, {
        rateOverride: '15.50',
        rateOverrideReason: 'Card statement rate',
        lines: [{ description: 'Hotel', quantity: '1', unitPrice: '100' }],
      }),
    );
    expect(expense).toMatchObject({
      exchangeRate: '15.5000000000',
      exchangeRateSource: 'manual',
      tableRate: '15.4200000000',
      baseTotal: '1550.0000',
    });
    expect(await auditActions(o, expense.id)).toEqual(
      expect.arrayContaining(['expense.created', 'expense.rate_overridden', 'expense.posted']),
    );
    const base = await o.owner.post('/purchases/expenses', {
      ...draft(o, { currencyCode: 'MVR' }),
      rateOverride: '2',
      rateOverrideReason: 'x',
    });
    expect(base.body.error.details.issues[0].message).toBe(
      'A base-currency expense has no exchange rate to override.',
    );
  });
});

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

describe('expense approval', () => {
  async function withPolicy(threshold: string) {
    const o = await expenseOrg();
    await createRole(o.owner, 'Expense approver', ['expenses.view', 'expenses.approve']);
    const roles = (await o.owner.get('/organizations/current/roles')).body.data as {
      id: string;
      name: string;
    }[];
    const approverRole = roles.find((r) => r.name === 'Expense approver')!.id;
    const policy = await o.owner.put('/approvals/policies/purchases.expense.post', {
      steps: [
        {
          name: 'Finance manager',
          requiredApprovals: 1,
          roleIds: [approverRole],
          membershipIds: [],
          conditions: { minBaseAmount: threshold },
        },
      ],
    });
    expect(policy.status, JSON.stringify(policy.body)).toBe(200);
    const admin = await joinWithRole(ctx, o.owner, 'Expense approver');
    return { o, admin: admin.client };
  }

  it('posts below the threshold directly; above it, approval authorizes and post is separate', async () => {
    const { o, admin } = await withPolicy('500');
    const small = await posted(o.owner, draft(o));
    expect(small.status).toBe('POSTED');
    const large = await createExpense(
      o.owner,
      draft(o, { lines: [{ description: 'Equipment', quantity: '1', unitPrice: '800' }] }),
    );
    expect(large.approval).toMatchObject({ required: true, readyToIssue: false });
    expect(large.approval.facts).toMatchObject({ transactionType: 'expense' });
    expect((await post(o.owner, large)).body.error.code).toBe('APPROVAL_REQUIRED');
    const submitted = await o.owner.post(`/purchases/expenses/${large.id}/submit`, {
      version: large.version,
    });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');
    const edit = await o.owner.put(`/purchases/expenses/${large.id}`, {
      ...draft(o),
      version: submitted.body.data.version,
    });
    expect(edit.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const requestId = submitted.body.data.approval.requestId;
    expect(
      (await o.owner.post(`/approvals/requests/${requestId}/approve`, {})).body.error.code,
    ).toBe('SELF_APPROVAL_PROHIBITED');
    const approved = await admin.post(`/approvals/requests/${requestId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const after = (await o.owner.get(`/purchases/expenses/${large.id}`)).body.data;
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', number: null });
    expect(after.approval).toMatchObject({ readyToIssue: true, requestStatus: 'approved' });
    const done = await post(o.owner, after);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('POSTED');
    expect(await auditActions(o, large.id)).toEqual(
      expect.arrayContaining(['expense.submitted', 'expense.approved', 'expense.posted']),
    );
  });

  it('needs a reason to reject, returns the expense to draft, and supports withdrawal', async () => {
    const { o, admin } = await withPolicy('0');
    const expense = await createExpense(o.owner, draft(o));
    const submitted = (
      await o.owner.post(`/purchases/expenses/${expense.id}/submit`, { version: expense.version })
    ).body.data;
    const requestId = submitted.approval.requestId;
    const noReason = await admin.post(`/approvals/requests/${requestId}/reject`, {});
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.details.issues[0].path).toBe('comment');
    const rejected = await admin.post(`/approvals/requests/${requestId}/reject`, {
      comment: 'No receipt',
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const back = (await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data;
    expect(back.status).toBe('DRAFT');
    const again = (
      await o.owner.post(`/purchases/expenses/${expense.id}/submit`, { version: back.version })
    ).body.data;
    const withdrawn = await o.owner.post(`/purchases/expenses/${expense.id}/withdraw`, {
      version: again.version,
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.data.status).toBe('DRAFT');
    expect(await auditActions(o, expense.id)).toEqual(
      expect.arrayContaining(['expense.rejected', 'expense.withdrawn']),
    );
  });

  it('refuses to submit when no approval step applies', async () => {
    const o = await expenseOrg();
    const expense = await createExpense(o.owner, draft(o));
    const res = await o.owner.post(`/purchases/expenses/${expense.id}/submit`, {
      version: expense.version,
    });
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

describe('voiding expenses', () => {
  it('reverses through Purchases with re-authentication, and refuses repeats and drafts', async () => {
    const o = await expenseOrg();
    const expense = await posted(o.owner, draft(o));
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/purchases/expenses/${expense.id}/void`, {
      version: expense.version,
      reason: 'Duplicate entry',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/purchases/expenses/${expense.id}/void`, {
      version: expense.version,
      reason: 'Duplicate entry',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Duplicate entry' });
    expect((await journalOf(o, expense.journalId)).status).toBe('REVERSED');
    expect(await glBalance(o.organizationId, o.accounts['1120']!)).toBe('0.00');
    expect(await glBalance(o.organizationId, o.accounts['5400']!)).toBe('0.00');
    const again = await o.owner.post(`/purchases/expenses/${expense.id}/void`, {
      version: voided.body.data.version,
      reason: 'x',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const draftOne = await createExpense(o.owner, draft(o));
    const draftVoid = await o.owner.post(`/purchases/expenses/${draftOne.id}/void`, {
      version: draftOne.version,
      reason: 'x',
    });
    expect(draftVoid.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, expense.id)).toEqual(
      expect.arrayContaining(['expense.posted', 'expense.voided']),
    );
    // Voiding needs a reason, and the expense keeps its number.
    expect(
      (await o.owner.post(`/purchases/expenses/${expense.id}/void`, { version: 1, reason: '' }))
        .status,
    ).toBe(400);
    expect((await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data.number).toBe(
      'EXP-00001',
    );
  });

  it('refuses a void in a closed period', async () => {
    const o = await expenseOrg();
    const expense = await posted(o.owner, draft(o));
    const period = o.periods.find((p) => p.startDate === '2026-03-01')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    const closed = await o.owner.post(`/purchases/expenses/${expense.id}/void`, {
      version: expense.version,
      reason: 'Too late',
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
    expect((await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data.status).toBe(
      'POSTED',
    );
  });
});

// ---------------------------------------------------------------------------
// Dimensions, evidence, immutability, security
// ---------------------------------------------------------------------------

describe('expense dimensions', () => {
  it('enforces required dimensions at post, rejects invalid values and keeps posted values', async () => {
    const o = await expenseOrg();
    const type = await o.owner.post('/accounting/dimensions', {
      code: 'DEPT',
      name: 'Department',
      isRequired: true,
      scope: { accountTypes: ['EXPENSE'], accountSubtypes: [] },
    });
    expect(type.status, JSON.stringify(type.body)).toBe(201);
    const value = await o.owner.post(`/accounting/dimensions/${type.body.data.id}/values`, {
      code: 'OPS',
      name: 'Operations',
    });
    expect(value.status, JSON.stringify(value.body)).toBe(201);
    const refused = await post(o.owner, await createExpense(o.owner, draft(o)));
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe('Required dimensions are missing.');
    expect(refused.body.error.details.issues).toEqual([
      { path: 'lines', message: 'Department is required for expense lines.' },
    ]);
    const unknown = await o.owner.post(
      '/purchases/expenses',
      draft(o, { dimensionValueIds: [randomUUID()] }),
    );
    expect(unknown.body.error.details.issues[0]).toEqual({
      path: 'dimensionValueIds',
      message: 'Unknown dimension value.',
    });
    const tagged = await posted(o.owner, draft(o, { dimensionValueIds: [value.body.data.id] }));
    const journal = await journalOf(o, tagged.journalId);
    const expenseLine = journal.lines.find((l) => l.accountId === o.accounts['5400'])!;
    expect(expenseLine.dimensions.map((d) => d.dimensionValueId)).toEqual([value.body.data.id]);
    expect(tagged.dimensionValueIds).toEqual([value.body.data.id]);
    // Posted assignments are immutable at the database.
    await expect(
      owner.query(`UPDATE purchases_expenses SET dimension_value_ids = '{}' WHERE id = $1`, [
        tagged.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('expense evidence', () => {
  it('adds the receipt at any time and removes it only while the expense is a draft', async () => {
    const o = await expenseOrg();
    const expense = await createExpense(o.owner, draft(o));
    const first = await o.owner.upload(
      `/files?linkType=expense&linkId=${expense.id}`,
      PDF,
      'receipt.pdf',
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await o.owner.delete(`/files/${first.body.data.id}`)).status).toBe(204);
    const kept = await o.owner.upload(
      `/files?linkType=expense&linkId=${expense.id}`,
      PDF,
      'receipt.pdf',
    );
    const done = await post(
      o.owner,
      (await o.owner.get(`/purchases/expenses/${expense.id}`)).body.data,
    );
    expect(done.status).toBe(200);
    const late = await o.owner.upload(
      `/files?linkType=expense&linkId=${expense.id}`,
      PDF,
      'late.pdf',
    );
    expect(late.status).toBe(201);
    expect((await o.owner.delete(`/files/${kept.body.data.id}`)).status).toBe(409);
    await createRole(o.owner, 'Expense viewer', ['expenses.view']);
    const viewer = await joinWithRole(ctx, o.owner, 'Expense viewer');
    expect((await viewer.client.get(`/files?linkType=expense&linkId=${expense.id}`)).status).toBe(
      200,
    );
    expect(
      (await viewer.client.upload(`/files?linkType=expense&linkId=${expense.id}`, PDF, 'x.pdf'))
        .status,
    ).toBe(403);
  });
});

describe('expense immutability in the database', () => {
  it('guards the posted document, its lines and the lifecycle', async () => {
    const o = await expenseOrg();
    const expense = await posted(o.owner, draft(o));
    const update = (sql: string, params: unknown[] = []) => owner.query(sql, params);
    await expect(
      update(`UPDATE purchases_expenses SET memo = 'edited' WHERE id = $1`, [expense.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      update(`UPDATE purchases_expenses SET number = 'EXP-99999' WHERE id = $1`, [expense.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      update(`UPDATE purchases_expense_lines SET unit_price = 1 WHERE expense_id = $1`, [
        expense.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      update(`DELETE FROM purchases_expense_lines WHERE expense_id = $1`, [expense.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      update(`DELETE FROM purchases_expenses WHERE id = $1`, [expense.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      update(`UPDATE purchases_expenses SET status = 'DRAFT' WHERE id = $1`, [expense.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(update(`TRUNCATE purchases_expenses CASCADE`)).rejects.toBeTruthy();
  });
});

describe('expense security', () => {
  it('follows the expense permission catalog for each action', async () => {
    const o = await expenseOrg();
    const expense = await createExpense(o.owner, draft(o));
    await createRole(o.owner, 'Expense viewer', ['expenses.view']);
    await createRole(o.owner, 'Expense clerk', ['expenses.view', 'expenses.create']);
    await createRole(o.owner, 'Expense voider', ['expenses.view', 'expenses.void']);
    const viewer = await joinWithRole(ctx, o.owner, 'Expense viewer');
    const clerk = await joinWithRole(ctx, o.owner, 'Expense clerk');
    const voider = await joinWithRole(ctx, o.owner, 'Expense voider');
    // View only: reads, never writes.
    expect((await viewer.client.get('/purchases/expenses')).status).toBe(200);
    expect((await viewer.client.get(`/purchases/expenses/${expense.id}`)).status).toBe(200);
    expect((await viewer.client.post('/purchases/expenses', draft(o))).status).toBe(403);
    expect((await post(viewer.client, expense)).status).toBe(403);
    expect(
      (
        await viewer.client.post(`/purchases/expenses/${expense.id}/void`, {
          version: 1,
          reason: 'x',
        })
      ).status,
    ).toBe(403);
    // A clerk creates and posts, but cannot void.
    const mine = await createExpense(clerk.client, draft(o));
    const done = await post(clerk.client, mine);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const clerkVoid = await clerk.client.post(`/purchases/expenses/${mine.id}/void`, {
      version: done.body.data.version,
      reason: 'x',
    });
    expect(clerkVoid.status).toBe(403);
    // A voider cannot create or post.
    expect((await voider.client.post('/purchases/expenses', draft(o))).status).toBe(403);
    // Someone with no expense permission sees nothing.
    await createRole(o.owner, 'Nothing', ['bills.view']);
    const nobody = await joinWithRole(ctx, o.owner, 'Nothing');
    expect((await nobody.client.get('/purchases/expenses')).status).toBe(403);
  });

  it('keeps expenses tenant-isolated', async () => {
    const a = await expenseOrg();
    const b = await expenseOrg();
    const expense = await posted(a.owner, draft(a));
    expect((await b.owner.get(`/purchases/expenses/${expense.id}`)).status).toBe(404);
    expect(
      (await b.owner.post(`/purchases/expenses/${expense.id}/void`, { version: 1, reason: 'x' }))
        .status,
    ).toBe(404);
    expect((await b.owner.get('/purchases/expenses')).body.data.items).toHaveLength(0);
    expect((await a.owner.get('/purchases/expenses?search=island')).body.data.items).toHaveLength(
      1,
    );
    const other = await b.owner.get(`/files?linkType=expense&linkId=${expense.id}`);
    expect(other.status).toBe(404);
  });
});

describe('expense lists', () => {
  it('filters by status, date and vendor and pages with a cursor', async () => {
    const o = await expenseOrg();
    await posted(o.owner, draft(o, { expenseDate: '2026-03-02' }));
    await posted(o.owner, draft(o, { expenseDate: '2026-03-12' }));
    await createExpense(o.owner, draft(o, { expenseDate: '2026-03-20' }));
    const all = (await o.owner.get('/purchases/expenses')).body.data.items as { status: string }[];
    expect(all).toHaveLength(3);
    const postedOnly = (await o.owner.get('/purchases/expenses?status=POSTED')).body.data.items;
    expect(postedOnly).toHaveLength(2);
    const ranged = (await o.owner.get('/purchases/expenses?from=2026-03-10&to=2026-03-31')).body
      .data.items;
    expect(ranged).toHaveLength(2);
    const page = (await o.owner.get('/purchases/expenses?limit=2')).body.data;
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const next = (await o.owner.get(`/purchases/expenses?limit=2&after=${page.nextCursor}`)).body
      .data;
    expect(next.items).toHaveLength(1);
    expect(next.nextCursor).toBeNull();
    expect((await o.owner.get('/purchases/expenses?after=nonsense')).status).toBe(400);
  });
});
