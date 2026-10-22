import { expect, test, type Page } from '@playwright/test';
import {
  apiAs,
  configurePurchases,
  createVendor,
  postBill,
  register,
  selectByCode,
  setUpAccounting,
  trialBalanceRow,
  voidWithReason,
} from './helpers';

/**
 * Vendor credit reversals (R-05). From the services: a vendor credit can be voided only while
 * none of it is applied or refunded (P4-24); an application to a bill cannot be undone; a vendor
 * refund can be voided, which reverses its journal and returns the amount to the credit's
 * unapplied balance. Each step is checked on the screens, in the trial balance, the ledger, the
 * aging report and the audit log; a second, stale tab tries the same void again.
 */

const ZERO = '0.00';

async function postVendorCredit(
  page: Page,
  o: { vendor: string; reference: string; date: string; amount: string },
) {
  await page.goto('/purchases/vendor-credits/new');
  await page.getByLabel('Vendor').selectOption({ label: o.vendor });
  await page.getByLabel('Supplier credit-note number').fill(o.reference);
  await page.getByLabel('Credit date').fill(o.date);
  await page.getByLabel('Line 1 description').fill('Returned goods');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill(o.amount);
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/purchases\/vendor-credits\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  return page.url();
}

async function vendorCredit(page: Page, url: string) {
  const res = await apiAs(page, 'GET', `/purchases/vendor-credits/${url.split('/').pop()}`);
  expect(res.status).toBe(200);
  return JSON.parse(res.text).data as { status: string; amountUnapplied: string | null };
}

test('purchases: an unapplied vendor credit is voided and the ledger returns to zero', async ({
  page,
}) => {
  await register(page, 'Vendor Credit Void Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Credit Vendor');
  const creditUrl = await postVendorCredit(page, {
    vendor: 'Credit Vendor',
    reference: 'VC-150',
    date: '2026-06-10',
    amount: '150.00',
  });
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '150.00',
    ZERO,
    '150.00',
    ZERO,
  ]);

  await page.goto(creditUrl);
  await voidWithReason(page, 'Supplier withdrew the credit note');
  expect((await vendorCredit(page, creditUrl)).status).toBe('VOID');
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '150.00',
    '150.00',
    ZERO,
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /^5300 /)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '150.00',
    '150.00',
    ZERO,
    ZERO,
  ]);
  await expect(page.getByTestId('tb-closing-debit')).toHaveText(ZERO);

  // Two journals: the credit and its reversal.
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('300.00');

  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'vendor_credit.voided', exact: true })).toHaveCount(
    1,
  );
});

test('purchases: an applied vendor credit cannot be voided, and its voided refund returns to the credit', async ({
  page,
}) => {
  await register(page, 'Vendor Refund Reversal Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Refund Vendor');
  const billUrl = await postBill(page, {
    vendor: 'Refund Vendor',
    reference: 'SUP-800',
    date: '2026-06-05',
    amount: '800.00',
  });
  const creditUrl = await postVendorCredit(page, {
    vendor: 'Refund Vendor',
    reference: 'VC-300',
    date: '2026-06-10',
    amount: '300.00',
  });

  // 200.00 of the credit is applied to the bill.
  await page.getByLabel('Application date').fill('2026-06-10');
  await page.getByLabel(/^Apply to /).fill('200.00');
  await page.getByRole('button', { name: 'Apply credit' }).click();
  await expect
    .poll(async () => Number((await vendorCredit(page, creditUrl)).amountUnapplied))
    .toBe(100);

  // A credit that has been applied offers no void.
  await page.goto(creditUrl);
  await expect(
    page.getByText('This credit has been applied or refunded and cannot be voided.'),
  ).toBeVisible();
  await expect(page.getByLabel('Void reason')).toHaveCount(0);

  // The remaining 100.00 is refunded by the vendor into the bank.
  await page.getByRole('link', { name: 'Refund credit' }).click();
  await page.getByLabel('Refund date').fill('2026-06-12');
  await page.getByLabel('Amount refunded (MVR)').fill('100.00');
  await selectByCode(page, 'Received into', '1120');
  await page.getByRole('button', { name: 'Record refund' }).click();
  await expect(page).toHaveURL(/\/purchases\/refunds\/[0-9a-f-]{36}$/);
  const refundUrl = page.url();
  expect(Number((await vendorCredit(page, creditUrl)).amountUnapplied)).toBe(0);

  // The refund is open in a second, stale tab as well.
  const stale = await page.context().newPage();
  await stale.goto(refundUrl);
  await expect(stale.getByLabel('Void reason')).toBeVisible();

  await page.goto(refundUrl);
  await voidWithReason(page, 'Deposit was reversed by the bank');

  await stale.getByLabel('Void reason').fill('Deposit was reversed by the bank');
  await stale.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText(/already void|changed/i);
  await stale.close();

  // The refunded amount is back on the credit; the bill keeps its 600.00 payable.
  const after = await vendorCredit(page, creditUrl);
  expect(after.status).toBe('POSTED');
  expect(Number(after.amountUnapplied)).toBe(100);
  await page.goto(billUrl);
  await expect(page.getByText('600.00').first()).toBeVisible();

  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '100.00',
    '100.00',
    ZERO,
    ZERO,
  ]);
  // Payable: the bill 800.00 less the credit 300.00 is 500.00. The application posts an
  // AP-against-AP journal of 200.00 on both sides; the refund and its reversal 100.00 each.
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '600.00',
    '1,100.00',
    ZERO,
    '500.00',
  ]);

  // The aging report: the vendor owes back nothing, the bill is 600.00 open, the credit 100.00.
  await page.goto('/purchases/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  const aging = page.getByRole('row', { name: /Refund Vendor/ }).locator('td.num');
  await expect(aging.last()).toHaveText('500.00');

  // Five journals: the bill, the credit, the application, the refund and its reversal.
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('1,500.00');

  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'vendor_refund.voided', exact: true })).toHaveCount(
    1,
  );
});
