import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.js';

/**
 * Authentication sweep of every endpoint added in the completion batches (returns, management
 * reports, modules, payroll, projects, quotes, recurring invoices, ownership transfer, metrics,
 * API integrations and webhooks): with no session each one answers 401 and none reveals whether a
 * resource exists. A module endpoint also never answers without a session when the module is off.
 */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

const id = randomUUID();

const GET = [
  '/inventory/returns',
  `/inventory/returns/${id}`,
  `/inventory/returns/returnable/${id}`,
  '/inventory/reports/low-stock',
  '/inventory/reports/slow-moving?asOf=2026-03-31',
  '/inventory/reports/cogs-profitability?from=2026-03-01&to=2026-03-31',
  '/accounting/reports/tax-liability?from=2026-03-01&to=2026-03-31',
  '/accounting/reports/cash-flow?from=2026-01-01&to=2026-03-31',
  '/accounting/reports/changes-in-equity?from=2026-01-01&to=2026-03-31',
  '/sales/reports/sales-trend?from=2026-03-01&to=2026-03-31',
  '/organizations/current/modules',
  '/organizations/current/ownership-transfers',
  '/payroll/settings',
  '/payroll/components',
  '/payroll/employees',
  `/payroll/employees/${id}`,
  '/payroll/runs',
  `/payroll/runs/${id}`,
  `/payroll/payslips/${id}`,
  '/payroll/my-payslips',
  '/projects',
  '/projects/summary',
  `/projects/${id}`,
  '/projects/time/entries',
  '/sales/quotes',
  `/sales/quotes/${id}`,
  '/sales/recurring-invoices',
  `/sales/recurring-invoices/${id}`,
  '/api-integrations',
  '/api-integrations/scopes',
  `/api-integrations/${id}`,
  `/api-integrations/${id}/tokens`,
  '/webhooks/endpoints',
  '/webhooks/event-types',
  '/webhooks/deliveries',
  `/webhooks/deliveries/${id}`,
  '/payroll/leave/types',
  '/payroll/leave/requests',
  '/payroll/leave/balances',
  '/payroll/advances',
  `/payroll/advances/${id}`,
  `/payroll/payslips/${id}/pdf`,
  `/payroll/my-payslips/${id}/pdf`,
  '/payments/settings',
  '/payments/intents',
  `/payments/intents/${id}`,
  `/customers/${id}/statement-links`,
  '/accounting/reports/profit-and-loss-cash-basis?from=2026-03-01&to=2026-03-31',
  '/expense-claims/reports/by-claimant?from=2026-03-01&to=2026-03-31',
  '/inventory/bundles',
  `/inventory/bundles/${id}`,
];

const POST: [string, object][] = [
  ['/inventory/returns', {}],
  [`/inventory/returns/${id}/void`, { version: 1, reason: 'x' }],
  [`/organizations/current/ownership-transfers`, {}],
  [`/organizations/current/ownership-transfers/${id}/accept`, {}],
  ['/payroll/components', {}],
  ['/payroll/employees', {}],
  ['/payroll/runs', {}],
  [`/payroll/runs/${id}/recalculate`, { version: 1 }],
  [`/payroll/runs/${id}/approve`, { version: 1 }],
  [`/payroll/runs/${id}/post`, { version: 1 }],
  [`/payroll/runs/${id}/pay`, { version: 1 }],
  [`/payroll/runs/${id}/void`, { version: 1, reason: 'x' }],
  ['/projects', {}],
  [`/projects/${id}/bill`, {}],
  [`/projects/${id}/release-time`, {}],
  ['/projects/time/entries', {}],
  [`/projects/time/entries/${id}/submit`, { version: 1 }],
  [`/projects/time/entries/${id}/approve`, { version: 1 }],
  [`/projects/time/entries/${id}/reject`, { version: 1, reason: 'x' }],
  ['/sales/quotes', {}],
  [`/sales/quotes/${id}/send`, { version: 1 }],
  [`/sales/quotes/${id}/accept`, { version: 1 }],
  [`/sales/quotes/${id}/decline`, { version: 1, reason: 'x' }],
  [`/sales/quotes/${id}/convert`, { version: 1 }],
  ['/sales/recurring-invoices', {}],
  [`/sales/recurring-invoices/${id}/pause`, { version: 1 }],
  [`/sales/recurring-invoices/${id}/resume`, { version: 1 }],
  [`/sales/recurring-invoices/${id}/end`, { version: 1 }],
  [`/sales/recurring-invoices/${id}/run-now`, { version: 1 }],
  ['/api-integrations', {}],
  [`/api-integrations/${id}/tokens`, {}],
  [`/api-tokens/${id}/revoke`, { reason: 'x' }],
  ['/webhooks/endpoints', {}],
  [`/webhooks/endpoints/${id}/rotate-secret`, { version: 1 }],
  [`/webhooks/deliveries/${id}/redeliver`, {}],
  ['/payroll/leave/types', {}],
  ['/payroll/leave/requests', {}],
  [`/payroll/leave/requests/${id}/approve`, { version: 1 }],
  [`/payroll/leave/requests/${id}/reject`, { version: 1, note: 'x' }],
  [`/payroll/leave/requests/${id}/cancel`, { version: 1 }],
  ['/payroll/advances', {}],
  [`/payroll/advances/${id}/cancel`, { version: 1, reason: 'x' }],
  ['/payments/intents', {}],
  [`/payments/intents/${id}/cancel`, {}],
  [`/payments/intents/${id}/reconcile`, {}],
  [`/customers/${id}/statement-links`, {}],
  [`/customers/statement-links/${id}/revoke`, {}],
];

const PUT: [string, object][] = [
  ['/organizations/current/modules/payroll', { enabled: true }],
  ['/payroll/settings', {}],
  [`/payroll/components/${id}`, {}],
  [`/payroll/employees/${id}`, {}],
  [`/projects/${id}`, {}],
  [`/projects/time/entries/${id}`, {}],
  [`/sales/quotes/${id}`, {}],
  [`/sales/recurring-invoices/${id}`, {}],
  ['/payments/settings', { version: 0, mode: 'disabled', intentTtlMinutes: 60 }],
  [`/payroll/leave/types/${id}`, {}],
  [`/inventory/bundles/${id}`, { components: [] }],
];

describe('endpoints added in the completion batches require a session', () => {
  it.each(GET)('GET %s', async (path) => {
    const res = await ctx.client().get(path);
    expect(res.status, path).toBe(401);
  });
  it.each(POST)('POST %s', async (path, body) => {
    const res = await ctx.client().post(path, body);
    expect([401, 403], path).toContain(res.status); // 403 only if CSRF fires before authentication
    expect(JSON.stringify(res.body)).not.toMatch(/not found|enabled/i);
  });
  it.each(PUT)('PUT %s', async (path, body) => {
    const res = await ctx.client().put(path, body);
    expect([401, 403], path).toContain(res.status);
  });
  it('DELETE endpoints', async () => {
    for (const path of [
      `/sales/quotes/${id}?version=1`,
      `/projects/time/entries/${id}`,
      `/webhooks/endpoints/${id}?version=1`,
      `/inventory/bundles/${id}`,
    ]) {
      expect([401, 403], path).toContain((await ctx.client().delete(path)).status);
    }
  });
  it('the metrics endpoint refuses without its bearer token (or is off)', async () => {
    const res = await ctx.client().get('/metrics');
    expect([401, 404]).toContain(res.status);
  });
});
