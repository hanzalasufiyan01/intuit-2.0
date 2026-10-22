import { expect, type Page } from '@playwright/test';
import { totp } from './totp';

export const PASSWORD = 'correct horse battery staple 42';

export function uniqueEmail() {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

/** Registers an owner and completes the two-step verification the owner role requires. */
export async function register(page: Page, organization = 'E2E Trading Pvt Ltd') {
  const email = uniqueEmail();
  await page.goto('/register');
  await page.getByLabel('Your name').fill('Aisha Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Organization name').fill(organization);
  await page.getByRole('button', { name: 'Create account' }).click();

  // The owner must enrol an authenticator before anything else is available.
  await page.getByRole('button', { name: 'Set up two-step verification' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm your password' });
  if (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await dialog.getByLabel('Password').fill(PASSWORD);
    await dialog.getByRole('button', { name: /confirm|continue/i }).click();
  }
  await page.getByText('Can’t scan it? Enter the key instead').click();
  const secret = ((await page.getByLabel('Setup key').textContent()) ?? '').replace(/\s/g, '');
  expect(secret.length).toBeGreaterThanOrEqual(16);
  await page.getByLabel('Enter the six-digit code from the app').fill(totp(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByRole('button', { name: /done|continue|finish/i }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Members' })).toBeVisible();
  return { email, secret };
}

/** Sets up accounting (Maldives chart, MVR base currency) and one calendar fiscal year. */
export async function setUpAccounting(page: Page, year = 2026) {
  await page.goto('/accounting/setup');
  await page.getByRole('radio', { name: /Maldives/ }).check();
  await page.getByRole('button', { name: 'Set up accounting' }).click();
  await expect(page.getByText('Settings', { exact: true }).first()).toBeVisible();
  await page.goto('/accounting/fiscal-years');
  await page.getByLabel('Name').fill(`FY${year}`);
  await page.getByLabel('Start').fill(`${year}-01-01`);
  await page.getByLabel('End').fill(`${year}-12-31`);
  await page.getByRole('button', { name: 'Create with monthly periods' }).click();
  await expect(page.getByText(`FY${year}`).first()).toBeVisible();
}

/** Chooses a journal line's account by chart code, whatever the account is called. */
export async function pickAccount(page: Page, line: number, code: string) {
  const select = page.getByLabel(`Line ${line} account`);
  const value = await select
    .locator('option')
    .filter({ hasText: new RegExp('^' + code) })
    .first()
    .getAttribute('value');
  expect(value, `account ${code} in the chart`).toBeTruthy();
  await select.selectOption(value!);
}

/** Chooses an option of a labelled select by the chart code at the start of its text. */
export async function selectByCode(page: Page, label: string, code: string) {
  const select = page.getByLabel(label, { exact: true });
  const value = await select
    .locator('option')
    .filter({ hasText: new RegExp('^' + code) })
    .first()
    .getAttribute('value');
  expect(value, `account ${code} offered for "${label}"`).toBeTruthy();
  await select.selectOption(value!);
}

/** Names the AR, revenue and deposit accounts Sales needs before an invoice can be issued. */
export async function configureSales(page: Page) {
  await page.goto('/sales/settings');
  await selectByCode(page, 'Accounts receivable control account', '1130');
  await selectByCode(page, 'Revenue account', '4100');
  await selectByCode(page, 'Deposit to', '1120');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();
}

/** Names the AP, expense and payment accounts Purchases needs before a bill can be posted. */
export async function configurePurchases(page: Page) {
  await page.goto('/purchases/settings');
  await selectByCode(page, 'Accounts payable (AP) control account', '2110');
  await selectByCode(page, 'Default expense account', '5300');
  await selectByCode(page, 'Default payment account', '1120');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled();
}

export async function createCustomer(page: Page, name: string) {
  await page.goto('/sales/customers/new');
  await page.getByLabel('Name').first().fill(name);
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText(name).first()).toBeVisible();
  return page.url();
}

export async function createVendor(page: Page, name: string) {
  await page.goto('/purchases/vendors/new');
  await page.getByLabel('Name').first().fill(name);
  await page.getByRole('button', { name: 'Create vendor' }).click();
  await expect(page.getByText(name).first()).toBeVisible();
}

/** Drafts and issues a one-line invoice; returns its URL. */
export async function issueInvoice(
  page: Page,
  o: { customer: string; date: string; due?: string; amount: string; description?: string },
) {
  await page.goto('/sales/invoices/new');
  await page.getByLabel('Customer').selectOption({ label: o.customer });
  await page.getByLabel('Invoice date').fill(o.date);
  if (o.due) await page.getByLabel('Due date').fill(o.due);
  await page.getByLabel('Line 1 description').fill(o.description ?? 'Consulting');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill(o.amount);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Issued', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page.url();
}

/** Drafts and issues a one-line credit note not linked to an invoice; returns its URL. */
export async function issueCreditNote(
  page: Page,
  o: { customer: string; date: string; amount: string },
) {
  await page.goto('/sales/credit-notes/new');
  await page.getByLabel('Customer').selectOption({ label: o.customer });
  await page.getByLabel('Credit date').fill(o.date);
  await page.getByLabel('Credited invoice').selectOption({ label: 'Not linked to an invoice' });
  await page.getByLabel('Line 1 description').fill('Goodwill credit');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill(o.amount);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/sales\/credit-notes\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Issue', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and issue' }).click();
  await expect(page.getByText('Issued', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page.url();
}

/** Records a customer refund of an issued credit note's unapplied amount; returns its URL. */
export async function refundCreditNote(
  page: Page,
  o: { creditUrl: string; date: string; amount: string },
) {
  await page.goto(o.creditUrl);
  await page.getByRole('link', { name: 'Refund credit' }).click();
  await page.getByLabel('Refund date').fill(o.date);
  await page.getByLabel('Amount (MVR)').fill(o.amount);
  await page.getByRole('button', { name: 'Record refund' }).click();
  await expect(page).toHaveURL(/\/sales\/refunds\/[0-9a-f-]{36}$/);
  return page.url();
}

/** Drafts and posts a one-line bill; returns its URL. */
export async function postBill(
  page: Page,
  o: { vendor: string; reference: string; date: string; due?: string; amount: string },
) {
  await page.goto('/purchases/bills/new');
  await page.getByLabel('Vendor').selectOption({ label: o.vendor });
  await page.getByLabel('Supplier invoice number').fill(o.reference);
  await page.getByLabel('Bill date').fill(o.date);
  if (o.due) await page.getByLabel('Due date').fill(o.due);
  await page.getByLabel('Line 1 description').fill('Office rent');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill(o.amount);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page.url();
}

/** Records a customer receipt, allocating `allocate` to the customer's only open invoice. */
export async function recordReceipt(
  page: Page,
  o: { customer: string; date: string; amount: string; allocate: string },
) {
  await page.goto('/sales/receipts/new');
  await page.getByLabel('Customer').selectOption({ label: o.customer });
  await page.getByLabel('Date').fill(o.date);
  await page.getByLabel('Amount received').fill(o.amount);
  await page.getByLabel(/^Amount to allocate to /).fill(o.allocate);
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page).toHaveURL(/\/sales\/receipts\/[0-9a-f-]{36}$/);
  return page.url();
}

/** Drafts and records a vendor payment, allocating `allocate` to the vendor's only open bill. */
export async function recordVendorPayment(
  page: Page,
  o: { vendor: string; date: string; amount: string; allocate: string },
) {
  await page.goto('/purchases/payments/new');
  await page.getByLabel('Vendor').selectOption({ label: o.vendor });
  await page.getByLabel('Payment date').fill(o.date);
  await page.getByLabel('Amount paid').fill(o.amount);
  await page.getByLabel(/^Pay on /).fill(o.allocate);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/purchases\/payments\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Recorded', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  return page.url();
}

/** The six amount cells (opening Dr/Cr, period Dr/Cr, closing Dr/Cr) of a trial balance row. */
export async function trialBalanceRow(page: Page, account: RegExp) {
  await page.goto('/accounting/reports/trial-balance');
  const row = page.getByRole('row', { name: account });
  await expect(row).toHaveCount(1);
  return row.locator('td.num');
}

/** Voids the open document on the current page through its "Void reason" form. */
export async function voidWithReason(page: Page, reason: string) {
  await page.getByLabel('Void reason').fill(reason);
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(page.getByLabel('Void reason')).toHaveCount(0, { timeout: 20_000 });
}

/** Sends a request as the signed-in user of this page, with the session's own CSRF token. */
export async function apiAs(page: Page, method: 'GET' | 'POST', path: string, body?: unknown) {
  return page.evaluate(
    async ([m, p, b]) => {
      const session = await (
        await fetch('/api/v1/auth/session', { credentials: 'include' })
      ).json();
      const response = await fetch(`/api/v1${p as string}`, {
        method: m as string,
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': session.data.csrfToken,
        },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      return { status: response.status, text: await response.text() };
    },
    [method, path, body] as [string, string, unknown],
  );
}
