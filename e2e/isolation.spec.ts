import { expect, test } from '@playwright/test';
import { configureSales, createCustomer, issueInvoice, register, setUpAccounting } from './helpers';

/**
 * Cross-tenant isolation (FP-20): two organizations, two separate signed-in browser contexts with
 * their own real accounts and two-step verification. Organization B opens organization A's
 * customer and invoice by their real identifiers, through the screens and through the API the
 * screens use, and sees nothing: the screens show no data, the API answers with a refusal or
 * "not found", and B's lists, trial balance and organization switcher contain none of A's data.
 */

test('one organization cannot read another organization’s records', async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const a = await contextA.newPage();
  const b = await contextB.newPage();
  try {
    await register(a, 'Tenant Alpha Pvt Ltd');
    await setUpAccounting(a);
    await configureSales(a);
    const customerUrl = await createCustomer(a, 'Alpha Secret Client');
    const invoiceUrl = await issueInvoice(a, {
      customer: 'Alpha Secret Client',
      date: '2026-06-15',
      amount: '777.00',
    });
    const customerId = customerUrl.split('/').pop()!;
    const invoiceId = invoiceUrl.split('/').pop()!;

    await register(b, 'Tenant Beta Pvt Ltd');
    await setUpAccounting(b);
    await configureSales(b);

    // Through the screens.
    await b.goto(`/sales/customers/${customerId}`);
    await expect(b.getByText('Alpha Secret Client')).toHaveCount(0);
    await b.goto(invoiceUrl);
    await expect(b.getByText('777.00')).toHaveCount(0);
    await expect(b.getByText('Alpha Secret Client')).toHaveCount(0);

    // Through the API with B's own session.
    for (const path of [
      `/api/v1/sales/customers/${customerId}`,
      `/api/v1/sales/invoices/${invoiceId}`,
    ]) {
      const result = await b.evaluate(async (url) => {
        const response = await fetch(url, { credentials: 'include' });
        return { status: response.status, body: await response.text() };
      }, path);
      expect(result.status, path).toBeGreaterThanOrEqual(400);
      expect(result.body).not.toContain('Alpha Secret Client');
      expect(result.body).not.toContain('777.00');
    }

    // Lists, ledger and the organization switcher.
    await b.goto('/sales/customers');
    await expect(b.getByText('Alpha Secret Client')).toHaveCount(0);
    await b.goto('/sales/invoices');
    await expect(b.getByText('777.00')).toHaveCount(0);
    await b.goto('/accounting/reports/trial-balance');
    await expect(b.getByRole('row', { name: /Accounts Receivable/ })).toHaveCount(0);
    await expect(b.locator('#organization-switcher')).toBeVisible();
    const options = await b.locator('#organization-switcher option').allTextContents();
    expect(options.join(' ')).toContain('Tenant Beta Pvt Ltd');
    expect(options.join(' ')).not.toContain('Tenant Alpha Pvt Ltd');

    // A still sees its own data.
    await a.goto(customerUrl);
    await expect(a.getByText('Alpha Secret Client').first()).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
