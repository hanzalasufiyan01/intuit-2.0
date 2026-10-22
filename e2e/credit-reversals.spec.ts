import { expect, test, type Page } from '@playwright/test';
import {
  apiAs,
  configureSales,
  createCustomer,
  issueCreditNote,
  issueInvoice,
  refundCreditNote,
  register,
  setUpAccounting,
  trialBalanceRow,
  voidWithReason,
} from './helpers';

/**
 * Customer credit reversals (R-05). Issued credit notes are immutable (ADR 0003 U14) and an
 * applied credit cannot be un-applied, so the reversible step on the sales side is the customer
 * refund (ADR 0010): voiding it reverses its journal and returns the amount to the credit note's
 * unapplied balance. Each step is checked on the screens, in the trial balance, the ledger, the
 * aging report and the audit log; a second, stale tab tries the same void again.
 */

const ZERO = '0.00';

async function creditNote(page: Page, id: string) {
  const res = await apiAs(page, 'GET', `/sales/credit-notes/${id}`);
  expect(res.status).toBe(200);
  return JSON.parse(res.text).data as { status: string; total: string; amountUnapplied: string };
}

test('sales: a credit note is issued and applied, its refund is voided, and the credit is open again', async ({
  page,
}) => {
  await register(page, 'Credit Reversals Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Credit Customer');
  const invoiceUrl = await issueInvoice(page, {
    customer: 'Credit Customer',
    date: '2026-06-15',
    amount: '500.00',
  });

  // A stand-alone credit note of 200.00, issued.
  const creditUrl = await issueCreditNote(page, {
    customer: 'Credit Customer',
    date: '2026-06-18',
    amount: '200.00',
  });
  const creditId = creditUrl.split('/').pop()!;
  expect(Number((await creditNote(page, creditId)).amountUnapplied)).toBe(200);

  // 120.00 of it is applied to the invoice.
  await page.getByRole('link', { name: 'Apply credit' }).click();
  await page.getByLabel('Date').fill('2026-06-18');
  await page.getByLabel(/^Amount to allocate to /).fill('120.00');
  await page.getByRole('button', { name: 'Apply credit' }).click();
  await expect
    .poll(async () => Number((await creditNote(page, creditId)).amountUnapplied))
    .toBe(80);

  // The remaining 80.00 is refunded to the customer.
  const refundUrl = await refundCreditNote(page, {
    creditUrl,
    date: '2026-06-20',
    amount: '80.00',
  });
  expect(Number((await creditNote(page, creditId)).amountUnapplied)).toBe(0);
  // Invoice 500 + refund 80 debited, credit note 200 credited, and the application's AR-against-AR
  // journal of 120 on both sides (ADR 0003 §Q: no net effect, kept for the audit trail): 380.00.
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '700.00',
    '320.00',
    '380.00',
    ZERO,
  ]);

  // An issued credit note offers no void.
  await page.goto(creditUrl);
  await expect(page.getByText('Issued', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Void reason')).toHaveCount(0);

  // The refund is open in a second, stale tab as well.
  const stale = await page.context().newPage();
  await stale.goto(refundUrl);
  await expect(stale.getByLabel('Void reason')).toBeVisible();

  await page.goto(refundUrl);
  await voidWithReason(page, 'Refund sent to the wrong account');

  await stale.getByLabel('Void reason').fill('Refund sent to the wrong account');
  await stale.getByRole('button', { name: 'Void', exact: true }).click();
  await expect(stale.getByRole('alert').first()).toContainText(/already void|changed/i);
  await stale.close();

  // The refunded amount is back on the credit note; the invoice keeps its 380.00.
  const after = await creditNote(page, creditId);
  expect(after.status).toBe('ISSUED');
  expect(Number(after.amountUnapplied)).toBe(80);
  await page.goto(invoiceUrl);
  await expect(page.getByText('380.00').first()).toBeVisible();

  // Receivable 380.00 less the open credit of 80.00; the refund's cash went out and came back.
  expect(await (await trialBalanceRow(page, /Accounts Receivable/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '700.00',
    '400.00',
    '300.00',
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '80.00',
    '80.00',
    ZERO,
    ZERO,
  ]);
  expect(await (await trialBalanceRow(page, /4100 Sales Revenue/)).allTextContents()).toEqual([
    ZERO,
    ZERO,
    '200.00',
    '500.00',
    ZERO,
    '300.00',
  ]);

  // Five journals: the invoice, the credit note, the application, the refund and its reversal.
  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('980.00');

  // The aging report shows the open invoice and the open credit.
  await page.goto('/sales/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  // The customer's row ends with the open credit (shown negative) and the net total.
  const aging = page.getByRole('row', { name: /Credit Customer/ }).locator('td.num');
  await expect(aging.nth(-2)).toHaveText('-80.00');
  await expect(aging.nth(-1)).toHaveText('300.00');
  await page.getByRole('button', { name: 'Credit Customer' }).click();
  await expect(page.getByRole('row', { name: /^INV-/ }).locator('td.num').last()).toHaveText(
    '380.00',
  );

  // The refund and its void are in the audit log.
  await page.goto('/audit');
  await expect(
    page.getByRole('cell', { name: 'customer_refund.recorded', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'customer_refund.voided', exact: true })).toHaveCount(
    1,
  );
});
