import { expect, test, type Page } from '@playwright/test';
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
  selectByCode,
  setUpAccounting,
  trialBalanceRow,
  voidWithReason,
} from './helpers';

/**
 * Refunds taken from a receipt's unallocated amount and from a vendor prepayment (R-05).
 *
 * Both are reached from the source document's own page ("Refund unallocated amount" on a
 * receipt, "Refund prepayment" on a payment). A refund pays only the part that was never
 * allocated, never touches an invoice or a bill, and can be voided: the void reverses the refund's
 * journal and returns the amount to the source. The source cannot be voided while a refund from it
 * is active. Each step is checked on the screens, through the API, in the trial balance, the
 * ledger and the audit log, and a second, stale tab tries the same void again.
 *
 * Expected balances follow from the journals the services post (customer refund: debit 1130
 * Accounts Receivable, credit 1120 Bank; vendor refund: debit 1120 Bank, credit 2110 Accounts
 * Payable; a receipt debits the bank and credits receivable, a payment the reverse).
 */

const ZERO = '0.00';

const idOf = (url: string) => url.split('/').pop()!;

async function get<T>(page: Page, path: string): Promise<T> {
  const res = await apiAs(page, 'GET', path);
  expect(res.status, path).toBe(200);
  return JSON.parse(res.text).data as T;
}
const receipt = (page: Page, url: string) =>
  get<{ status: string; amountUnallocated: string }>(page, `/sales/receipts/${idOf(url)}`);
const invoice = (page: Page, url: string) =>
  get<{ status: string; amountDue: string }>(page, `/sales/invoices/${idOf(url)}`);
const payment = (page: Page, url: string) =>
  get<{ status: string; amountUnallocated: string | null }>(
    page,
    `/purchases/payments/${idOf(url)}`,
  );
const bill = (page: Page, url: string) =>
  get<{ status: string; amountDue: string | null }>(page, `/purchases/bills/${idOf(url)}`);

/** Opens the refund form from the receipt page and submits it; the caller checks the outcome. */
async function submitReceiptRefund(page: Page, receiptUrl: string, date: string, amount: string) {
  await page.goto(receiptUrl);
  await page.getByRole('link', { name: 'Refund unallocated amount' }).click();
  await page.getByLabel('Refund date').fill(date);
  await page.getByLabel('Amount (MVR)').fill(amount);
  await page.getByRole('button', { name: 'Record refund' }).click();
}

/** Opens the refund form from the payment page and submits it; the caller checks the outcome. */
async function submitPrepaymentRefund(
  page: Page,
  paymentUrl: string,
  date: string,
  amount: string,
) {
  await page.goto(paymentUrl);
  await page.getByRole('link', { name: 'Refund prepayment' }).click();
  await page.getByLabel('Refund date').fill(date);
  await page.getByLabel('Amount refunded (MVR)').fill(amount);
  await selectByCode(page, 'Received into', '1120');
  await page.getByRole('button', { name: 'Record refund' }).click();
}

/** Voids the open refund on `refundUrl` while a stale second tab still shows its void form. */
async function voidRefundWithStaleTab(page: Page, refundUrl: string, reason: string) {
  const stale = await page.context().newPage();
  await stale.goto(refundUrl);
  await expect(stale.getByLabel('Void reason')).toBeVisible();

  await page.goto(refundUrl);
  await voidWithReason(page, reason);

  // The stale tab's second attempt is refused and changes nothing.
  await stale.getByLabel('Void reason').fill(reason);
  await stale.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText(/already void|changed/i);
  await stale.close();
}

