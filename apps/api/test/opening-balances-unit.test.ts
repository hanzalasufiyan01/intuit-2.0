import { describe, expect, it } from 'vitest';
import {
  AP_OPENING_MESSAGE,
  AR_OPENING_MESSAGE,
  CONTROL_OPENING_MESSAGE,
  openingDateFor,
  openingLineIssues,
  openingTotals,
  planOpeningJournals,
  UNCLASSIFIED_OPENING_MESSAGE,
  type OpeningAccount,
  type PlanLine,
} from '../src/modules/accounting/opening-balances.js';

/** Phase 3A S8: pure opening-balance rules (currency grouping, OBE, base amounts, line rules). */

const account = (id: string, overrides: Partial<OpeningAccount> = {}): OpeningAccount => ({
  id,
  code: id.toUpperCase(),
  name: `Account ${id}`,
  status: 'ACTIVE',
  isLeaf: true,
  currencyCode: 'MVR',
  isControlAccount: false,
  accountType: 'ASSET',
  subtype: 'BANK',
  ...overrides,
});

const accounts = new Map<string, OpeningAccount>(
  [
    account('cash'),
    account('usdbank', { currencyCode: 'USD' }),
    account('usdloan', {
      currencyCode: 'USD',
      accountType: 'LIABILITY',
      subtype: 'LONG_TERM_LIABILITY',
    }),
    account('eurbank', { currencyCode: 'EUR' }),
    account('capital', { accountType: 'EQUITY', subtype: 'EQUITY' }),
    account('obe', { accountType: 'EQUITY', subtype: 'EQUITY' }),
    account('ar', { subtype: 'ACCOUNTS_RECEIVABLE' }),
    account('ap', { accountType: 'LIABILITY', subtype: 'ACCOUNTS_PAYABLE' }),
    account('apcontrol', {
      accountType: 'LIABILITY',
      subtype: 'ACCOUNTS_PAYABLE',
      isControlAccount: true,
    }),
    account('accrued', { accountType: 'LIABILITY', subtype: 'OTHER_CURRENT_LIABILITY' }),
    account('control', { subtype: 'OTHER_CURRENT_ASSET', isControlAccount: true }),
    account('sales', { accountType: 'REVENUE', subtype: 'OPERATING_REVENUE' }),
    account('parent', { isLeaf: false }),
    account('archived', { status: 'ARCHIVED' }),
    account('unclassified', { subtype: null }),
  ].map((a) => [a.id, a]),
);

let n = 0;
const line = (
  accountId: string,
  side: 'debit' | 'credit',
  amount: string,
  baseAmount: string | null = null,
): PlanLine => ({
  lineNumber: ++n,
  accountId,
  description: '',
  debit: side === 'debit' ? amount : null,
  credit: side === 'credit' ? amount : null,
  baseAmount,
  dimensions: [],
});

const plan = (
  lines: PlanLine[],
  rates: Record<string, string | null> = { USD: '15.42' },
  maxLines = 500,
) =>
  planOpeningJournals({
    baseCurrency: 'MVR',
    lines,
    accounts,
    obeAccountId: 'obe',
    tableRates: new Map(Object.entries(rates)),
    openingDate: '2026-03-31',
    maxLines,
  });

const issuesFor = (l: PlanLine, overrides: Partial<Parameters<typeof openingLineIssues>[2]> = {}) =>
  openingLineIssues(l, 'lines.0', {
    account: accounts.get(l.accountId),
    baseCurrency: 'MVR',
    obeAccountId: 'obe',
    profitAndLossAllowed: true,
    profitAndLossReason: 'P&L not allowed',
    ...overrides,
  }).map((i) => i.message);

describe('opening date (S8-04)', () => {
  it('is the day before the conversion date, across month and year ends', () => {
    expect(openingDateFor('2026-04-01')).toBe('2026-03-31');
    expect(openingDateFor('2026-01-01')).toBe('2025-12-31');
    expect(openingDateFor('2024-03-01')).toBe('2024-02-29');
  });
});

