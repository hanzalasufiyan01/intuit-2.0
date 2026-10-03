import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import * as engine from '../src/modules/documents/index.js';
import type { Discount } from '../src/modules/documents/index.js';
import * as sales from '../src/modules/sales/index.js';
import type { TaxTreatment } from '../src/modules/tax/index.js';

/**
 * Phase 4A-0 (P4-04): golden equivalence for the shared document engine. The expected outputs
 * were captured from the Sales implementation before the extraction; after it, the same inputs
 * must give byte-identical outputs. Run with UPDATE_GOLDEN=1 only to (re)capture the fixture.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'golden',
  'documents-engine.json',
);

/** Deterministic pseudo-random numbers (LCG), so the case set never changes. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const CURRENCIES = ['MVR', 'USD', 'JPY', 'KWD', 'EUR'] as const;
const TREATMENTS: TaxTreatment[] = ['exclusive', 'inclusive', 'no_tax'];
const RATES = [null, '0', '8', '16', '17', '12.5', '7.75'];

const out = (value: unknown): unknown => {
  if (Decimal.isDecimal(value)) return (value as Decimal).toFixed();
  if (Array.isArray(value)) return value.map(out);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, out(v)]));
  }
  return value;
};

function calculationCases() {
  const next = rng(20261001);
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!;
  const amount = (max: number, places: number) => (next() * max).toFixed(places);
  const discount = (): Discount | null => {
    const r = next();
    if (r < 0.5) return null;
    if (r < 0.75)
      return { type: 'percent', value: pick(['0', '5', '10', '12.5', '33.333', '100']) };
    return { type: 'amount', value: amount(60, 2) };
  };
  const cases = [];
  for (let i = 0; i < 300; i += 1) {
    const lineCount = 1 + Math.floor(next() * 6);
    cases.push({
      currency: pick(CURRENCIES),
      treatment: pick(TREATMENTS),
      discount: discount(),
      lines: Array.from({ length: lineCount }, () => ({
        quantity: pick(['1', '2', '3', '0.5', '1.25', '10', '0.333', '7']),
        unitPrice: amount(900, pick([0, 2, 3, 4])),
        discount: discount(),
        ratePercent: pick(RATES),
      })),
    });
  }
  // Edge cases: invalid discounts, zero lines, 100% discounts, tiny amounts.
  cases.push(
    {
      currency: 'MVR',
      treatment: 'exclusive',
      discount: { type: 'percent', value: '101' },
      lines: [{ quantity: '1', unitPrice: '10', discount: null, ratePercent: '8' }],
    },
    {
      currency: 'MVR',
      treatment: 'exclusive',
      discount: { type: 'amount', value: '50' },
      lines: [{ quantity: '1', unitPrice: '10', discount: null, ratePercent: '8' }],
    },
    {
      currency: 'USD',
      treatment: 'inclusive',
      discount: null,
      lines: [
        {
          quantity: '1',
          unitPrice: '10',
          discount: { type: 'amount', value: '10.001' },
          ratePercent: '8',
        },
      ],
    },
    {
      currency: 'JPY',
      treatment: 'exclusive',
      discount: { type: 'amount', value: '1' },
      lines: [{ quantity: '3', unitPrice: '0.333', discount: null, ratePercent: '8' }],
    },
    {
      currency: 'MVR',
      treatment: 'exclusive',
      discount: { type: 'percent', value: '100' },
      lines: [{ quantity: '2', unitPrice: '99.99', discount: null, ratePercent: '17' }],
    },
    {
      currency: 'KWD',
      treatment: 'inclusive',
      discount: { type: 'amount', value: '0.001' },
      lines: [
        { quantity: '1', unitPrice: '0.001', discount: null, ratePercent: '8' },
        { quantity: '1', unitPrice: '0.002', discount: null, ratePercent: null },
      ],
    },
    { currency: 'MVR', treatment: 'no_tax', discount: null, lines: [] },
  );
  return cases as Parameters<typeof engine.calculateDocument>[0][];
}

function settlementCases() {
  const next = rng(4242);
  const money = (max: number) => new Decimal((next() * max).toFixed(2));
  const cases = [];
  for (let i = 0; i < 60; i += 1) {
    const rate = new Decimal((0.5 + next() * 20).toFixed(6));
    const allocations = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, j) => {
      const amountDue = money(2000).plus('0.01');
      const baseDue = amountDue.times((10 + next() * 10).toFixed(4)).toDecimalPlaces(2);
      const amount =
        next() < 0.3
          ? amountDue
          : amountDue.times(next().toFixed(3)).toDecimalPlaces(2).plus('0.01');
      return {
        invoiceId: `inv-${i}-${j}`,
        amount: Decimal.min(amount, amountDue),
        open: { amountDue, baseDue },
      };
    });
    const allocated = allocations.reduce((s, a) => s.plus(a.amount), new Decimal(0));
    cases.push({
      amount: allocated.plus(next() < 0.4 ? money(300) : 0),
      rate,
      baseCurrency: 'MVR',
      allocations,
    });
  }
  return cases;
}

function journalCases() {
  const next = rng(7);
  const cases = [];
  const typeOf = new Map([
    ['dv-a1', 'dt-a'],
    ['dv-a2', 'dt-a'],
    ['dv-b1', 'dt-b'],
  ]);
  for (let i = 0; i < 40; i += 1) {
    const foreign = next() < 0.5;
    const revenue = Array.from({ length: 1 + Math.floor(next() * 5) }, () => ({
      accountId: next() < 0.15 ? null : `acc-${Math.floor(next() * 3)}`,
      dimensionValueIds: next() < 0.5 ? [] : [next() < 0.5 ? 'dv-a1' : 'dv-a2'],
      net: new Decimal((next() * 1000).toFixed(2)),
    }));
    const taxes = Array.from({ length: Math.floor(next() * 3) }, (_, j) => ({
      taxCodeId: `tax-${j % 2}`,
      label: `GST ${j}`,
      accountId: 'acc-tax',
      amount: new Decimal((next() * 80).toFixed(2)),
    }));
    cases.push({
      direction: (next() < 0.5 ? 'invoice' : 'credit_note') as 'invoice' | 'credit_note',
      documentLabel: `Doc ${i}`,
      arAccountId: 'acc-ar',
      documentDimensionValueIds: next() < 0.5 ? [] : ['dv-b1', 'dv-a2'],
      typeOf,
      revenue,
      taxes,
      currency: foreign ? 'USD' : 'MVR',
      baseCurrency: 'MVR',
      rate: new Decimal(foreign ? (10 + next() * 10).toFixed(6) : '1'),
    });
  }
  return cases;
}

function compute(e: typeof engine) {
  return out({
    calculate: calculationCases().map((c) => e.calculateDocument(c)),
    dueDates: [
      ['2026-01-31', 30],
      ['2024-02-28', 1],
      ['2026-12-31', 0],
      ['2026-03-01', 365],
    ].map(([d, n]) => e.dueDateFor(d as string, n as number)),
    receipts: settlementCases().map((c) => e.settleReceipt(c)),
    credits: settlementCases().map((c) =>
      e.settleCredit({
        source: {
          amountDue: c.amount.plus(1),
          baseDue: c.amount.plus(1).times(c.rate).toDecimalPlaces(2),
        },
        baseCurrency: c.baseCurrency,
        allocations: c.allocations,
      }),
    ),
    relieved: settlementCases().flatMap((c) =>
      c.allocations.map((a) => e.relievedBase(a.amount, a.open, c.baseCurrency)),
    ),
    journals: journalCases().map((c) => e.buildDocumentJournal(c)),
    merge: [
      e.mergeDimensions(
        ['dv-a1'],
        ['dv-a2', 'dv-b1'],
        new Map([
          ['dv-a1', 'a'],
          ['dv-a2', 'a'],
          ['dv-b1', 'b'],
        ]),
      ),
      e.mergeDimensions([], ['dv-b1'], new Map([['dv-b1', 'b']])),
    ],
  });
}

describe('shared document engine — golden equivalence (P4-04)', () => {
  it('reproduces the captured Sales outputs exactly', () => {
    const actual = compute(engine);
    if (process.env.UPDATE_GOLDEN === '1') {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 1)}\n`);
    }
    expect(existsSync(FIXTURE), 'golden fixture missing; capture it with UPDATE_GOLDEN=1').toBe(
      true,
    );
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    expect(actual).toEqual(expected);
  });

  it('is what Sales uses: the Sales contract re-exports the very same functions', () => {
    for (const name of [
      'calculateDocument',
      'dueDateFor',
      'relievedBase',
      'settleReceipt',
      'settleCredit',
      'buildDocumentJournal',
      'mergeDimensions',
      'discountTypes',
    ] as const) {
      expect(sales[name], name).toBe(engine[name]);
    }
  });
});
