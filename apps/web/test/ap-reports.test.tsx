import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { en } from '../src/i18n/messages.en';
import { makeSession } from './fake-api';

/** Phase 4B-5: AP aging, vendor statements and the AP reconciliation (P4-49, PD1–PD7). */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      calls.push({ method, url });
      const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url, undefined)
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

const REPORTS = ['purchases.reports.view', 'vendors.view', 'bills.view'];

const buckets = (values: Partial<Record<string, string>>) => ({
  current: '0.00',
  days1to30: '0.00',
  days31to60: '0.00',
  days61to90: '0.00',
  over90: '0.00',
  credit: '0.00',
  total: '0.00',
  ...values,
});

const agingReport = {
  asOf: '2026-03-31',
  baseCurrency: 'MVR',
  buckets: ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'],
  vendors: [
    {
      vendorId: 'va',
      vendorName: 'Atoll Supplies',
      currencies: [
        {
          currencyCode: 'MVR',
          ...buckets({ days1to30: '350.00', credit: '-70.00', total: '280.00' }),
        },
      ],
      base: buckets({ days1to30: '350.00', credit: '-70.00', total: '280.00' }),
      bills: [
        {
          id: 'b1',
          number: 'BILL-00001',
          vendorReference: 'INV-1',
          billDate: '2026-02-01',
          dueDate: '2026-03-03',
          daysOverdue: 28,
          bucket: 'days1to30',
          currencyCode: 'MVR',
          openAmount: '350.00',
          openBase: '350.00',
        },
      ],
      credits: [
        {
          type: 'vendor_credit',
          id: 'dn1',
          number: 'DN-00001',
          origin: 'debit_note',
          date: '2026-03-25',
          currencyCode: 'MVR',
          openAmount: '40.00',
          openBase: '40.00',
        },
        {
          type: 'payment',
          id: 'p2',
          number: 'PAY-00002',
          origin: null,
          date: '2026-03-15',
          currencyCode: 'MVR',
          openAmount: '30.00',
          openBase: '30.00',
        },
      ],
    },
  ],
  totals: buckets({ days1to30: '350.00', credit: '-70.00', total: '280.00' }),
};

const statement = {
  vendorId: 'va',
  vendorName: 'Atoll Supplies',
  from: '2026-03-11',
  to: '2026-03-31',
  currencies: [
    {
      currencyCode: 'MVR',
      openingBalance: '800.00',
      closingBalance: '650.00',
      lines: [
        {
          type: 'payment',
          id: 'p2',
          number: 'PAY-00002',
          origin: null,
          date: '2026-03-15',
          reference: null,
          amount: '-200.00',
          balance: '600.00',
        },
        {
          type: 'refund',
          id: 'r1',
          number: 'VR-00001',
          origin: null,
          date: '2026-03-18',
          reference: 'R-1',
          amount: '50.00',
          balance: '650.00',
        },
      ],
      openBills: [
        {
          id: 'b1',
          number: 'BILL-00001',
          dueDate: '2026-03-03',
          bucket: 'days1to30',
          openAmount: '350.00',
        },
      ],
    },
  ],
};

const reconciliation = (reconciled: boolean) => ({
  asOf: '2026-03-31',
  baseCurrency: 'MVR',
  apAccountId: 'ap',
  glBalance: '1190.00',
  revaluationAdjustments: '5.00',
  postingsOutsidePurchases: '0.00',
  subledger: {
    openBills: '1970.00',
    unappliedCredits: '-314.00',
    prepayments: '-471.00',
    total: reconciled ? '1185.00' : '1180.00',
  },
  difference: reconciled ? '0.00' : '5.00',
  reconciled,
});

