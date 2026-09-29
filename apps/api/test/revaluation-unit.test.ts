import { describe, expect, it } from 'vitest';
import {
  mirrorJournalLines,
  planRevaluation,
  resolveMonetary,
  type ClosingRate,
  type RevaluationExposure,
} from '../src/modules/accounting/index.js';

/** Phase 3A S9: pure revaluation rules (A = round(F x rate) - B, journal plan, reversal mirror). */

const exposure = (
  code: string,
  currency: string,
  foreignBalance: string,
  carryingBase: string,
): RevaluationExposure => ({
  kind: 'ACCOUNT',
  accountId: `id-${code}`,
  accountCode: code,
  accountName: `Account ${code}`,
  currency,
  foreignBalance,
  carryingBase,
  document: null,
});

const rate = (value: string, rateDate = '2026-03-31'): ClosingRate => ({
  rate: value,
  rateDate,
  source: 'table',
});

const plan = (
  exposures: RevaluationExposure[],
  rates: Record<string, ClosingRate | undefined>,
  options: { staleBefore?: string | null; maxLines?: number } = {},
) =>
  planRevaluation({
    baseCurrency: 'MVR',
    exposures,
    rates: new Map(Object.entries(rates)),
    unrealizedAccountId: 'fx',
    staleBefore: options.staleBefore ?? '2026-03-01',
    maxLines: options.maxLines ?? 500,
  });

const lineOf = (lines: { accountId: string }[], accountId: string) =>
  lines.find((l) => l.accountId === accountId);

describe('adjustment direction (A = T - B)', () => {
  it('books a gain on an asset when the currency strengthens', () => {
    const result = plan([exposure('1125', 'USD', '1000', '15420')], { USD: rate('15.50') });
    expect(result.issues).toEqual([]);
    expect(result.lines[0]).toMatchObject({ revaluedBase: '15500', adjustment: '80' });
    const [journal] = result.journals;
    expect(journal!.lines).toEqual([
      expect.objectContaining({
        accountId: 'id-1125',
        kind: 'base_only',
        baseDebit: '80',
        baseCredit: null,
      }),
      expect.objectContaining({
        accountId: 'fx',
        kind: 'base_only',
        baseDebit: null,
        baseCredit: '80',
      }),
    ]);
    expect(result.totals).toEqual({ gain: '80', loss: '0', net: '80' });
  });

  it('books a loss on an asset when the currency weakens', () => {
    const result = plan([exposure('1125', 'USD', '1000', '15420')], { USD: rate('15.30') });
    expect(result.lines[0]!.adjustment).toBe('-120');
    const lines = result.journals[0]!.lines;
    expect(lineOf(lines, 'id-1125')).toMatchObject({ baseCredit: '120', baseDebit: null });
    expect(lineOf(lines, 'fx')).toMatchObject({ baseDebit: '120', baseCredit: null });
    expect(result.totals).toEqual({ gain: '0', loss: '120', net: '-120' });
  });

  it('books a loss on a liability when the currency strengthens, and a gain when it weakens', () => {
    const up = plan([exposure('2520', 'USD', '-1000', '-15420')], { USD: rate('15.50') });
    expect(up.lines[0]!.adjustment).toBe('-80');
    expect(lineOf(up.journals[0]!.lines, 'id-2520')).toMatchObject({ baseCredit: '80' });
    expect(up.totals).toMatchObject({ loss: '80', net: '-80' });
    const down = plan([exposure('2520', 'USD', '-1000', '-15420')], { USD: rate('15.30') });
    expect(down.lines[0]!.adjustment).toBe('120');
    expect(lineOf(down.journals[0]!.lines, 'id-2520')).toMatchObject({ baseDebit: '120' });
    expect(down.totals).toMatchObject({ gain: '120', net: '120' });
  });
});

describe('rounding and edge values', () => {
  it('rounds T half-up to base minor units, symmetrically for credit balances', () => {
    const result = plan(
      [
        exposure('1125', 'USD', '1', '0'),
        exposure('1126', 'USD', '-1', '0'),
        exposure('1127', 'USD', '0.01', '0'),
      ],
      { USD: rate('15.425') },
    );
    expect(result.lines.map((l) => l.revaluedBase)).toEqual(['15.43', '-15.43', '0.15']);
  });

  it('records no line and no journal for a zero adjustment', () => {
    const result = plan([exposure('1125', 'USD', '100', '1542')], { USD: rate('15.42') });
    expect(result.issues).toEqual([]);
    expect(result.lines).toEqual([]);
    expect(result.journals).toEqual([]);
    expect(result.totals).toEqual({ gain: '0', loss: '0', net: '0' });
  });

  it('clears a residual base amount when the foreign balance is zero, with a warning', () => {
    const result = plan([exposure('1125', 'USD', '0', '3.5')], { USD: rate('15.42') });
    expect(result.lines[0]).toMatchObject({ revaluedBase: '0', adjustment: '-3.5' });
    expect(result.warnings[0]!.message).toMatch(/no USD balance but carries 3.5 MVR/);
    expect(result.journals[0]!.lines).toHaveLength(2);
  });

  it('ignores exposures with neither a foreign balance nor a carrying amount', () => {
    expect(plan([exposure('1125', 'USD', '0', '0')], {}).lines).toEqual([]);
  });
});

