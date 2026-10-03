import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { en } from '../src/i18n/messages.en';
import { makeSession } from './fake-api';

/** Phase 4A-3: the vendor master UI (permission-aware, on the shared contact record). */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
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
const created = (data: unknown) => () => ({ status: 201, body: { data } });

const VENDOR_ALL = ['vendors.view', 'vendors.create', 'vendors.update', 'vendors.archive'];

const vendor = {
  id: 'ven-1',
  partyId: 'party-1',
  kind: 'organization',
  displayName: 'Island Supplies',
  companyName: null,
  reference: 'V-01',
  tin: null,
  email: 'ap@island.test',
  phone: null,
  partyStatus: 'ACTIVE',
  partyVersion: 2,
  currencyCode: 'MVR',
  paymentTermsDays: 15,
  creditLimit: '5000.00',
  accountNumber: 'ACC-9',
  defaultExpenseAccountId: null,
  defaultTaxCodeId: null,
  status: 'ACTIVE',
  version: 3,
  roles: ['customer', 'vendor'],
  addresses: [],
  contacts: [],
};

const common = (permissions: string[]): Record<string, Handler> => ({
  'GET /auth/session': ok(makeSession({ permissions })),
  'GET /tax/codes': ok([]),
});

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('Purchases navigation', () => {
  it('shows Purchases only to users who can view vendors', async () => {
    stubApi(common(['organization.read']));
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Purchases')).toBeNull();
  });

  it('lists vendors in a left-to-right English region, without create for view-only users', async () => {
    stubApi({
      ...common(['vendors.view']),
      'GET /vendors': ok({ items: [vendor], nextCursor: null }),
    });
    renderAt('/purchases');
    expect(await screen.findByRole('link', { name: 'Island Supplies' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('Purchases')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New vendor' })).toBeNull();
    const sub = screen.getByRole('navigation', { name: 'Purchases' });
    expect(sub.closest('[dir]')?.getAttribute('dir')).toBe('ltr');
  });

  it('blocks the create page without vendors.create', async () => {
    stubApi(common(['vendors.view']));
    renderAt('/purchases/vendors/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });
});

describe('creating vendors', () => {
  it('creates a vendor with a new contact and opens it', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common([...VENDOR_ALL, 'parties.view']),
      'POST /vendors': created(vendor),
      'GET /vendors/ven-1': ok(vendor),
    });
    renderAt('/purchases/vendors/new');
    await user.type(await screen.findByLabelText('Name'), 'Island Supplies');
    await user.type(screen.getByLabelText('Payment terms (days)'), '15');
    await user.type(screen.getByLabelText('Our account number'), 'ACC-9');
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    expect(await screen.findByRole('heading', { name: 'Island Supplies' })).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/vendors'))!;
    expect(post.body).toEqual({
      party: {
        kind: 'organization',
        displayName: 'Island Supplies',
        reference: null,
        email: null,
        tin: null,
      },
      paymentTermsDays: 15,
      creditLimit: null,
      accountNumber: 'ACC-9',
      defaultExpenseAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxRecoverable: null,
    });
    expect(screen.getByText(en['purchases.vendors.alsoCustomer'])).toBeTruthy();
  });

  it('makes an existing contact (e.g. a customer) a vendor', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common([...VENDOR_ALL, 'parties.view']),
      'GET /parties': ok({
        items: [
          {
            id: 'party-1',
            kind: 'organization',
            displayName: 'Island Supplies',
            companyName: null,
            reference: null,
            tin: null,
            email: null,
            phone: null,
            status: 'ACTIVE',
            roles: ['customer'],
            version: 1,
          },
        ],
        nextCursor: null,
      }),
      'POST /vendors': created(vendor),
      'GET /vendors/ven-1': ok(vendor),
    });
    renderAt('/purchases/vendors/new');
    await user.click(await screen.findByLabelText(en['purchases.vendors.sourceExisting']));
    await screen.findByRole('option', { name: 'Island Supplies (customer)' });
    await user.selectOptions(screen.getByLabelText('Contact'), 'party-1');
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    expect(await screen.findByRole('heading', { name: 'Island Supplies' })).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/vendors'))!;
    expect(post.body).toMatchObject({ partyId: 'party-1' });
    expect(post.body).not.toHaveProperty('party');
  });
});

