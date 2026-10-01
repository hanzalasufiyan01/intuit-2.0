import { describe, expect, it } from 'vitest';
import { decimal } from '../src/domain/money.js';
import { allocateDiscount, lineTax } from '../src/modules/tax/index.js';

/** Phase 3B step 2: tax calculation rules (Decisions 32–35). Pure, no database. */

const tax = (
  amount: string,
  ratePercent: string | null,
  treatment: 'exclusive' | 'inclusive' | 'no_tax',
  currency = 'MVR',
) => {
  const result = lineTax({ amount: decimal(amount), ratePercent, treatment, currency });
  return { net: result.net.toFixed(), tax: result.tax.toFixed(), gross: result.gross.toFixed() };
};

describe('line tax', () => {
  it('adds tax on top for Tax Exclusive', () => {
    expect(tax('100', '8', 'exclusive')).toEqual({ net: '100', tax: '8', gross: '108' });
    expect(tax('1234.56', '17', 'exclusive')).toEqual({
      net: '1234.56',
      tax: '209.88',
      gross: '1444.44',
    });
  });

  it('extracts tax for Tax Inclusive so net + tax equals the amount', () => {
    expect(tax('108', '8', 'inclusive')).toEqual({ net: '100', tax: '8', gross: '108' });
    // 100 × 17 / 117 = 14.5299… → 14.53
    expect(tax('100', '17', 'inclusive')).toEqual({ net: '85.47', tax: '14.53', gross: '100' });
  });

  it('rounds half-up per line to the currency minor units', () => {
    // 0.78 × 8% = 0.0624 → 0.06.
    expect(tax('0.78', '8', 'exclusive').tax).toBe('0.06');
    // The amount is rounded first (0.3125 → 0.31), then the tax (0.0248 → 0.02).
    expect(tax('0.3125', '8', 'exclusive')).toEqual({ net: '0.31', tax: '0.02', gross: '0.33' });
    expect(tax('10.5625', '0', 'exclusive').net).toBe('10.56');
    // 1.56 × 8% = 0.1248 → 0.12; 1.5625 rounds to 1.56 first, so the same.
    expect(tax('1.56', '8', 'exclusive').tax).toBe('0.12');
    expect(tax('1.5625', '8', 'exclusive').tax).toBe('0.12');
    expect(tax('6.25', '8', 'exclusive').tax).toBe('0.5');
    expect(tax('0.0625', '100', 'exclusive').tax).toBe('0.06');
    // Exactly half rounds up.
    expect(tax('0.125', '100', 'exclusive')).toEqual({ net: '0.13', tax: '0.13', gross: '0.26' });
    expect(tax('0.625', '8', 'exclusive')).toEqual({ net: '0.63', tax: '0.05', gross: '0.68' });
  });

  it('uses the currency minor units (0-decimal JPY, 3-decimal KWD)', () => {
    expect(tax('1005', '8', 'exclusive', 'JPY').tax).toBe('80');
    expect(tax('10.005', '8', 'exclusive', 'KWD').tax).toBe('0.8');
    expect(tax('10.0625', '8', 'exclusive', 'KWD')).toEqual({
      net: '10.063',
      tax: '0.805',
      gross: '10.868',
    });
  });

  it('charges nothing for No Tax or a line without a code', () => {
    expect(tax('99.99', '8', 'no_tax')).toEqual({ net: '99.99', tax: '0', gross: '99.99' });
    expect(tax('99.99', null, 'exclusive')).toEqual({ net: '99.99', tax: '0', gross: '99.99' });
  });

  it('sums rounded line taxes for the document, not the tax on the total (Decision 33)', () => {
    const lines = ['0.10', '0.10', '0.10'].map((a) =>
      lineTax({
        amount: decimal(a),
        ratePercent: '8',
        treatment: 'exclusive',
        currency: 'MVR',
      }),
    );
    const documentTax = lines.reduce((sum, l) => sum.plus(l.tax), decimal(0));
    // Each line: 0.008 → 0.01; the document 0.03 (a total-level 0.024 would round to 0.02).
    expect(documentTax.toFixed()).toBe('0.03');
  });
});

describe('document discount allocation (Decision 35)', () => {
  const allocate = (amounts: string[], discount: string, currency = 'MVR') =>
    allocateDiscount(
      amounts.map((a) => decimal(a)),
      decimal(discount),
      currency,
    ).map((d) => d.toFixed());

  it('spreads pro rata and always adds up exactly', () => {
    expect(allocate(['100', '300'], '40')).toEqual(['10', '30']);
    const shares = allocate(['1', '1', '1'], '1');
    expect(shares).toEqual(['0.34', '0.33', '0.33']);
    expect(shares.reduce((s, v) => s.plus(v), decimal(0)).toFixed()).toBe('1');
    const odd = allocate(['33.33', '66.67', '0.01'], '10.01');
    expect(odd.reduce((s, v) => s.plus(v), decimal(0)).toFixed()).toBe('10.01');
  });

  it('gives the remainder to the largest fractions, ties to the first line', () => {
    // Exact shares 0.625 / 0.375 → 0.62 + 0.37 = 0.99; equal fractions, so the first gets 0.01.
    expect(allocate(['5', '3'], '1')).toEqual(['0.63', '0.37']);
    // Exact 0.0222 / 0.0333 / 0.0444 → 0.02 + 0.03 + 0.04; the largest remainder is the last line.
    expect(allocate(['2', '3', '4'], '0.1')).toEqual(['0.02', '0.03', '0.05']);
  });

  it('returns zeros for no discount or no amount', () => {
    expect(allocate(['10', '20'], '0')).toEqual(['0', '0']);
    expect(allocate(['0', '0'], '5')).toEqual(['0', '0']);
    expect(allocate(['7'], '7')).toEqual(['7']);
  });

  it('respects 0-decimal currencies', () => {
    const shares = allocate(['1', '1', '1'], '100', 'JPY');
    expect(shares).toEqual(['34', '33', '33']);
  });
});
