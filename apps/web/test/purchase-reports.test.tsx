import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { en } from '../src/i18n/messages.en';
import { makeSession } from './fake-api';

/**
 * Phase 4B-6: unpaid bills, purchases by vendor, item and account, the input-tax summary and the
 * payment register on the Purchases reports page (PD9: one page, nine tabs).
 */

type Handler = (url: URL) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      calls.push(url);
      const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url)
        : {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
          };
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const ok = (data: unknown) => () => ({ status: 200, body: { data } });

const REPORTS = [
  'purchases.reports.view',
  'vendors.view',
  'bills.view',
  'accounting.accounts.view',
];

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /vendors': ok({
    items: [{ id: 'va', displayName: 'Atoll Supplies', currencyCode: 'MVR' }],
    nextCursor: null,
  }),
  'GET /sales/items': ok({ items: [{ id: 'i1', name: 'Paper' }], nextCursor: null }),
  'GET /accounting/accounts': ok([
    { id: 'a1120', code: '1120', name: 'Bank', isLeaf: true, isBankOrCash: true, subtype: 'BANK' },
    {
      id: 'a5400',
      code: '5400',
      name: 'Supplies',
      isLeaf: true,
      isBankOrCash: false,
      subtype: 'OPERATING_EXPENSE',
    },
  ]),
});