describe('vendor detail', () => {
  it('archives with the version and shows the archived note', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(VENDOR_ALL),
      'GET /vendors/ven-1': ok(vendor),
      'POST /vendors/ven-1/archive': ok({
        ...vendor,
        status: 'ARCHIVED',
        version: 4,
        archivedAt: '2026-10-01T00:00:00Z',
      }),
    });
    renderAt('/purchases/vendors/ven-1');
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText(en['purchases.vendors.archivedNote'])).toBeTruthy();
    const archive = calls.find((c) => c.url.pathname.endsWith('/archive'))!;
    expect(archive.body).toEqual({ version: 3 });
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
  });

  it('is read-only without vendors.update and vendors.archive', async () => {
    stubApi({ ...common(['vendors.view']), 'GET /vendors/ven-1': ok(vendor) });
    renderAt('/purchases/vendors/ven-1');
    expect(await screen.findByRole('heading', { name: 'Island Supplies' })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Payment terms (days)')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
  });

  it('saves terms and identity with both versions', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(VENDOR_ALL),
      'GET /vendors/ven-1': ok(vendor),
      'PATCH /vendors/ven-1': ok({ ...vendor, paymentTermsDays: 30, version: 4, warnings: [] }),
    });
    renderAt('/purchases/vendors/ven-1');
    const terms = await screen.findByLabelText('Payment terms (days)');
    await user.clear(terms);
    await user.type(terms, '30');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({
      version: 3,
      paymentTermsDays: 30,
      creditLimit: '5000.00',
      accountNumber: 'ACC-9',
      party: { version: 2, displayName: 'Island Supplies', email: 'ap@island.test' },
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 4A-4: Purchases settings and the shared catalog's purchase side
// ---------------------------------------------------------------------------

const account = (
  id: string,
  code: string,
  name: string,
  type: string,
  subtype: string | null,
  extra: object = {},
) => ({
  id,
  code,
  name,
  description: '',
  type,
  parentId: null,
  status: 'ACTIVE',
  isSystem: false,
  isLeaf: true,
  usedInPostedJournals: false,
  currencyCode: 'MVR',
  subtype,
  isMonetary: true,
  isControlAccount: false,
  controlSubledger: null,
  isBankOrCash: subtype === 'BANK' || subtype === 'CASH',
  ...extra,
});

const accountList = [
  account('acc-bank', '1120', 'Bank Accounts', 'ASSET', 'BANK'),
  account('acc-ar', '1130', 'Accounts Receivable', 'ASSET', 'ACCOUNTS_RECEIVABLE', {
    isControlAccount: true,
    controlSubledger: 'sales',
  }),
  account('acc-ap', '2110', 'Accounts Payable', 'LIABILITY', 'ACCOUNTS_PAYABLE'),
  account('acc-card', '2140', 'Corporate Card', 'LIABILITY', 'CREDIT_CARD'),
  account('acc-util', '5400', 'Utilities', 'EXPENSE', 'OPERATING_EXPENSE'),
  account('acc-rev', '4100', 'Sales Revenue', 'REVENUE', 'OPERATING_REVENUE'),
];

const numbering = (prefix: string) => ({
  prefix,
  minDigits: 5,
  nextNumber: 1,
  preview: `${prefix}00001`,
});
const unconfigured = {
  configured: false,
  version: 0,
  apAccountId: null,
  defaultExpenseAccountId: null,
  defaultPaymentAccountId: null,
  defaultTaxCodeId: null,
  defaultTaxTreatment: 'exclusive',
  defaultPaymentTermsDays: 30,
  apLocked: false,
  suggestedApAccountId: 'acc-ap',
  numbering: {
    bill: numbering('BILL-'),
    vendor_credit: numbering('VC-'),
    debit_note: numbering('DN-'),
    vendor_payment: numbering('PAY-'),
    vendor_refund: numbering('VR-'),
    expense: numbering('EXP-'),
  },
};

describe('Purchases settings (P4-07, P4-51)', () => {
  it('shows Purchases and its settings link to holders of purchases.settings.manage', async () => {
    stubApi({
      ...common(['purchases.settings.manage', 'accounting.accounts.view']),
      'GET /purchases/settings': ok(unconfigured),
      'GET /accounting/accounts': ok(accountList),
    });
    renderAt('/purchases');
    expect(await screen.findByRole('heading', { name: 'Purchases settings' })).toBeTruthy();
    const sub = screen.getByRole('navigation', { name: 'Purchases' });
    expect(within(sub).getByRole('link', { name: 'Settings' })).toBeTruthy();
    expect(within(sub).queryByRole('link', { name: 'Vendors' })).toBeNull();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByText('Purchases')).toBeTruthy();
  });

  it('blocks the settings page without purchases.settings.manage', async () => {
    stubApi(common(['vendors.view']));
    renderAt('/purchases/settings');
    expect(await screen.findByText('You do not have access to this page.')).toBeTruthy();
  });

  it('proposes the AP account, previews numbering and saves with the version', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(['purchases.settings.manage', 'accounting.accounts.view']),
      'GET /purchases/settings': ok(unconfigured),
      'GET /accounting/accounts': ok(accountList),
      'PUT /purchases/settings': ok({ ...unconfigured, configured: true, version: 1 }),
    });
    renderAt('/purchases/settings');
    const ap = (await screen.findByLabelText(
      'Accounts payable (AP) control account',
    )) as HTMLSelectElement;
    await waitFor(() => expect(ap.value).toBe('acc-ap'));
    // The Sales-owned AR account is never offered for AP; payment accounts include cards.
    expect(within(ap).queryByRole('option', { name: /Accounts Receivable/ })).toBeNull();
    const payment = screen.getByLabelText('Default payment account');
    expect(within(payment).getByRole('option', { name: /Corporate Card/ })).toBeTruthy();
    expect(within(payment).queryByRole('option', { name: /Utilities/ })).toBeNull();
    await user.selectOptions(payment, 'acc-card');
    await user.selectOptions(screen.getByLabelText('Default expense account'), 'acc-util');
    const prefix = screen.getByLabelText('Bill prefix');
    await user.clear(prefix);
    await user.type(prefix, 'PB/');
    expect(screen.getByText('PB/00001')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      version: 0,
      apAccountId: 'acc-ap',
      defaultExpenseAccountId: 'acc-util',
      defaultPaymentAccountId: 'acc-card',
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
      numbering: {
        bill: { prefix: 'PB/', minDigits: 5, nextNumber: 1 },
        expense: { prefix: 'EXP-', minDigits: 5, nextNumber: 1 },
      },
    });
  });

  it('disables the AP account once it is locked', async () => {
    stubApi({
      ...common(['purchases.settings.manage', 'accounting.accounts.view']),
      'GET /purchases/settings': ok({
        ...unconfigured,
        configured: true,
        version: 3,
        apAccountId: 'acc-ap',
        apLocked: true,
        suggestedApAccountId: null,
      }),
      'GET /accounting/accounts': ok(accountList),
    });
    renderAt('/purchases/settings');
    const ap = await screen.findByLabelText('Accounts payable (AP) control account');
    expect(ap).toHaveProperty('disabled', true);
    expect(screen.getByText(en['purchases.settings.apLocked'])).toBeTruthy();
  });
});

