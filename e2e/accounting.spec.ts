import { expect, test } from '@playwright/test';
import { pickAccount, register, setUpAccounting } from './helpers';

/**
 * Accounting journey (FP-20): set up accounting, create a balanced journal through the editor,
 * submit and post it, then check the trial balance and the general ledger show exactly the
 * posted amounts. Fixed dates and amounts keep the test deterministic; every test registers its
 * own organization, so nothing is shared between tests.
 */

test('creates, posts and reports a manual journal', async ({ page }) => {
  await register(page, 'Ledger Journey Pvt Ltd');
  await setUpAccounting(page);

  await page.goto('/accounting/journals/new');
  await page.getByLabel('Date').fill('2026-06-15');
  await page.getByLabel('Description').first().fill('Owner capital introduced');
  await pickAccount(page, 1, '1110');
  await page.getByLabel('Line 1 debit').fill('1000.00');
  await pickAccount(page, 2, '3100');
  await page.getByLabel('Line 2 credit').fill('1000.00');
  await expect(page.getByTestId('total-debit')).toHaveText('1000');
  await expect(page.getByTestId('total-credit')).toHaveText('1000');
  await expect(page.getByText('Balanced', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save draft' }).click();

  await expect(page).toHaveURL(/\/accounting\/journals\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByText('POSTED', { exact: false }).first()).toBeVisible();

  await page.goto('/accounting/reports/trial-balance');
  const cash = page.getByRole('row', { name: /1110 Cash on Hand/ });
  await expect(cash).toContainText('1,000.00');
  const capital = page.getByRole('row', { name: /3100/ });
  await expect(capital).toContainText('1,000.00');
  await expect(page.getByTestId('tb-closing-debit')).toContainText('1,000.00');

  await page.goto('/accounting/ledger');
  await expect(page.getByText('Owner capital introduced').first()).toBeVisible();
  const totals = page.getByRole('row', { name: /^Totals/ });
  await expect(totals).toContainText('1,000.00');
});