const sums = (net: string, rec: string, nonRec: string) => {
  const n = Number(net);
  const r = Number(rec);
  const x = Number(nonRec);
  return {
    net,
    recoverableTax: rec,
    nonRecoverableTax: nonRec,
    cost: (n + x).toFixed(2),
    tax: (r + x).toFixed(2),
    total: (n + r + x).toFixed(2),
  };
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('Purchases reports, 4B-6 tabs', () => {
  it('offers nine report tabs on one page (PD9)', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/aging': ok({
        asOf: '2026-03-31',
        baseCurrency: 'MVR',
        buckets: [],
        vendors: [],
        totals: {},
      }),
    });
    renderAt('/purchases/reports');
    const tabs = await screen.findByRole('navigation', { name: 'Reports' });
    expect(
      within(tabs)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'AP aging',
      'Vendor statement',
      'AP reconciliation',
      'Unpaid bills',
      'Purchases by vendor',
      'Purchases by item',
      'Purchases by account',
      'Input tax summary',
      'Payment register',
    ]);
  });

  it('shows unpaid bills in relative windows with drill links (PD1, PD3)', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/unpaid-bills': ok({
        asOf: '2026-03-31',
        baseCurrency: 'MVR',
        buckets: [
          {
            key: 'overdue',
            from: null,
            to: '2026-03-30',
            currencies: [{ currencyCode: 'USD', amount: '20.00' }],
            base: '310.00',
            bills: [
              {
                id: 'b3',
                number: 'BILL-00003',
                vendorId: 'va',
                vendorName: 'Atoll Supplies',
                vendorReference: null,
                billDate: '2026-02-01',
                dueDate: '2026-03-03',
                daysUntilDue: -28,
                currencyCode: 'USD',
                openAmount: '20.00',
                openBase: '310.00',
              },
            ],
          },
          {
            key: 'days0to7',
            from: '2026-03-31',
            to: '2026-04-07',
            currencies: [],
            base: '0.00',
            bills: [],
          },
        ],
        totals: { currencies: [{ currencyCode: 'USD', amount: '20.00' }], base: '310.00' },
      }),
    });
    renderAt('/purchases/reports?view=unpaid');
    expect(await screen.findByText('Overdue')).toBeTruthy();
    expect(screen.getByText('before 2026-03-31')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'BILL-00003' }).getAttribute('href')).toBe(
      '/purchases/bills/b3',
    );
    expect(screen.queryByText('Due in 0–7 days')).toBeNull(); // empty windows are not drawn
    expect(screen.getByText(en['purchases.reports.unpaid.note'])).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Vendor'), 'va');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    const last = calls.filter((c) => c.pathname.endsWith('/unpaid-bills')).at(-1)!;
    expect(last.searchParams.get('vendorId')).toBe('va');
    expect(last.searchParams.has('asOf')).toBe(true);
  });

  it('shows purchases by vendor with PD2 columns and a statement link', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/purchases-by-vendor': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        vendors: [
          {
            vendorId: 'va',
            vendorName: 'Atoll Supplies',
            bills: 2,
            credits: 1,
            ...sums('170.00', '14.00', '5.10'),
          },
        ],
        totals: sums('170.00', '14.00', '5.10'),
      }),
    });
    renderAt('/purchases/reports?view=byVendor');
    const link = await screen.findByRole('link', { name: 'Atoll Supplies' });
    expect(link.getAttribute('href')).toBe('/purchases/reports?view=statement&vendorId=va');
    const head = screen.getAllByRole('rowgroup')[0]!;
    for (const header of ['Net', 'Recoverable tax', 'Non-recoverable tax', 'Cost', 'Total']) {
      expect(within(head).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(screen.getAllByText('189.10')).toHaveLength(2);
  });

  it('shows purchases by item with a No item row (PD10)', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/purchases-by-item': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        items: [
          {
            itemId: 'i1',
            name: 'Paper',
            sku: 'P-1',
            quantity: '2',
            lines: 3,
            ...sums('50.46', '4.00', '0.00'),
          },
          {
            itemId: null,
            name: null,
            sku: null,
            quantity: '1',
            lines: 3,
            ...sums('120.00', '10.00', '5.10'),
          },
        ],
        totals: sums('170.46', '14.00', '5.10'),
      }),
    });
    renderAt('/purchases/reports?view=byItem');
    expect(await screen.findByText('No item')).toBeTruthy();
    expect(within(screen.getAllByRole('rowgroup')[1]!).getByText('Paper')).toBeTruthy();
    expect(screen.getByLabelText('Item')).toBeTruthy();
  });

  it('shows purchases by account at cost, with recoverable tax noted separately', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/purchases-by-account': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        accounts: [
          {
            accountId: 'a5400',
            code: '5400',
            name: 'Supplies',
            net: '20.00',
            nonRecoverableTax: '5.10',
            cost: '25.10',
          },
        ],
        totals: { net: '20.00', nonRecoverableTax: '5.10', cost: '25.10', recoverableTax: '14.00' },
      }),
    });
    renderAt('/purchases/reports?view=byAccount');
    expect(await screen.findByRole('cell', { name: '5400 · Supplies' })).toBeTruthy();
    expect(screen.getByText(/Recoverable input tax \(14.00\)/)).toBeTruthy();
  });

  it('labels the input-tax summary as review only', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/input-tax-summary': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        reviewOnly: true,
        codes: [
          {
            taxCodeId: 'gst',
            code: 'GST',
            rate: '8',
            taxable: '50.00',
            recoverableTax: '4.00',
            nonRecoverableTax: '0.00',
            tax: '4.00',
          },
          {
            taxCodeId: null,
            code: null,
            rate: null,
            taxable: '-9.07',
            recoverableTax: '0.00',
            nonRecoverableTax: '0.00',
            tax: '0.00',
          },
        ],
        totals: {
          taxable: '40.93',
          recoverableTax: '4.00',
          nonRecoverableTax: '0.00',
          tax: '4.00',
        },
      }),
    });
    renderAt('/purchases/reports?view=inputTax');
    expect(await screen.findByText('8%')).toBeTruthy();
    expect(screen.getByText(en['purchases.reports.reviewOnly'])).toBeTruthy();
    expect(screen.getByText('No tax code')).toBeTruthy();
  });

  it('shows the payment register with voids, batches, refunds and truncation (PD6–PD8)', async () => {
    const user = userEvent.setup();
    const summary = (count: number, voided: number, base: string) => ({
      subtotals: [
        {
          accountId: 'a1120',
          account: { code: '1120', name: 'Bank' },
          currencyCode: 'MVR',
          count,
          amount: base,
          baseAmount: base,
          realizedFx: '0.00',
        },
      ],
      totals: { count, voided, baseAmount: base },
    });
    const calls = stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/payment-register': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        limit: 2000,
        truncated: true,
        payments: [
          {
            id: 'p1',
            number: 'PAY-00001',
            status: 'RECORDED',
            paymentDate: '2026-03-10',
            vendorId: 'va',
            vendorName: 'Atoll Supplies',
            paymentAccountId: 'a1120',
            account: { code: '1120', name: 'Bank' },
            paymentBatchId: 'pb1',
            currencyCode: 'MVR',
            amount: '100.00',
            exchangeRate: '1',
            exchangeRateSource: 'base',
            baseAmount: '100.00',
            appliedToBills: '100.00',
            prepayment: '0.00',
            realizedFx: '0.00',
            voidedAt: null,
          },
          {
            id: 'p5',
            number: 'PAY-00005',
            status: 'VOID',
            paymentDate: '2026-03-21',
            vendorId: 'va',
            vendorName: 'Atoll Supplies',
            paymentAccountId: 'a1120',
            account: { code: '1120', name: 'Bank' },
            paymentBatchId: null,
            currencyCode: 'MVR',
            amount: '70.00',
            exchangeRate: '1',
            exchangeRateSource: 'base',
            baseAmount: '70.00',
            appliedToBills: '0.00',
            prepayment: '70.00',
            realizedFx: '0.00',
            voidedAt: '2026-03-21T00:00:00Z',
          },
        ],
        paymentSummary: summary(1, 1, '100.00'),
        refunds: [
          {
            id: 'r1',
            number: 'VR-00001',
            status: 'RECORDED',
            refundDate: '2026-03-22',
            vendorId: 'va',
            vendorName: 'Atoll Supplies',
            refundAccountId: 'a1120',
            account: { code: '1120', name: 'Bank' },
            sourceType: 'payment',
            sourceId: 'p3',
            sourceNumber: 'PAY-00003',
            currencyCode: 'MVR',
            amount: '30.00',
            exchangeRate: '1',
            baseAmount: '30.00',
            realizedFx: '0.00',
            voidedAt: null,
          },
        ],
        refundSummary: summary(1, 0, '30.00'),
      }),
    });
    renderAt('/purchases/reports?view=register');
    expect(
      await screen.findByText(
        'Only the first 2000 rows (payments and refunds together) are shown. Narrow the period or filters to see the rest.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'PAY-00001' }).getAttribute('href')).toBe(
      '/purchases/payments/p1',
    );
    expect(screen.getByRole('link', { name: 'Batch' }).getAttribute('href')).toBe(
      '/purchases/payment-batches/pb1',
    );
    expect(screen.getByText('Void')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Refunds' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'VR-00001' }).getAttribute('href')).toBe(
      '/purchases/refunds/r1',
    );
    expect(screen.getByRole('link', { name: 'PAY-00003' }).getAttribute('href')).toBe(
      '/purchases/payments/p3',
    );
    expect(screen.getByText('1 recorded, 1 void; base total 100.00')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await user.selectOptions(screen.getByLabelText('Paid from'), 'a1120');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    const last = calls.filter((c) => c.pathname.endsWith('/payment-register')).at(-1)!;
    expect(last.searchParams.get('currencyCode')).toBe('USD');
    expect(last.searchParams.get('paymentAccountId')).toBe('a1120');
    expect(last.searchParams.has('vendorId')).toBe(false);
  });

  it('shows empty states', async () => {
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/purchases-by-vendor': ok({
        from: '2026-03-01',
        to: '2026-03-31',
        baseCurrency: 'MVR',
        vendors: [],
        totals: sums('0.00', '0.00', '0.00'),
      }),
    });
    renderAt('/purchases/reports?view=byVendor');
    expect(await screen.findByText(en['purchases.reports.noRows'])).toBeTruthy();
  });

  it('keeps the reports from users without purchases.reports.view', async () => {
    stubApi(common(['vendors.view', 'vendor_payments.view']));
    renderAt('/purchases/reports?view=register');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });
});