describe('catalog purchase fields (P4-05, P4-06)', () => {
  const item = {
    id: 'item-1',
    sku: null,
    name: 'Printer paper',
    itemType: 'product',
    description: '',
    unitPrice: null,
    revenueAccountId: null,
    taxCodeId: null,
    isSold: false,
    isPurchased: true,
    purchaseDescription: 'A4 box',
    purchaseUnitCost: '42.50',
    expenseAccountId: 'acc-util',
    purchaseTaxCodeId: null,
    status: 'ACTIVE',
    version: 1,
  };

  it('lets catalog.items.manage create a purchased item with purchase defaults', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(['catalog.items.manage', 'accounting.accounts.view']),
      'GET /sales/items': ok({ items: [item], nextCursor: null }),
      'GET /accounting/accounts': ok(accountList),
      'POST /sales/items': created({ ...item, id: 'item-2', name: 'Diesel' }),
    });
    renderAt('/purchases');
    // A catalog-only user lands on the shared items page.
    expect(await screen.findByRole('heading', { name: 'Items' })).toBeTruthy();
    expect(await screen.findByText('Purchased')).toBeTruthy();
    await user.type(screen.getByLabelText('Name'), 'Diesel');
    await user.click(screen.getByLabelText('I sell this item'));
    await user.click(screen.getByLabelText('I buy this item'));
    await user.type(screen.getByLabelText('Purchase cost'), '12.5');
    const expense = screen.getByLabelText('Expense account');
    await waitFor(() =>
      expect(within(expense).getByRole('option', { name: /Utilities/ })).toBeTruthy(),
    );
    expect(within(expense).queryByRole('option', { name: /Bank Accounts/ })).toBeNull();
    await user.selectOptions(expense, 'acc-util');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      name: 'Diesel',
      isSold: false,
      isPurchased: true,
      purchaseUnitCost: '12.5',
      expenseAccountId: 'acc-util',
      purchaseTaxCodeId: null,
      purchaseDescription: '',
    });
  });

  it('keeps the items page read-only for invoices.view', async () => {
    stubApi({
      ...common(['invoices.view']),
      'GET /sales/items': ok({ items: [item], nextCursor: null }),
    });
    renderAt('/sales/items');
    expect(await screen.findByText('Printer paper')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create item' })).toBeNull();
  });

  it('sends the item tax recoverability default (P4-12)', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(['catalog.items.manage']),
      'GET /sales/items': ok({ items: [], nextCursor: null }),
      'POST /sales/items': created({ ...item, purchaseTaxRecoverable: false }),
    });
    renderAt('/sales/items');
    await user.type(await screen.findByLabelText('Name'), 'Diesel');
    await user.click(screen.getByLabelText('I buy this item'));
    await user.selectOptions(screen.getByLabelText('Tax recoverable by default'), 'false');
    await user.click(screen.getByRole('button', { name: 'Create item' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      isPurchased: true,
      purchaseTaxRecoverable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Input-tax stage (P4-11, P4-12, P4-13)
// ---------------------------------------------------------------------------

describe('input tax (P4-11, P4-12)', () => {
  const gst = {
    id: 'tax-gst',
    code: 'GST',
    name: 'General GST',
    description: '',
    taxAccountId: 'acc-gst-out',
    inputTaxAccountId: null,
    status: 'ACTIVE',
    version: 4,
    systemSeeded: true,
    rates: [{ id: 'r1', rate: '8.0000', effectiveFrom: '2023-01-01', verificationNote: null }],
  };
  const inputAccount = account(
    'acc-1160',
    '1160',
    'GST Input Tax Recoverable',
    'ASSET',
    'OTHER_CURRENT_ASSET',
  );

  it('shows an unmapped input tax account and maps it with the code version', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(['tax.codes.manage', 'accounting.accounts.view']),
      'GET /tax/codes': ok([gst]),
      'GET /accounting/accounts': ok([...accountList, inputAccount]),
      'PATCH /tax/codes/tax-gst': ok({ ...gst, inputTaxAccountId: 'acc-1160', version: 5 }),
    });
    renderAt('/sales/tax-codes');
    expect(
      await screen.findByText(/Not set: this code cannot be used on purchases yet/),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Set input tax account' }));
    const select = screen.getByLabelText('Input tax account for GST');
    // Only asset accounts are offered; liabilities and expenses are not.
    expect(within(select).queryByRole('option', { name: /Accounts Payable/ })).toBeNull();
    expect(within(select).queryByRole('option', { name: /Utilities/ })).toBeNull();
    await user.selectOptions(select, 'acc-1160');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({
      version: 4,
      inputTaxAccountId: 'acc-1160',
    });
  });

  it('sends the vendor tax recoverability default', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...common(VENDOR_ALL),
      'POST /vendors': created({ ...vendor, defaultTaxRecoverable: false }),
      'GET /vendors/ven-1': ok({ ...vendor, defaultTaxRecoverable: false }),
    });
    renderAt('/purchases/vendors/new');
    await user.type(await screen.findByLabelText('Name'), 'Island Supplies');
    await user.selectOptions(screen.getByLabelText('Tax recoverable by default'), 'false');
    await user.click(screen.getByRole('button', { name: 'Create vendor' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      defaultTaxRecoverable: false,
    });
    expect(
      ((await screen.findByLabelText('Tax recoverable by default')) as HTMLSelectElement).value,
    ).toBe('false');
  });
});
