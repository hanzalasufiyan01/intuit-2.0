import { expect, test } from '@playwright/test';
import { register, selectByCode, setUpAccounting } from './helpers';

/**
 * Sales journey (FP-20): customer, invoice, issue, a partial receipt allocated to the invoice,
 * then the invoice balance, the customer's receivable in the general ledger and the receivables
 * report. Invoice 500.00, receipt 300.00, so 200.00 stays receivable and 300.00 reaches the bank.
 */

test('invoices a customer, collects part of it, and reconciles receivables', async ({ page }) => {
  await register(page, 'Sales Journey Pvt Ltd');
  await setUpAccounting(page);

  await page.goto('/sales/settings');
  await selectByCode(page, 'Accounts receivable control account', '1130');
  await selectByCode(page, 'Revenue account', '4100');
  await selectByCode(page, 'Deposit to', '1120');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();

  await page.goto('/sales/customers/new');
  await page.getByLabel('Name').first().fill('Reef Resort');
  await page.getByRole('button', { name: 'Create customer' }).click();
  await expect(page.getByText('Reef Resort').first()).toBeVisible();

  await page.goto('/sales/invoices/new');
  await page.getByLabel('Customer').selectOption({ label: 'Reef Resort' });
  await page.getByLabel('Invoice date').fill('2026-06-15');
  await page.getByLabel('Line 1 description').fill('Consulting');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill('500.00');
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expect(page).toHaveURL(/\/sales\/invoices\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Issued', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const invoiceUrl = page.url();

  await page.goto('/sales/receipts/new');
  await page.getByLabel('Customer').selectOption({ label: 'Reef Resort' });
  await page.getByLabel('Date').fill('2026-06-20');
  await page.getByLabel('Amount received').fill('300.00');
  await page.getByLabel(/^Amount to allocate to /).fill('300.00');
  await page.getByRole('button', { name: 'Record receipt' }).click();
  await expect(page).toHaveURL(/\/sales\/receipts\/[0-9a-f-]{36}$/);
  await expect(page.getByText('300.00').first()).toBeVisible();

  await page.goto(invoiceUrl);
  await expect(page.getByText('200.00').first()).toBeVisible();

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByRole('row', { name: /Accounts Receivable/ })).toContainText('200.00');
  await expect(page.getByRole('row', { name: /^4\d{3} .*(Sales|Revenue)/ })).toContainText(
    '500.00',
  );
});
