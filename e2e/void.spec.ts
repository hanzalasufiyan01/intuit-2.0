import { expect, test } from '@playwright/test';
import {
  configurePurchases,
  configureSales,
  createCustomer,
  createVendor,
  issueInvoice,
  postBill,
  register,
  setUpAccounting,
} from './helpers';

/**
 * Void and reversal journeys (FP-20): voiding an unpaid invoice or bill through the normal screen
 * with a reason posts a reversing journal. The ledger keeps both journals (original and
 * reversal, so debits equal credits at twice the amount), the trial balance nets to zero, and
 * the open-item reports no longer list the document.
 */

test('voiding an invoice reverses its journal and clears receivables', async ({ page }) => {
  await register(page, 'Void Sales Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Void Customer');
  const url = await issueInvoice(page, {
    customer: 'Void Customer',
    date: '2026-06-15',
    amount: '500.00',
  });

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByRole('row', { name: /Accounts Receivable/ })).toContainText('500.00');

  await page.goto(url);
  await page.getByLabel('Void reason').fill('Issued to the wrong customer');
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  // The void form disappears once the document is void.
  await expect(page.getByLabel('Void reason')).toHaveCount(0, { timeout: 20_000 });

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByTestId('tb-closing-debit')).toHaveText('0.00');
  // Opening Dr/Cr, period Dr/Cr (the invoice and its reversal), closing Dr/Cr.
  await expect(page.getByRole('row', { name: /Accounts Receivable/ }).locator('td.num')).toHaveText(
    ['0.00', '0.00', '500.00', '500.00', '0.00', '0.00'],
  );

  await page.goto('/accounting/ledger');
  const totals = page.getByRole('row', { name: /^Totals/ });
  await expect(totals).toContainText('1,000.00');

  await page.goto('/sales/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByText('No open invoices or credits on this date.')).toBeVisible();
});

test('voiding a bill reverses its journal and clears payables', async ({ page }) => {
  await register(page, 'Void Purchases Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Void Vendor');
  const url = await postBill(page, {
    vendor: 'Void Vendor',
    reference: 'VB-1',
    date: '2026-06-10',
    amount: '800.00',
  });

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByRole('row', { name: /Accounts Payable/ })).toContainText('800.00');

  await page.goto(url);
  await page.getByLabel('Void reason').fill('Duplicate of another bill');
  await page.getByRole('button', { name: 'Void', exact: true }).click();
  // The void form disappears once the document is void.
  await expect(page.getByLabel('Void reason')).toHaveCount(0, { timeout: 20_000 });

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByTestId('tb-closing-debit')).toHaveText('0.00');

  await page.goto('/accounting/ledger');
  await expect(page.getByRole('row', { name: /^Totals/ })).toContainText('1,600.00');

  await page.goto('/purchases/reports?view=aging');
  await page.getByLabel('As of').fill('2026-12-31');
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByText('No open bills, credits or prepayments on this date.')).toBeVisible();
});
