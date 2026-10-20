import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountBalances, ReportAccount } from '../src/modules/accounting/index.js';
import { buildCashFlow, buildEquity } from '../src/modules/reports/index.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Statement of Cash Flows (indirect) and Statement of Changes in Equity (master context
 * section 16, ADR 0012): the pure builders on hand-made balances, then the endpoints on real
 * PostgreSQL (amounts, integrity, permissions, tenant isolation, strict queries).
 */

const zero: AccountBalances = {
  netBeforeFiscalYear: '0',
  netFiscalYearBeforeFrom: '0',
  netBeforeFrom: '0',
  debitInRange: '0',
  creditInRange: '0',
  txnNetBeforeFrom: '0',
  txnNetFiscalYearBeforeFrom: '0',
  txnNetInRange: '0',
};

function account(
  id: string,
  type: ReportAccount['accountType'],
  subtype: ReportAccount['subtype'],
  balances: Partial<AccountBalances> = {},
): ReportAccount {
  return {
    id,
    code: id,
    name: `Account ${id}`,
    accountType: type,
    subtype,
    parentId: null,
    status: 'ACTIVE',
    currencyCode: 'MVR',
    isLeaf: true,
    balances: { ...zero, ...balances },
  };
}

/**
 * Debits 780 = credits 780: bank +200 (opening 500), receivable +200, fixed asset +150, accumulated
 * depreciation -30, payable +50, equity +100, revenue 500, rent 100, depreciation 30.
 */
function sampleAccounts() {
  return [
    account('bank', 'ASSET', 'BANK', {
      netBeforeFrom: '500',
      debitInRange: '300',
      creditInRange: '100',
    }),
    account('ar', 'ASSET', 'ACCOUNTS_RECEIVABLE', { debitInRange: '200' }),
    account('fa', 'ASSET', 'FIXED_ASSET', { debitInRange: '150' }),
    account('accdep', 'ASSET', 'FIXED_ASSET', { creditInRange: '30' }),
    account('ap', 'LIABILITY', 'ACCOUNTS_PAYABLE', { creditInRange: '50' }),
    account('capital', 'EQUITY', 'EQUITY', { netBeforeFrom: '-500', creditInRange: '100' }),
    account('revenue', 'REVENUE', 'OPERATING_REVENUE', { creditInRange: '500' }),
    account('rent', 'EXPENSE', 'OPERATING_EXPENSE', { debitInRange: '100' }),
    account('depn', 'EXPENSE', 'OPERATING_EXPENSE', { debitInRange: '30' }),
  ];
}

const input = (accounts: readonly ReportAccount[], extra = {}) => ({
  accounts,
  depreciationAccountIds: new Set(['accdep']),
  baseCurrency: 'MVR',
  includeZero: false,
  tagged: false,
  ...extra,
});

describe('buildCashFlow', () => {
  it('classifies by subtype and adds up to the change in cash', () => {
    const cf = buildCashFlow(input(sampleAccounts()));
    const section = (key: string) => cf.sections.find((s) => s.key === key)!;
    expect(cf.netIncome).toBe('370.0000');
    // 370 profit + 30 depreciation add-back - 200 receivables + 50 payables.
    expect(section('operating').total).toBe('250.0000');
    expect(section('operating').groups.map((g) => [g.key, g.total])).toEqual(
      expect.arrayContaining([
        ['depreciation', '30.0000'],
        ['receivables', '-200.0000'],
        ['payables', '50.0000'],
      ]),
    );
    expect(section('investing').total).toBe('-150.0000');
    expect(section('financing').total).toBe('100.0000');
    expect(cf.cash).toMatchObject({
      opening: '500.0000',
      netChange: '200.0000',
      closing: '700.0000',
    });
    expect(cf.integrity.status).toBe('BALANCED');
    expect(cf.warnings).toEqual([]);
    // The flat rows end with the cash reconciliation.
    expect(cf.rows.at(-1)).toMatchObject({ name: 'Closing cash', values: { amount: '700.0000' } });
  });

  it('keeps the depreciation add-back out of investing even though the account is a fixed asset', () => {
    const withoutSet = buildCashFlow(
      input(sampleAccounts(), { depreciationAccountIds: new Set() }),
    );
    // Without knowing the account, the 30 add-back is netted inside investing (-120): still balanced.
    expect(withoutSet.sections.find((s) => s.key === 'investing')!.total).toBe('-120.0000');
    expect(withoutSet.integrity.status).toBe('BALANCED');
  });

  it('never guesses unclassified accounts and says so; no cash accounts means no recognised cash', () => {
    const accounts = sampleAccounts().map((a) =>
      a.id === 'bank' || a.id === 'ar' ? { ...a, subtype: null } : a,
    );
    const cf = buildCashFlow(input(accounts));
    expect(cf.warnings.map((w) => w.code).sort()).toEqual([
      'NO_CASH_ACCOUNTS',
      'UNCLASSIFIED_ACCOUNTS',
    ]);
    expect(cf.cash.netChange).toBe('0.0000');
    expect(cf.integrity.status).toBe('BALANCED');
    expect(cf.sections.find((s) => s.key === 'operating')!.groups.map((g) => g.key)).toContain(
      'unclassified_assets',
    );
  });

  it('flags a book that does not balance and is not applicable to tagged activity', () => {
    const broken = sampleAccounts().map((a) =>
      a.id === 'ar' ? { ...a, balances: { ...a.balances, debitInRange: '210' } } : a,
    );
    expect(buildCashFlow(input(broken)).integrity.status).toBe('OUT_OF_BALANCE');
    expect(buildCashFlow(input(broken, { tagged: true })).integrity.status).toBe('NOT_APPLICABLE');
  });

  it('hides zero accounts unless asked', () => {
    const accounts = [...sampleAccounts(), account('idle', 'ASSET', 'OTHER_CURRENT_ASSET')];
    const lines = (cf: ReturnType<typeof buildCashFlow>) =>
      cf.sections.flatMap((s) => s.groups.flatMap((g) => g.lines.map((l) => l.accountId)));
    expect(lines(buildCashFlow(input(accounts)))).not.toContain('idle');
    expect(lines(buildCashFlow(input(accounts, { includeZero: true })))).toContain('idle');
  });
});

