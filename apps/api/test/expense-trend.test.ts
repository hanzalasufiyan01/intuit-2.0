import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * Expense trend (master specification section 16, R-02): the expense accounts of the profit and
 * loss, month by month. Each month is the ordinary profit and loss for that month, so the totals
 * must agree with the statement to the cent; only posted ledger activity counts.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

const spend = (
  o: AccountingOrg,
  entryDate: string,
  account: '5300' | '5400',
  amount: string,
  side: 'debit' | 'credit' = 'debit',
) => ({
  entryDate,
  description: `Spend ${account}`,
  currency: 'MVR',
  lines: [
    line(o.accounts[account]!, side, amount),
    line(o.accounts['1110']!, side === 'debit' ? 'credit' : 'debit', amount),
  ],
});

const trend = (o: AccountingOrg, from: string, to: string) =>
  o.owner.get(`/accounting/reports/expense-trend?from=${from}&to=${to}`);

const EXPENSE_SECTIONS = [
  'cost_of_goods_sold',
  'operating_expenses',
  'other_expenses',
  'unclassified_expenses',
];

async function statementExpenses(o: AccountingOrg, from: string, to: string) {
  const res = await o.owner.get(`/accounting/reports/profit-and-loss?from=${from}&to=${to}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const sections = res.body.data.sections as { key: string; total: string[] }[];
  return sections
    .filter((s) => EXPENSE_SECTIONS.includes(s.key))
    .reduce((sum, s) => sum + Number(s.total[0]), 0)
    .toFixed(2);
}

async function populated() {
  const o = await setUpAccountingOrg(ctx);
  await postJournal(o, spend(o, '2026-01-10', '5400', '100.00'));
  await postJournal(o, spend(o, '2026-02-05', '5400', '50.00'));
  await postJournal(o, spend(o, '2026-02-20', '5300', '30.00'));
  // A credit to an expense account (a refund) lowers the month.
  await postJournal(o, spend(o, '2026-04-12', '5400', '20.00'));
  await postJournal(o, spend(o, '2026-04-18', '5400', '5.00', 'credit'));
  // Revenue is not an expense and never appears.
  await postJournal(o, {
    entryDate: '2026-01-15',
    description: 'Cash sale',
    currency: 'MVR',
    lines: [
      line(o.accounts['1110']!, 'debit', '900.00'),
      line(o.accounts['4100']!, 'credit', '900.00'),
    ],
  });
  return o;
}

describe('expense trend', () => {
  it('shows each expense account per month and agrees with the profit and loss', async () => {
    const o = await populated();
    const res = await trend(o, '2026-01-01', '2026-04-30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.data;
    expect(r.report).toBe('expense_trend');
    expect(r.baseCurrency).toBe('MVR');
    expect(r.months.map((m: { label: string }) => m.label)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
    const byCode = Object.fromEntries(
      r.accounts.map((a: { code: string; amounts: string[]; total: string }) => [a.code, a]),
    );
    expect(Object.keys(byCode).sort()).toEqual(['5300', '5400']);
    expect(byCode['5400'].amounts).toEqual(['100.00', '50.00', '0.00', '15.00']);
    expect(byCode['5400'].total).toBe('165.00');
    expect(byCode['5300'].amounts).toEqual(['0.00', '30.00', '0.00', '0.00']);
    expect(r.totals).toEqual(['100.00', '80.00', '0.00', '15.00']);
    expect(r.total).toBe('195.00');
    // Reconciliation: every month and the whole range equal the ordinary profit and loss.
    for (const [i, m] of r.months.entries()) {
      expect(r.totals[i], m.label).toBe(await statementExpenses(o, m.from, m.to));
    }
    expect(r.total).toBe(await statementExpenses(o, '2026-01-01', '2026-04-30'));
    // The rows add up to the month totals.
    for (let i = 0; i < r.months.length; i += 1) {
      const sum = r.accounts.reduce(
        (acc: number, a: { amounts: string[] }) => acc + Number(a.amounts[i]),
        0,
      );
      expect(sum.toFixed(2)).toBe(r.totals[i]);
    }
  });

  it('clips the first and last month to the range asked for', async () => {
    const o = await populated();
    const res = await trend(o, '2026-02-10', '2026-04-12');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const r = res.body.data;
    expect(r.months).toEqual([
      { label: '2026-02', from: '2026-02-10', to: '2026-02-28' },
      { label: '2026-03', from: '2026-03-01', to: '2026-03-31' },
      { label: '2026-04', from: '2026-04-01', to: '2026-04-12' },
    ]);
    // 5 February (before the range) is out; 20 February (30.00) and 12 April (20.00) are in.
    expect(r.totals).toEqual(['30.00', '0.00', '20.00']);
    expect(r.total).toBe('50.00');
  });

  it('counts posted activity only: a draft journal does not appear', async () => {
    const o = await populated();
    const draft = await o.owner.post(
      '/accounting/journals',
      spend(o, '2026-01-20', '5400', '777.00'),
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const r = (await trend(o, '2026-01-01', '2026-01-31')).body.data;
    expect(r.totals).toEqual(['100.00']);
    expect(JSON.stringify(r)).not.toContain('777');
  });

  it('shows an empty report for a period without expenses', async () => {
    const o = await setUpAccountingOrg(ctx);
    const r = (await trend(o, '2026-01-01', '2026-02-28')).body.data;
    expect(r.accounts).toEqual([]);
    expect(r.totals).toEqual(['0.00', '0.00']);
    expect(r.total).toBe('0.00');
  });

  it('validates the range', async () => {
    const o = await setUpAccountingOrg(ctx);
    const bad = [
      'from=2026-03-01&to=2026-02-01',
      'from=2026-02-30&to=2026-03-01',
      'from=2026-01-01',
      'to=2026-01-01',
      'from=2024-01-01&to=2026-12-31',
      'from=2026-01-01&to=2026-02-01&extra=1',
    ];
    for (const query of bad) {
      const res = await o.owner.get(`/accounting/reports/expense-trend?${query}`);
      expect(res.status, query).toBe(400);
    }
    // Like the profit and loss it reuses, a month before the first fiscal year is not an error: it
    // simply has no expenses.
    const early = await trend(o, '2025-12-01', '2026-01-31');
    expect(early.status, JSON.stringify(early.body)).toBe(200);
    expect(early.body.data.totals).toEqual(['0.00', '0.00']);
  });

  it('needs the reports permission and stays inside the organization', async () => {
    const a = await populated();
    const b = await setUpAccountingOrg(ctx);
    const created = await a.owner.post('/organizations/current/roles', {
      name: 'Customer clerk',
      permissionKeys: ['customers.view'],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const clerk = await joinWithRole(ctx, a.owner, 'Customer clerk');
    const denied = await clerk.client.get(
      '/accounting/reports/expense-trend?from=2026-01-01&to=2026-04-30',
    );
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).not.toContain('100.00');
    // Another organization sees none of this organization's expenses.
    const other = (await trend(b, '2026-01-01', '2026-04-30')).body.data;
    expect(other.total).toBe('0.00');
    expect(other.accounts).toEqual([]);
    // Signed out is refused.
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/accounting/reports/expense-trend?from=2026-01-01&to=2026-04-30',
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
