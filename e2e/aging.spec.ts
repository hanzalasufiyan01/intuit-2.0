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
 * Aging journeys (FP-20): receivables and payables with different due dates fall into the right
 * buckets on a fixed "as of" date (2026-09-30), and the report totals agree with the amounts
 * entered. Days overdue: due 2026-07-01 = 91 (over 90); due 2026-09-15 = 15 (1-30 days);
 * due 2026-10-31 = not yet due (current).
 */

const AS_OF = '2026-09-30';
// Current, 1-30, 31-60, 61-90, over 90, credits, total.
const EXPECTED = ['300.00', '200.00', '0.00', '0.00', '100.00', '0.00', '600.00'];

test('AR aging puts invoices into buckets by due date', async ({ page }) => {
  await register(page, 'AR Aging Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Aging Customer');
  await issueInvoice(page, {
    customer: 'Aging Customer',
    date: '2026-06-01',
    due: '2026-07-01',
    amount: '100.00',
  });
  await issueInvoice(page, {
    customer: 'Aging Customer',
    date: '2026-08-15',
    due: '2026-09-15',
    amount: '200.00',
  });
  await issueInvoice(page, {
    customer: 'Aging Customer',
    date: '2026-09-20',
    due: '2026-10-31',
    amount: '300.00',
  });

  await page.goto('/sales/reports?view=aging');
  await page.getByLabel('As of').fill(AS_OF);
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.locator('tfoot tr td')).toHaveText(EXPECTED);
  await expect(page.getByRole('row', { name: /Aging Customer/ })).toContainText('600.00');
});

test('AP aging puts bills into buckets by due date', async ({ page }) => {
  await register(page, 'AP Aging Pvt Ltd');
  await setUpAccounting(page);
  await configurePurchases(page);
  await createVendor(page, 'Aging Vendor');
  await postBill(page, {
    vendor: 'Aging Vendor',
    reference: 'AG-1',
    date: '2026-06-01',
    due: '2026-07-01',
    amount: '100.00',
  });
  await postBill(page, {
    vendor: 'Aging Vendor',
    reference: 'AG-2',
    date: '2026-08-15',
    due: '2026-09-15',
    amount: '200.00',
  });
  await postBill(page, {
    vendor: 'Aging Vendor',
    reference: 'AG-3',
    date: '2026-09-20',
    due: '2026-10-31',
    amount: '300.00',
  });

  await page.goto('/purchases/reports?view=aging');
  await page.getByLabel('As of').fill(AS_OF);
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.locator('tfoot tr td')).toHaveText(EXPECTED);
  await expect(page.getByRole('row', { name: /Aging Vendor/ })).toContainText('600.00');
});