describe('buildEquity', () => {
  /** Opening equity 1,200 (capital 1,000 + earlier profit 200); +100 contribution, -20 drawing, +370 profit. */
  function equityAccounts() {
    return [
      account('bank', 'ASSET', 'BANK', {
        netBeforeFrom: '1200',
        debitInRange: '600',
        creditInRange: '150',
      }),
      account('capital', 'EQUITY', 'EQUITY', {
        netBeforeFrom: '-1000',
        creditInRange: '100',
        debitInRange: '20',
      }),
      account('revenue', 'REVENUE', 'OPERATING_REVENUE', {
        netBeforeFrom: '-300',
        creditInRange: '500',
      }),
      account('rent', 'EXPENSE', 'OPERATING_EXPENSE', {
        netBeforeFrom: '100',
        debitInRange: '130',
      }),
    ];
  }
  const run = (accounts: readonly ReportAccount[], extra = {}) =>
    buildEquity({ accounts, baseCurrency: 'MVR', includeZero: false, tagged: false, ...extra });

  it('rolls opening equity forward by profit and other movements to the closing equity', () => {
    const eq = run(equityAccounts());
    const capital = eq.columns.find((c) => c.accountId === 'capital')!;
    const earnings = eq.columns.find((c) => c.key === 'accumulated_earnings')!;
    expect(capital).toMatchObject({
      opening: '1000.0000',
      otherMovements: '80.0000',
      closing: '1080.0000',
    });
    expect(earnings).toMatchObject({
      opening: '200.0000',
      profit: '370.0000',
      closing: '570.0000',
    });
    expect(eq.totals).toEqual({
      opening: '1200.0000',
      profit: '370.0000',
      otherMovements: '80.0000',
      closing: '1650.0000',
    });
    expect(eq.integrity.status).toBe('BALANCED');
    expect(eq.assets).toBe('1650.0000');
  });

  it('proves the accounting equation and reports a difference', () => {
    const broken = equityAccounts().map((a) =>
      a.id === 'bank' ? { ...a, balances: { ...a.balances, debitInRange: '605' } } : a,
    );
    expect(run(broken).integrity.status).toBe('OUT_OF_BALANCE');
    expect(run(broken, { tagged: true }).integrity.status).toBe('NOT_APPLICABLE');
  });
});

// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

function journal(date: string, debit: string, credit: string, amount: string) {
  return {
    entryDate: date,
    description: `J ${date}`,
    currency: 'MVR',
    lines: [line(debit, 'debit', amount), line(credit, 'credit', amount)],
  };
}