test('sales: part of a receipt is refunded from its unallocated amount, then the refund is voided', async ({
  page,
}) => {
  test.slow(); // a long journey: it records, refuses, voids twice and re-checks the ledger each time
  await register(page, 'Receipt Refund Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Refund Customer');
  const invoiceUrl = await issueInvoice(page, {
    customer: 'Refund Customer',
    date: '2026-06-15',
    amount: '500.00',
  });
  // 300.00 received, 200.00 of it allocated to the invoice: 100.00 stays unallocated.
  const receiptUrl = await recordReceipt(page, {
    customer: 'Refund Customer',
    date: '2026-06-20',
    amount: '300.00',
    allocate: '200.00',
  });
  expect((await receipt(page, receiptUrl)).amountUnallocated).toBe('100.00');
  expect((await invoice(page, invoiceUrl)).amountDue).toBe('300.00');
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '300.00',
    '200.00',
    ZERO,
  ]);

  // 60.00 of the unallocated 100.00 is refunded to the customer.
  await submitReceiptRefund(page, receiptUrl, '2026-06-22', '60.00');
  await expect(page).toHaveURL(/\/sales\/refunds\/[0-9a-f-]{36}$/);
  const refundUrl = page.url();

  // Only the unallocated part moved: the invoice still owes what it owed.
  expect((await receipt(page, receiptUrl)).amountUnallocated).toBe('40.00');
  expect((await invoice(page, invoiceUrl)).amountDue).toBe('300.00');
  // Receivable: invoice 500 and refund 60 debited, receipt 300 credited. The cash went out.
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '560.00',
    '300.00',
    '260.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '300.00',
    '60.00',
    '240.00',
    ZERO,
  ]);

  // More than the remaining 40.00 is refused on the form, and nothing is recorded.
  await submitReceiptRefund(page, receiptUrl, '2026-06-22', '40.01');
  await expect(page.getByText('Only 40.00 MVR is available to refund.')).toBeVisible();
  await expect(page).toHaveURL(/\/sales\/refunds\/new/);
  expect((await receipt(page, receiptUrl)).amountUnallocated).toBe('40.00');

  // The receipt cannot be voided while the refund is active: the server refuses.
  await page.goto(receiptUrl);
  await page.getByLabel('Void reason').fill('Customer changed their mind');
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText(
    'The receipt has recorded refunds; void them before the receipt.',
  );
  expect((await receipt(page, receiptUrl)).status).toBe('RECORDED');

  // The refund is voided (a stale tab tries the same void again).
  await voidRefundWithStaleTab(page, refundUrl, 'Refund sent to the wrong account');

  // The 60.00 is back on the receipt; the invoice is untouched; the cash came back.
  expect((await receipt(page, receiptUrl)).amountUnallocated).toBe('100.00');
  expect((await invoice(page, invoiceUrl)).amountDue).toBe('300.00');
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '560.00',
    '360.00',
    '200.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '360.00',
    '60.00',
    '300.00',
    ZERO,
  ]);
  // Revenue never moves: a refund is not a sale.
  expect(await (await trialBalanceRow(page, /4100 Sales Revenue/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    ZERO,
    '500.00',
    ZERO,
    '500.00',
  ]);

  // Four journals: the invoice, the receipt, the refund and its reversal (500 + 300 + 60 + 60).
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('920.00');

  // With its refund voided, the receipt can be voided: the invoice is open for the full 500.00.
  await page.goto(receiptUrl);
  await voidWithReason(page, 'Cheque bounced');
  expect((await receipt(page, receiptUrl)).status).toBe('VOID');
  expect((await invoice(page, invoiceUrl)).amountDue).toBe('500.00');
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '860.00',
    '360.00',
    '500.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '360.00',
    '360.00',
    ZERO,
    ZERO,
  ]);

  // The audit log has the refund, its void and the receipt's void, one each.
  await page.goto('/audit');
  await expect(
    page.getByRole('cell', { name: 'customer_refund.recorded', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'customer_refund.voided', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('cell', { name: 'receipt.voided', exact: true })).toHaveCount(1);
});

