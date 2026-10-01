import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { en } from '../src/i18n/messages.en';
import { translate } from '../src/i18n/i18n';
import { makeSession } from './fake-api';

/** Phase 3B step 20: the Sales UI (permission-aware screens, lifecycle actions, reports, i18n). */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body, headers: (init.headers ?? {}) as Record<string, string> });
      const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url, body)
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
const fail = (status: number, code: string, message: string) => () => ({
  status,
  body: { error: { code, message, requestId: 'r' } },
});

const SALES_ALL = [
  'customers.view',
  'customers.create',
  'invoices.view',
  'invoices.create',
  'invoices.edit_draft',
  'invoices.issue',
  'invoices.void',
  'credit_notes.view',
  'credit_notes.create',
  'receipts.view',
  'receipts.create',
  'sales.reports.view',
  'sales.settings.manage',
  'tax.codes.manage',
];

const settings = {
  configured: true,
  version: 2,
  arAccountId: 'ar',
  defaultRevenueAccountId: null,
  defaultDepositAccountId: null,
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive',
  defaultPaymentTermsDays: 30,
  arLocked: true,
  suggestedArAccountId: null,
  numbering: {
    invoice: { prefix: 'INV-', minDigits: 5, nextNumber: 12, preview: 'INV-00012' },
    credit_note: { prefix: 'CN-', minDigits: 5, nextNumber: 1, preview: 'CN-00001' },
    receipt: { prefix: 'RCT-', minDigits: 5, nextNumber: 3, preview: 'RCT-00003' },
  },
};

const approval = {
  required: false,
  requestId: null,
  requestStatus: null,
  facts: null,
  appliedSteps: [],
  readyToIssue: true,
  approvalOutdated: false,
};

const draftInvoice = {
  id: 'inv-1',
  kind: 'standard',
  status: 'DRAFT',
  number: null,
  customerId: 'cust-1',
  customerName: 'Blue Lagoon Traders',
  invoiceDate: '2026-09-30',
  dueDate: '2026-10-30',
  currencyCode: 'MVR',
  reference: null,
  subtotal: '1000.00',
  discountTotal: '0.00',
  taxTotal: '80.00',
  total: '1080.00',
  amountDue: null,
  baseTotal: null,
  baseDue: null,
  version: 4,
  paymentTermsDays: 30,
  openingBaseTotal: null,
  exchangeRate: null,
  exchangeRateSource: null,
  taxTreatment: 'exclusive',
  discount: null,
  memo: '',
  dimensionValueIds: [],
  journalId: null,
  voidReason: null,
  baseCurrency: 'MVR',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: null,
      description: 'Consulting',
      quantity: '1',
      unitPrice: '1000.00',
      discount: null,
      amount: '1000.00',
      lineDiscount: '0.00',
      documentDiscount: '0.00',
      netAmount: '1000.00',
      taxCodeId: 'gst',
      taxRate: '8',
      taxAmount: '80.00',
      total: '1080.00',
      revenueAccountId: null,
      dimensionValueIds: [],
    },
  ],
  allocations: [],
  approval,
  warnings: [],
};

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /sales/settings': ok(settings),
  'GET /tax/codes': ok([]),
  'GET /files': ok([]),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('i18n catalog', () => {
  it('formats parameters and leaves unknown placeholders intact', () => {
    expect(translate('en', 'sales.invoices.titleNumber', { number: 'INV-00012' })).toBe(
      'Invoice INV-00012',
    );
    expect(translate('en', 'sales.editor.customerCurrency')).toBe(
      en['sales.editor.customerCurrency'],
    );
    expect(translate('xx', 'common.save')).toBe('Save');
  });

  it('has no empty messages', () => {
    for (const [key, value] of Object.entries(en)) expect(value.trim(), key).not.toBe('');
  });
});