/** FY2025: revenue 1,000 to the bank, rent 400. FY2026: revenue 300 (Feb), dividend 100 (Mar). */
async function standardOrg(): Promise<AccountingOrg> {
  const org = await setUpAccountingOrg(ctx);
  const fy = await org.owner.post('/accounting/fiscal-years', {
    name: 'FY2025',
    startDate: '2025-01-01',
    endDate: '2025-12-31',
  });
  expect(fy.status, JSON.stringify(fy.body)).toBe(201);
  const a = org.accounts;
  await postJournal(org, journal('2025-03-10', a['1110']!, a['4100']!, '1000.00') as never);
  await postJournal(org, journal('2025-04-10', a['5300']!, a['1110']!, '400.00') as never);
  await postJournal(org, journal('2026-02-10', a['1110']!, a['4100']!, '300.00') as never);
  await postJournal(org, journal('2026-03-01', a['3200']!, a['1110']!, '100.00') as never);
  return org;
}

const report = (client: TestClient, path: string) => client.get(`/accounting/reports/${path}`);

describe('GET /accounting/reports/cash-flow', () => {
  it('reports the period from the ledger and reconciles to the change in the bank balance', async () => {
    const org = await standardOrg();
    const res = await report(org.owner, 'cash-flow?from=2026-01-01&to=2026-06-30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [col] = res.body.data.columns;
    expect(res.body.data).toMatchObject({
      report: 'cash_flow',
      method: 'indirect',
      baseCurrency: 'MVR',
    });
    expect(col.netIncome).toBe('300.0000');
    expect(col.cash).toMatchObject({
      opening: '600.0000',
      netChange: '200.0000',
      closing: '800.0000',
    });
    const section = (key: string) => col.sections.find((s: { key: string }) => s.key === key);
    expect(section('operating').total).toBe('300.0000');
    expect(section('investing').total).toBe('0.0000');
    expect(section('financing').total).toBe('-100.0000');
    expect(col.integrity.status).toBe('BALANCED');
    // The bank balance on the Balance Sheet is the closing cash.
    const sheet = await report(org.owner, 'balance-sheet?asOf=2026-06-30');
    const rows = sheet.body.data.sections.flatMap(
      (s: { rows: { code: string | null; amounts?: string[] }[] }) => s.rows,
    );
    expect(rows.find((r: { code: string | null }) => r.code === '1110').amounts).toEqual([
      '800.0000',
    ]);
  });

  it('compares with the previous period and is tenant isolated', async () => {
    const org = await standardOrg();
    const compared = await report(
      org.owner,
      'cash-flow?from=2026-01-01&to=2026-06-30&compare=previous_year',
    );
    expect(compared.status, JSON.stringify(compared.body)).toBe(200);
    expect(compared.body.data.columns.map((c: { key: string }) => c.key)).toEqual([
      'current',
      'comparison',
    ]);
    // 2025: revenue 1,000, rent 400 -> cash +600 from nothing.
    expect(compared.body.data.columns[1].cash).toMatchObject({
      opening: '0.0000',
      netChange: '600.0000',
    });
    const other = await setUpAccountingOrg(ctx);
    const empty = await report(other.owner, 'cash-flow?from=2026-01-01&to=2026-06-30');
    expect(empty.status, JSON.stringify(empty.body)).toBe(200);
    expect(empty.body.data.columns[0].cash.netChange).toBe('0.0000');
  });

  it('needs accounting.reports.view and rejects unknown query parameters', async () => {
    const org = await standardOrg();
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'No reports',
      permissionKeys: ['webhooks.view'],
    });
    expect(role.status, JSON.stringify(role.body)).toBe(201);
    const nobody = await joinWithRole(ctx, org.owner, 'No reports');
    expect((await report(nobody.client, 'cash-flow')).status).toBe(403);
    expect((await report(nobody.client, 'changes-in-equity')).status).toBe(403);
    expect((await report(org.owner, 'cash-flow?bogus=1')).status).toBe(400);
    expect((await report(org.owner, 'changes-in-equity?bogus=1')).status).toBe(400);
  });
});

describe('GET /accounting/reports/changes-in-equity', () => {
  it('rolls retained earnings forward and proves assets minus liabilities', async () => {
    const org = await standardOrg();
    const res = await report(org.owner, 'changes-in-equity?from=2026-01-01&to=2026-06-30');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const eq = res.body.data;
    expect(eq.report).toBe('changes_in_equity');
    const earnings = eq.columns.find((c: { key: string }) => c.key === 'accumulated_earnings');
    expect(earnings).toMatchObject({
      opening: '600.0000',
      profit: '300.0000',
      closing: '900.0000',
    });
    const retained = eq.columns.find((c: { label: string }) => c.label.startsWith('3200'));
    expect(retained).toMatchObject({
      opening: '0.0000',
      otherMovements: '-100.0000',
      closing: '-100.0000',
    });
    expect(eq.totals).toMatchObject({ opening: '600.0000', closing: '800.0000' });
    expect(eq.integrity.status).toBe('BALANCED');
    expect(eq.assets).toBe('800.0000');
  });
});