test('purchases: part of a vendor prepayment is refunded, then the refund is voided', async ({
  page,
}) => {
  test.slow(); // a long journey: it records, refuses, voids twice and re-checks the ledger each time
  await register(page, 'Prepayment Refund Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Prepay Vendor');
  const billUrl = await postBill(page, {
    vendor: 'Prepay Vendor',
    reference: 'SUP-400',
    date: '2026-06-05',
    amount: '400.00',
  });
  // 500.00 paid, 400.00 of it allocated to the bill: 100.00 is a prepayment.
  const paymentUrl = await recordVendorPayment(page, {
    vendor: 'Prepay Vendor',
    date: '2026-06-20',
    amount: '500.00',
    allocate: '400.00',
  });
  expect((await payment(page, paymentUrl)).amountUnallocated).toBe('100.00');
  expect(Number((await bill(page, billUrl)).amountDue ?? 0)).toBe(0);
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '400.00',
    '100.00',
    ZERO,
  ]);

  // 60.00 of the 100.00 prepayment is refunded by the vendor into the bank.
  await submitPrepaymentRefund(page, paymentUrl, '2026-06-22', '60.00');
  await expect(page).toHaveURL(/\/purchases\/refunds\/[0-9a-f-]{36}$/);
  const refundUrl = page.url();

  // Only the prepayment moved: the bill stays paid.
  expect((await payment(page, paymentUrl)).amountUnallocated).toBe('40.00');
  expect(Number((await bill(page, billUrl)).amountDue ?? 0)).toBe(0);
  // Payable: the payment 500 debited, the bill 400 and the refund 60 credited, a debit of 40
  // left. The bank paid 500 and received 60.
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '500.00',
    '460.00',
    '40.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '60.00',
    '500.00',
    ZERO,
    '440.00',
  ]);

  // More than the remaining 40.00 is refused on the form, and nothing is recorded.
  await submitPrepaymentRefund(page, paymentUrl, '2026-06-22', '40.01');
  await expect(page.getByText('Only 40.00 MVR is available to refund.')).toBeVisible();
  await expect(page).toHaveURL(/\/purchases\/refunds\/new/);
  expect((await payment(page, paymentUrl)).amountUnallocated).toBe('40.00');

  // The payment offers no void while the refund is active, and says why.
  await page.goto(paymentUrl);
  await expect(
    page.getByText(
      'This payment has active refunds. Void the refunds taken from this payment first.',
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Void reason')).toHaveCount(0);

  // The refund is voided (a stale tab tries the same void again).
  await voidRefundWithStaleTab(page, refundUrl, 'Deposit was reversed by the bank');

  // The 60.00 is back as a prepayment; the bill is still paid; the cash went out again.
  expect((await payment(page, paymentUrl)).amountUnallocated).toBe('100.00');
  expect(Number((await bill(page, billUrl)).amountDue ?? 0)).toBe(0);
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '560.00',
    '460.00',
    '100.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '60.00',
    '560.00',
    ZERO,
    '500.00',
  ]);

  // Four journals: the bill, the payment, the refund and its reversal (400 + 500 + 60 + 60).
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('1,020.00');

  // With its refund voided, the payment offers its void again, and voiding it reopens the bill.
  await page.goto(paymentUrl);
  await voidWithReason(page, 'Paid the wrong vendor');
  expect((await payment(page, paymentUrl)).status).toBe('VOID');
  expect((await bill(page, billUrl)).status).toBe('POSTED');
  expect(Number((await bill(page, billUrl)).amountDue)).toBe(400);
  expect(await (await trialBalanceRow(page, /Accounts Payable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '560.00',
    '960.00',
    ZERO,
    '400.00',
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '560.00',
    '560.00',
    ZERO,
    ZERO,
  ]);

  // The audit log has the refund, its void and the payment's void, one each.
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'vendor_refund.recorded', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('cell', { name: 'vendor_refund.voided', exact: true })).toHaveCount(
    1,
  );
  await expect(page.getByRole('cell', { name: 'vendor_payment.voided', exact: true })).toHaveCount(
    1,
  );
});