describe('Sales navigation', () => {
  it('shows the Sales link only to users with a Sales permission', async () => {
    stubApi(common(['organization.read']));
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Sales')).toBeNull();
  });

  it('shows only the sections the user may view, in a left-to-right English region', async () => {
    stubApi({
      ...common(['invoices.view']),
      'GET /sales/invoices': ok({ items: [], nextCursor: null }),
    });
    renderAt('/sales/invoices');
    expect(await screen.findByText('No invoices found.')).toBeTruthy();
    const sub = screen.getByRole('navigation', { name: 'Sales' });
    expect(within(sub).getByText('Invoices')).toBeTruthy();
    expect(within(sub).queryByText('Receipts')).toBeNull();
    expect(within(sub).queryByText('Reports')).toBeNull();
    expect(screen.queryByRole('link', { name: 'New invoice' })).toBeNull();
    expect(sub.closest('[dir]')?.getAttribute('dir')).toBe('ltr');
  });

  it('blocks a page the user lacks permission for', async () => {
    stubApi(common(['invoices.view']));
    renderAt('/sales/receipts/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });
});

describe('invoice lifecycle', () => {
  it('issues a ready draft with its version and shows a period hint on failure', async () => {
    const user = userEvent.setup();
    let issued = false;
    const calls = stubApi({
      ...common(SALES_ALL),
      'GET /sales/invoices/inv-1': ok(draftInvoice),
      'POST /sales/invoices/inv-1/issue': () =>
        issued
          ? ok({
              ...draftInvoice,
              status: 'ISSUED',
              number: 'INV-00012',
              amountDue: '1080.00',
              version: 5,
            })()
          : ((issued = true), fail(409, 'PERIOD_CLOSED', 'The period for 2026-09-30 is closed.')()),
    });
    renderAt('/sales/invoices/inv-1');
    expect(await screen.findByRole('heading', { name: 'Draft invoice' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await screen.findByText(en['sales.error.period'])).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Issue' }));
    expect(await screen.findByRole('heading', { name: 'Invoice INV-00012' })).toBeTruthy();
    const issues = calls.filter((c) => c.url.pathname.endsWith('/issue'));
    expect(issues).toHaveLength(2);
    expect(issues[0]!.body).toEqual({ version: 4 });
  });

  it('hides lifecycle actions from a view-only user', async () => {
    stubApi({ ...common(['invoices.view']), 'GET /sales/invoices/inv-1': ok(draftInvoice) });
    renderAt('/sales/invoices/inv-1');
    expect(await screen.findByRole('heading', { name: 'Draft invoice' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

describe('record receipt', () => {
  it('allocates in full, sends an idempotency key and opens the receipt', async () => {
    const user = userEvent.setup();
    const issuedInvoice = {
      ...draftInvoice,
      status: 'ISSUED',
      number: 'INV-00012',
      amountDue: '1080.00',
    };
    const calls = stubApi({
      ...common(SALES_ALL),
      'GET /customers': ok({
        items: [
          {
            id: 'cust-1',
            partyId: 'p1',
            kind: 'organization',
            displayName: 'Blue Lagoon Traders',
            companyName: null,
            reference: null,
            tin: null,
            email: null,
            phone: null,
            partyStatus: 'ACTIVE',
            partyVersion: 1,
            currencyCode: 'MVR',
            paymentTermsDays: null,
            creditLimit: null,
            status: 'ACTIVE',
            version: 1,
          },
        ],
        nextCursor: null,
      }),
      'GET /sales/invoices': ok({ items: [issuedInvoice], nextCursor: null }),
      'POST /sales/receipts': ok({ id: 'rc-1' }),
      'GET /sales/receipts/rc-1': ok({
        id: 'rc-1',
        status: 'RECORDED',
        number: 'RCT-00003',
        customerId: 'cust-1',
        customerName: 'Blue Lagoon Traders',
        receiptDate: '2026-10-01',
        currencyCode: 'MVR',
        amount: '1080.00',
        exchangeRate: '1',
        exchangeRateSource: 'base',
        tableRate: null,
        rateOverrideReason: null,
        depositAccountId: 'bank',
        depositAccountOverridden: false,
        baseAmount: '1080.00',
        amountUnallocated: '0.00',
        reference: null,
        memo: '',
        journalId: 'j1',
        voidReason: null,
        version: 1,
        allocations: [],
      }),
    });
    renderAt('/sales/receipts/new');
    await screen.findByRole('option', { name: 'Blue Lagoon Traders' });
    await user.selectOptions(screen.getByLabelText('Customer'), 'cust-1');
    await user.type(screen.getByLabelText('Amount received'), '1000');
    await user.click(await screen.findByRole('button', { name: 'Full' }));
    expect(await screen.findByText(en['sales.receipts.overAllocated'])).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record receipt' })).toHaveProperty('disabled', true);
    await user.clear(screen.getByLabelText('Amount received'));
    await user.type(screen.getByLabelText('Amount received'), '1080');
    await user.click(screen.getByRole('button', { name: 'Record receipt' }));
    expect(await screen.findByRole('heading', { name: 'Receipt RCT-00003' })).toBeTruthy();
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.pathname.endsWith('/sales/receipts'),
    )!;
    expect(post.body).toMatchObject({
      customerId: 'cust-1',
      amount: '1080',
      allocations: [{ invoiceId: 'inv-1', amount: '1080.00' }],
    });
    expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Sales settings', () => {
  it('is read-only without sales.settings.manage', async () => {
    stubApi(common(['invoices.view']));
    renderAt('/sales/settings');
    expect(await screen.findByText(en['sales.settings.readOnly'])).toBeTruthy();
    expect(screen.getByLabelText('Invoice prefix')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('saves numbering with numbers and shows a field error from the server', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(SALES_ALL),
      'GET /accounting/accounts': ok([]),
      'PUT /sales/settings': () => ({
        status: 400,
        body: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid input.',
            requestId: 'r',
            details: {
              issues: [
                {
                  path: 'numbering.invoice.nextNumber',
                  message: 'The next number cannot be lower than 12.',
                },
              ],
            },
          },
        },
      }),
    });
    renderAt('/sales/settings');
    const next = await screen.findByLabelText('Invoice next number');
    await user.clear(next);
    await user.type(next, '5');
    expect(screen.getByText('INV-00005')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('The next number cannot be lower than 12.')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      version: 2,
      arAccountId: 'ar',
      defaultPaymentTermsDays: 30,
      numbering: { invoice: { prefix: 'INV-', minDigits: 5, nextNumber: 5 } },
    });
  });
});

describe('Sales reports', () => {
  it('renders the aging by bucket and the reconciliation status', async () => {
    const user = userEvent.setup();
    const zero = {
      current: '0.00',
      days1to30: '0.00',
      days31to60: '0.00',
      days61to90: '0.00',
      over90: '0.00',
    };
    stubApi({
      ...common(SALES_ALL),
      'GET /sales/reports/aging': (url) =>
        ok({
          asOf: url.searchParams.get('asOf'),
          baseCurrency: 'MVR',
          buckets: [],
          customers: [
            {
              customerId: 'cust-1',
              customerName: 'Blue Lagoon Traders',
              currencies: [],
              base: { ...zero, days31to60: '1080.00', credit: '-80.00', total: '1000.00' },
              invoices: [
                {
                  id: 'inv-1',
                  number: 'INV-00012',
                  dueDate: '2026-08-15',
                  daysOverdue: 47,
                  bucket: 'days31to60',
                  currencyCode: 'MVR',
                  openAmount: '1080.00',
                  openBase: '1080.00',
                },
              ],
              credits: [],
            },
          ],
          totals: { ...zero, days31to60: '1080.00', credit: '-80.00', total: '1000.00' },
        })(),
      'GET /sales/reports/ar-reconciliation': ok({
        asOf: '2026-10-01',
        baseCurrency: 'MVR',
        arAccountId: 'ar',
        glBalance: '1000.00',
        revaluationAdjustments: '0.00',
        postingsOutsideSales: '0.00',
        subledger: { openInvoices: '1080.00', unappliedCredit: '-80.00', total: '1000.00' },
        difference: '0.00',
        reconciled: true,
      }),
    });
    renderAt('/sales/reports');
    const customer = await screen.findByRole('button', { name: 'Blue Lagoon Traders' });
    expect(screen.getAllByText('1,080.00').length).toBeGreaterThan(0);
    await user.click(customer);
    expect(screen.getByRole('link', { name: 'INV-00012' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'AR reconciliation' }));
    expect(await screen.findByText(en['sales.reports.reconciled'])).toBeTruthy();
  });
});

describe('Sales search', () => {
  it('needs two characters and links to matching documents', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(SALES_ALL),
      'GET /sales/search': (url) =>
        ok({
          q: url.searchParams.get('q'),
          customers: [],
          invoices: [
            {
              id: 'inv-1',
              number: 'INV-00012',
              status: 'ISSUED',
              invoiceDate: '2026-09-30',
              customerName: 'Blue Lagoon Traders',
              currencyCode: 'MVR',
              total: '1080.00',
              amountDue: '1080.00',
            },
          ],
          creditNotes: [],
          receipts: [],
          items: [],
        })(),
    });
    renderAt('/sales');
    const box = await screen.findByLabelText('Search sales');
    await user.type(box, 'I');
    expect(screen.getByRole('button', { name: 'Search' })).toHaveProperty('disabled', true);
    await user.type(box, 'NV');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByRole('link', { name: 'INV-00012' })).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.url.pathname.endsWith('/sales/search') && c.url.searchParams.get('q') === 'INV',
        ),
      ).toBe(true),
    );
  });
});