describe('journal plan (Decision 68, S8-05, S8-06, S8-10)', () => {
  it('groups by currency, base currency first, and balances each against OBE', () => {
    const result = plan([
      line('eurbank', 'debit', '10.00', '180.00'),
      line('usdbank', 'debit', '1000.00'),
      line('cash', 'debit', '5000.00'),
      line('capital', 'credit', '3000.00'),
    ]);
    expect(result.issues).toEqual([]);
    expect(result.journals.map((j) => j.currency)).toEqual(['MVR', 'EUR', 'USD']);
    const [mvr, eur, usd] = result.journals;
    expect(mvr).toMatchObject({
      rateSource: 'base',
      rate: '1',
      obe: { side: 'credit', amount: '2000', baseAmount: null },
      totals: { debit: '5000', credit: '5000' },
    });
    expect(mvr!.lines.at(-1)).toMatchObject({ accountId: 'obe', credit: '2000', debit: null });
    expect(usd).toMatchObject({
      rateSource: 'table',
      rate: '15.42',
      obe: { side: 'credit', amount: '1000', baseAmount: null },
    });
    // Explicit carrying value: every line has a base amount, including the generated OBE line.
    expect(eur).toMatchObject({
      rateSource: 'explicit',
      rate: '18',
      obe: { side: 'credit', amount: '10', baseAmount: '180' },
      totals: { debit: '10', credit: '10', baseDebit: '180', baseCredit: '180' },
    });
    expect(eur!.lines.every((l) => (l.baseDebit ?? l.baseCredit) !== null)).toBe(true);
  });

  it('puts OBE on the debit side for net credit balances and omits it when balanced', () => {
    const credit = plan([line('capital', 'credit', '700'), line('cash', 'debit', '200')]);
    expect(credit.journals[0]!.obe).toEqual({ side: 'debit', amount: '500', baseAmount: null });
    const balanced = plan([line('cash', 'debit', '200'), line('capital', 'credit', '200')]);
    expect(balanced.journals[0]!.obe).toBeNull();
    expect(balanced.journals[0]!.lines).toHaveLength(2);
  });

  it('enforces all-or-none explicit base amounts per currency', () => {
    const result = plan([line('usdbank', 'debit', '100', '1542'), line('usdloan', 'credit', '40')]);
    expect(result.issues[0]!.message).toMatch(/base amount on every USD line, or on none/);
  });

  it('needs a table rate unless carrying values are given', () => {
    const missing = plan([line('usdbank', 'debit', '100')], { USD: null });
    expect(missing.issues[0]!.message).toMatch(/No USD rate is recorded on or before 2026-03-31/);
    const explicit = plan([line('usdbank', 'debit', '100', '1500')], { USD: null });
    expect(explicit.issues).toEqual([]);
    expect(explicit.journals[0]).toMatchObject({ rateSource: 'explicit', rate: '15' });
  });

  it('rejects base amounts that point the other way or cannot balance', () => {
    const inverted = plan([
      line('usdbank', 'debit', '100', '100'),
      line('usdloan', 'credit', '50', '500'),
    ]);
    expect(inverted.issues[0]!.message).toMatch(/do not follow/);
    const baseOnly = plan([
      line('usdbank', 'debit', '100', '1500'),
      line('usdloan', 'credit', '100', '1400'),
    ]);
    expect(baseOnly.issues[0]!.message).toMatch(/cannot be booked without a base-only line/);
  });

  it('allows at most maxLines - 1 account lines per currency (S8-19)', () => {
    const lines = Array.from({ length: 5 }, () => line('cash', 'debit', '1'));
    expect(plan(lines, {}, 6).issues).toEqual([]);
    const tooMany = plan([...lines, line('cash', 'debit', '1')], {}, 6);
    expect(tooMany.issues[0]!.message).toMatch(
      /MVR has 6 opening lines; one opening journal holds at most 5/,
    );
    expect(tooMany.journals).toEqual([]);
  });

  it('refuses an empty batch', () => {
    expect(plan([]).issues[0]!.message).toBe('Enter at least one opening balance.');
  });
});

