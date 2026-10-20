import { expect, test } from '@playwright/test';
import {
  apiAs,
  configurePurchases,
  configureSales,
  createCustomer,
  createVendor,
  issueInvoice,
  postBill,
  recordReceipt,
  recordVendorPayment,
  register,
  setUpAccounting,
  trialBalanceRow,
  voidWithReason,
} from './helpers';

/**
 * Reversal journeys (R-05). The rules, from the services: an invoice or bill with a payment or
 * credit applied cannot be voided (the screen says so and offers no form); the supported path is
 * to void the receipt or vendor payment first, which reverses its journal and its allocations and
 * restores the open balance, and then void the document. Each step is checked in the ledger, the
 * trial balance, the open-item report and the audit log, and a second, stale tab tries the same
 * void again.
 */

const ZERO = '0.00';

test('sales: a paid invoice is voided by voiding its receipt first, and nothing is left open', async ({
  page,
}) => {
  await register(page, 'Reversal Sales Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Reversal Customer');
  const invoiceUrl = await issueInvoice(page, {
    customer: 'Reversal Customer',
    date: '2026-06-15',
    amount: '500.00',
  });
  const receiptUrl = await recordReceipt(page, {
    customer: 'Reversal Customer',
    date: '2026-06-20',
    amount: '300.00',
    allocate: '300.00',
  });

  // A part-paid invoice cannot be voided: the screen explains why and offers no form.
  await page.goto(invoiceUrl);
  await expect(
    page.getByText('Remove its payments and credits before voiding this invoice.'),
  ).toBeVisible();
  await expect(page.getByLabel('Void reason')).toHaveCount(0);
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '300.00',
    '200.00',
    ZERO,
  ]);

  // The receipt is open in a second tab as well (a stale copy with its own void form).
  const stale = await page.context().newPage();
  await stale.goto(receiptUrl);
  await expect(stale.getByLabel('Void reason')).toBeVisible();

  await page.goto(receiptUrl);
  await voidWithReason(page, 'Cheque bounced');

  // A second attempt from the stale tab is refused and changes nothing.
  await stale.getByLabel('Void reason').fill('Cheque bounced');
  await stale.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText(/already void|changed/i);
  await stale.close();

  // The invoice is open again for the full amount, and the receipt's cash is gone.
  await page.goto(invoiceUrl);
  await expect(page.getByText('500.00').first()).toBeVisible();
  await expect(page.getByLabel('Void reason')).toBeVisible();
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '800.00',
    '300.00',
    '500.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '300.00',
    '300.00',
    ZERO,
    ZERO,
  ]);

  // Now the invoice itself can be voided.
  await page.goto(invoiceUrl);
  await voidWithReason(page, 'Issued to the wrong customer');
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '800.00',
    '800.00',
    ZERO,
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /4100 Sales Revenue/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '500.00',
    ZERO,
    ZERO,
  ]);
  await expect(page.getByTestId('tb-closing-debit')).toHaveText(ZERO);

  // Four journals in the ledger: the invoice, the receipt and the two reversals.
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('1,600.00');

  // Nothing is left to collect.
  await page.goto('/sales/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByText('No open invoices or credits on this date.')).toBeVisible();

  // Both voids are in the audit log.
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'receipt.voided', exact: true })).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'invoice.voided', exact: true })).toHaveCount(1);
});

test('purchases: a paid bill is voided by voiding its payment first, and nothing is left payable', async ({
  page,
}) => {
  await register(page, 'Reversal Purchases Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Reversal Vendor');
  const billUrl = await postBill(page, {
    vendor: 'Reversal Vendor',
    reference: 'RV-1',
    date: '2026-06-10',
    amount: '800.00',
  });
  const paymentUrl = await recordVendorPayment(page, {
    vendor: 'Reversal Vendor',
    date: '2026-06-20',
    amount: '500.00',
    allocate: '500.00',
  });

  // A part-paid bill cannot be voided from its screen.
  await page.goto(billUrl);
  await expect(page.getByLabel('Void reason')).toHaveCount(0);
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '800.00',
    ZERO,
    '300.00',
  ]);

  const stale = await page.context().newPage();
  await stale.goto(paymentUrl);
  await expect(stale.getByLabel('Void reason')).toBeVisible();

  await page.goto(paymentUrl);
  await voidWithReason(page, 'Paid the wrong vendor');

  await stale.getByLabel('Void reason').fill('Paid the wrong vendor');
  await stale.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText(/already void|changed/i);
  await stale.close();

  // The bill is payable in full again and the bank balance is restored.
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '1,300.00',
    ZERO,
    '800.00',
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '500.00',
    ZERO,
    ZERO,
  ]);

  await page.goto(billUrl);
  await expect(page.getByLabel('Void reason')).toBeVisible();
  await voidWithReason(page, 'Duplicate of another bill');
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '1,300.00',
    '1,300.00',
    ZERO,
    ZERO,
  ]);
  await expect(page.getByTestId('tb-closing-debit')).toHaveText(ZERO);

  // Four journals: bill, payment and the two reversals.
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('2,600.00');

  await page.goto('/purchases/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByText('No open bills, credits or prepayments on this date.')).toBeVisible();

  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'vendor_payment.voided', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('cell', { name: 'bill.voided', exact: true })).toHaveCount(1);
});

test('another organization cannot void a receipt or a bill it does not own', async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  try {
    await register(a, 'Void Owner Alpha Pvt Ltd');
    await setUpAccounting(a);
    await configureSales(a);
    await configurePurchases(a);
    await createCustomer(a, 'Alpha Client');
    await issueInvoice(a, { customer: 'Alpha Client', date: '2026-06-15', amount: '500.00' });
    const receiptUrl = await recordReceipt(a, {
      customer: 'Alpha Client',
      date: '2026-06-20',
      amount: '300.00',
      allocate: '300.00',
    });
    await createVendor(a, 'Alpha Supplier');
    const billUrl = await postBill(a, {
      vendor: 'Alpha Supplier',
      reference: 'AL-1',
      date: '2026-06-10',
      amount: '800.00',
    });
    const receiptId = receiptUrl.split('/').pop()!;
    const billId = billUrl.split('/').pop()!;

    await register(b, 'Void Intruder Beta Pvt Ltd');
    await setUpAccounting(b);

    // Through the screens: the other organization sees no void form for these documents.
    await b.goto(receiptUrl);
    await expect(b.getByLabel('Void reason')).toHaveCount(0);
    await b.goto(billUrl);
    await expect(b.getByLabel('Void reason')).toHaveCount(0);

    // Through the API with its own session: "not found", never a void.
    for (const path of [`/sales/receipts/${receiptId}/void`, `/purchases/bills/${billId}/void`]) {
      const attempt = await apiAs(b, 'POST', path, { version: 1, reason: 'Not my record' });
      expect(attempt.status, path).toBe(404);
    }

    // The owner's records are untouched: the receipt can still be voided by its owner.
    await a.goto(receiptUrl);
    await expect(a.getByLabel('Void reason')).toBeVisible();
    await a.goto(billUrl);
    await expect(a.getByText('800.00').first()).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