const vendor = {
  id: 'va',
  partyId: 'party-1',
  kind: 'organization',
  displayName: 'Atoll Supplies',
  companyName: null,
  reference: null,
  tin: null,
  email: null,
  phone: null,
  partyStatus: 'ACTIVE',
  partyVersion: 1,
  currencyCode: 'MVR',
  paymentTermsDays: 30,
  creditLimit: null,
  accountNumber: null,
  defaultExpenseAccountId: null,
  defaultTaxCodeId: null,
  status: 'ACTIVE',
  version: 1,
  roles: ['vendor'],
  addresses: [],
  contacts: [],
};

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /approvals/requests': ok([]),
  'GET /tax/codes': ok([]),
  'GET /vendors': ok({
    items: [{ id: 'va', displayName: 'Atoll Supplies', currencyCode: 'MVR' }],
    nextCursor: null,
  }),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('AP reports', () => {
  it('shows the AP aging with drill-down to bills, debit notes and prepayments', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/aging': ok(agingReport),
    });
    renderAt('/purchases/reports');
    const nav = await screen.findByRole('navigation', { name: 'Purchases' });
    expect(within(nav).getByRole('link', { name: 'Reports' }).getAttribute('href')).toBe(
      '/purchases/reports',
    );
    const vendorButton = await screen.findByRole('button', { name: 'Atoll Supplies' });
    expect(screen.getByText(en['purchases.reports.bucket.credit'])).toBeTruthy();
    expect(screen.getByText('Amounts in MVR at historical rates')).toBeTruthy();
    expect(
      calls.some(
        (c) =>
          c.url.pathname.endsWith('/purchases/reports/aging') && c.url.searchParams.has('asOf'),
      ),
    ).toBe(true);
    await user.click(vendorButton);
    expect(screen.getByRole('link', { name: 'BILL-00001' }).getAttribute('href')).toBe(
      '/purchases/bills/b1',
    );
    expect(screen.getByText('due 2026-03-03, 28 days overdue')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Debit note DN-00001' }).getAttribute('href')).toBe(
      '/purchases/vendor-credits/dn1',
    );
    expect(screen.getByRole('link', { name: 'Payment PAY-00002' }).getAttribute('href')).toBe(
      '/purchases/payments/p2',
    );
  });

  it('shows a vendor statement with the running balance and open bills', async () => {
    const calls = stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/statement': ok(statement),
    });
    renderAt('/purchases/reports?view=statement&vendorId=va');
    expect(await screen.findByText('Atoll Supplies — MVR')).toBeTruthy();
    const request = calls.find((c) => c.url.pathname.endsWith('/purchases/reports/statement'))!;
    expect(request.url.searchParams.get('vendorId')).toBe('va');
    expect(screen.getByText('Balance brought forward')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Refund VR-00001' }).getAttribute('href')).toBe(
      '/purchases/refunds/r1',
    );
    expect(screen.getByRole('link', { name: 'Payment PAY-00002' }).getAttribute('href')).toBe(
      '/purchases/payments/p2',
    );
    expect(screen.getByText('Balance on 2026-03-31')).toBeTruthy();
    expect(screen.getByText('Open bills on 2026-03-31')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'BILL-00001' }).getAttribute('href')).toBe(
      '/purchases/bills/b1',
    );
    expect(screen.getByText(en['purchases.reports.owedNote'])).toBeTruthy();
  });

  it('shows the AP reconciliation with its reconciling items', async () => {
    const user = userEvent.setup();
    let reconciled = true;
    stubApi({
      ...common(REPORTS),
      'GET /purchases/reports/ap-reconciliation': () => ({
        status: 200,
        body: { data: reconciliation(reconciled) },
      }),
    });
    renderAt('/purchases/reports?view=reconciliation');
    expect(await screen.findByText(en['purchases.reports.reconciled'])).toBeTruthy();
    for (const label of [
      'purchases.reports.recon.openBills',
      'purchases.reports.recon.unappliedCredits',
      'purchases.reports.recon.prepayments',
      'purchases.reports.recon.revaluation',
      'purchases.reports.recon.gl',
      'purchases.reports.recon.outside',
    ] as const) {
      expect(screen.getByText(en[label])).toBeTruthy();
    }
    reconciled = false;
    await user.clear(screen.getByLabelText('As of'));
    await user.type(screen.getByLabelText('As of'), '2026-03-30');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    expect(
      await screen.findByText('The AP subledger differs from the general ledger by 5.00.'),
    ).toBeTruthy();
  });

  it('links the vendor statement from the vendor detail page', async () => {
    stubApi({ ...common(REPORTS), 'GET /vendors/va': ok(vendor) });
    renderAt('/purchases/vendors/va');
    const link = await screen.findByRole('link', { name: 'Statement' });
    expect(link.getAttribute('href')).toBe('/purchases/reports?view=statement&vendorId=va');
  });

  it('keeps the reports away from users without purchases.reports.view', async () => {
    stubApi({
      ...common(['vendors.view', 'bills.view']),
      'GET /vendors/va': ok(vendor),
      'GET /purchases/bills': ok({ items: [], nextCursor: null }),
    });
    renderAt('/purchases/reports');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
    renderAt('/purchases/vendors/va');
    const nav = await screen.findAllByRole('navigation', { name: 'Purchases' });
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { name: 'Atoll Supplies' })).toBeTruthy(),
    );
    for (const n of nav) expect(within(n).queryByRole('link', { name: 'Reports' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Statement' })).toBeNull();
  });
});