describe('line rules (S8-05 to S8-08)', () => {
  it('rejects receivable and control accounts with guidance (S8-07)', () => {
    expect(issuesFor(line('ar', 'debit', '10'))).toEqual([AR_OPENING_MESSAGE]);
    expect(issuesFor(line('control', 'debit', '10'))).toEqual([CONTROL_OPENING_MESSAGE]);
    expect(AR_OPENING_MESSAGE).toMatch(/opening invoices/);
  });

  it('rejects payables with or without control ownership (ADR 0004 P4-36)', () => {
    expect(issuesFor(line('ap', 'credit', '10'))).toEqual([AP_OPENING_MESSAGE]);
    expect(issuesFor(line('apcontrol', 'credit', '10'))).toEqual([CONTROL_OPENING_MESSAGE]);
    expect(AP_OPENING_MESSAGE).toMatch(/opening bills/);
    // Ordinary liabilities are unaffected.
    expect(issuesFor(line('accrued', 'credit', '10'))).toEqual([]);
  });

  it('rejects unclassified accounts without inferring a subtype (S8-07 final ruling)', () => {
    expect(issuesFor(line('unclassified', 'debit', '10'))).toEqual([UNCLASSIFIED_OPENING_MESSAGE]);
    expect(UNCLASSIFIED_OPENING_MESSAGE).toMatch(/never inferred/);
  });

  it('rejects OBE, parent, archived and unknown accounts', () => {
    expect(issuesFor(line('obe', 'credit', '10'))[0]).toMatch(/calculated automatically/);
    expect(issuesFor(line('parent', 'debit', '10'))[0]).toMatch(/parent account/);
    expect(issuesFor(line('archived', 'debit', '10'))[0]).toMatch(/archived/);
    expect(issuesFor(line('nope', 'debit', '10'))).toEqual(['Unknown account.']);
  });

  it('applies the P&L fiscal-year rule only when told to (S8-08)', () => {
    expect(issuesFor(line('sales', 'credit', '10'))).toEqual([]);
    expect(issuesFor(line('sales', 'credit', '10'), { profitAndLossAllowed: false })).toEqual([
      'P&L not allowed',
    ]);
  });

  it('checks sides, signs and currency precision', () => {
    const both = { ...line('cash', 'debit', '10'), credit: '10' };
    expect(issuesFor(both)).toContain('Enter either a debit or a credit on each line.');
    const neither = { ...line('cash', 'debit', '10'), debit: null };
    expect(issuesFor(neither)).toContain('Enter either a debit or a credit on each line.');
    expect(issuesFor(line('cash', 'debit', '-5'))[0]).toMatch(/decimal strings|positive/);
    expect(issuesFor(line('cash', 'debit', '1.234'))[0]).toMatch(/minor-unit decimals/);
    expect(issuesFor(line('cash', 'debit', '0'))[0]).toMatch(/positive/);
  });

  it('allows base amounts only on foreign-currency accounts', () => {
    expect(issuesFor(line('cash', 'debit', '10', '10'))).toEqual([
      'A base amount is only entered for foreign-currency accounts.',
    ]);
    expect(issuesFor(line('usdbank', 'debit', '10', '154.2'))).toEqual([]);
    expect(issuesFor(line('usdbank', 'debit', '10', '1.234'))[0]).toMatch(/positive MVR amounts/);
  });
});

describe('totals for the read-only view', () => {
  it('sums per currency and shows the OBE that posting would add', () => {
    expect(
      openingTotals(
        [
          line('cash', 'debit', '100'),
          line('usdbank', 'debit', '5'),
          line('capital', 'credit', '30'),
        ],
        accounts,
        'MVR',
      ),
    ).toEqual([
      {
        currency: 'MVR',
        lines: 2,
        debit: '100',
        credit: '30',
        openingBalanceEquity: { side: 'credit', amount: '70' },
      },
      {
        currency: 'USD',
        lines: 1,
        debit: '5',
        credit: '0',
        openingBalanceEquity: { side: 'credit', amount: '5' },
      },
    ]);
  });
});