describe('rates', () => {
  it('blocks the run when a currency has no rate', () => {
    const result = plan([exposure('1125', 'USD', '100', '1542')], { USD: undefined });
    expect(result.issues[0]!.message).toMatch(/No USD to MVR rate is recorded/);
    expect(result.journals).toEqual([]);
  });

  it('warns about a rate dated before the period', () => {
    const result = plan([exposure('1125', 'USD', '100', '1542')], {
      USD: rate('15.50', '2026-02-10'),
    });
    expect(result.issues).toEqual([]);
    expect(result.warnings[0]!.message).toMatch(/latest USD rate is dated 2026-02-10/);
  });
});

describe('journal plan', () => {
  it('plans one journal per currency, in currency order, each with its own offset', () => {
    const result = plan(
      [
        exposure('1125', 'USD', '1000', '15420'),
        exposure('1135', 'EUR', '200', '3400'),
        exposure('2520', 'USD', '-500', '-7710'),
      ],
      { USD: rate('15.50'), EUR: rate('17.25') },
    );
    expect(result.journals.map((j) => j.currency)).toEqual(['EUR', 'USD']);
    const [eur, usd] = result.journals;
    expect(eur!.lines).toHaveLength(2);
    expect(eur).toMatchObject({ gain: '50', loss: '0' });
    // USD: bank +80, loan -40, net +40 to Unrealized FX.
    expect(usd!.lines.map((l) => [l.accountId, l.baseDebit, l.baseCredit])).toEqual([
      ['id-1125', '80', null],
      ['id-2520', null, '40'],
      ['fx', null, '40'],
    ]);
    expect(result.totals).toEqual({ gain: '130', loss: '40', net: '90' });
  });

  it('omits zero-adjustment accounts and the offset when gains and losses cancel', () => {
    const omitted = plan(
      [exposure('1125', 'USD', '1000', '15420'), exposure('1126', 'USD', '100', '1550')],
      { USD: rate('15.50') },
    );
    expect(omitted.journals[0]!.lines.map((l) => l.accountId)).toEqual(['id-1125', 'fx']);
    expect(omitted.lines.map((l) => [l.lineNumber, l.exposure.accountCode])).toEqual([[1, '1125']]);
    const cancelling = plan(
      [exposure('1125', 'USD', '1000', '15420'), exposure('2520', 'USD', '-1000', '-15420')],
      { USD: rate('15.50') },
    );
    expect(cancelling.journals[0]!.lines.map((l) => l.accountId)).toEqual(['id-1125', 'id-2520']);
    expect(cancelling.totals).toEqual({ gain: '80', loss: '80', net: '0' });
  });

  it('refuses a currency with more accounts than one journal holds (line cap)', () => {
    const exposures = ['1', '2', '3'].map((n) => exposure(`11${n}`, 'USD', '10', '150'));
    expect(plan(exposures.slice(0, 2), { USD: rate('15.50') }, { maxLines: 3 }).issues).toEqual([]);
    const result = plan(exposures, { USD: rate('15.50') }, { maxLines: 3 });
    expect(result.issues[0]!.message).toMatch(
      /USD has 3 accounts to revalue; one revaluation journal holds at most 2/,
    );
    expect(result.journals).toEqual([]);
  });

  it('mirrors journal lines side for side for the reversal', () => {
    const [journal] = plan([exposure('1125', 'USD', '1000', '15420')], {
      USD: rate('15.50'),
    }).journals;
    const mirrored = mirrorJournalLines(journal!.lines);
    expect(mirrored.map((l) => [l.accountId, l.kind, l.baseDebit, l.baseCredit])).toEqual([
      ['id-1125', 'base_only', null, '80'],
      ['fx', 'base_only', '80', null],
    ]);
    expect(mirrorJournalLines(mirrored)).toEqual(journal!.lines);
  });
});

describe('monetary classification amendment (N9)', () => {
  it('lets other assets be marked monetary explicitly, never by default', () => {
    for (const subtype of ['OTHER_CURRENT_ASSET', 'OTHER_ASSET'] as const) {
      expect(resolveMonetary(subtype, true)).toEqual({ ok: true, value: true });
      expect(resolveMonetary(subtype, undefined)).toEqual({ ok: true, value: false });
    }
    expect(resolveMonetary('FIXED_ASSET', true).ok).toBe(false);
    expect(resolveMonetary(null, true).ok).toBe(false);
  });
});
