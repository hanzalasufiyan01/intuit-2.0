import { expect, test } from '@playwright/test';
import { register, selectByCode, setUpAccounting } from './helpers';

/**
 * Purchases journey (FP-20): vendor, bill, post, a partial vendor payment allocated to the bill,
 * then the bill balance and the ledger (payables, expense and bank). Bill 800.00, payment 500.00,
 * so 300.00 stays payable and 500.00 leaves the bank.
 */

test('bills a vendor, pays part of it, and reconciles payables', async ({ page }) => {
  await register(page, 'Purchases Journey Pvt Ltd');
  await setUpAccounting(page);

  await page.goto('/purchases/settings');
  await selectByCode(page, 'Accounts payable (AP) control account', '2110');
  await selectByCode(page, 'Default expense account', '5300');
  await selectByCode(page, 'Default payment account', '1120');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeEnabled();

  await page.goto('/purchases/vendors/new');
  await page.getByLabel('Name').first().fill('Island Supplies');
  await page.getByRole('button', { name: 'Create vendor' }).click();
  await expect(page.getByText('Island Supplies').first()).toBeVisible();

  await page.goto('/purchases/bills/new');
  await page.getByLabel('Vendor').selectOption({ label: 'Island Supplies' });
  await page.getByLabel('Supplier invoice number').fill('SUP-001');
  await page.getByLabel('Bill date').fill('2026-06-10');
  await page.getByLabel('Line 1 description').fill('Office rent');
  await page.getByLabel('Line 1 quantity').fill('1');
  await page.getByLabel('Line 1 unit price').fill('800.00');
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expect(page).toHaveURL(/\/purchases\/bills\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Post', exact: true }).click();
  await expect(page.getByText('Posted', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  const billUrl = page.url();

  await page.goto('/purchases/payments/new');
  await page.getByLabel('Vendor').selectOption({ label: 'Island Supplies' });
  await page.getByLabel('Payment date').fill('2026-06-20');
  await page.getByLabel('Amount paid').fill('500.00');
  await page.getByLabel(/^Pay on /).fill('500.00');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page).toHaveURL(/\/purchases\/payments\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Recorded', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });

  await page.goto(billUrl);
  await expect(page.getByText('300.00').first()).toBeVisible();

  await page.goto('/accounting/reports/trial-balance');
  await expect(page.getByRole('row', { name: /Accounts Payable/ })).toContainText('300.00');
  await expect(page.getByRole('row', { name: /5300 Rent/ })).toContainText('800.00');
  await expect(page.getByRole('row', { name: /1120 Bank Accounts/ })).toContainText('500.00');
});
