import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApReportService } from '../../application/ap-report-service.js';
import { requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * AP aging, vendor statements and the AP reconciliation (Phase 4B-5); unpaid bills, purchases by
 * vendor, item and account, the input-tax summary and the payment register (Phase 4B-6). P4-49,
 * brief §24; all read-only under purchases.reports.view.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const agingQuery = z.object({ asOf: isoDate, vendorId: fields.id.optional() }).strict();
const statementQuery = z.object({ vendorId: fields.id, from: isoDate, to: isoDate }).strict();
const reconciliationQuery = z.object({ asOf: isoDate }).strict();
const unpaidQuery = z.object({ asOf: isoDate, vendorId: fields.id.optional() }).strict();
const byVendorQuery = z
  .object({ from: isoDate, to: isoDate, vendorId: fields.id.optional() })
  .strict();
const byItemQuery = z.object({ from: isoDate, to: isoDate, itemId: fields.id.optional() }).strict();
const byAccountQuery = z
  .object({ from: isoDate, to: isoDate, accountId: fields.id.optional() })
  .strict();
const periodQuery = z.object({ from: isoDate, to: isoDate }).strict();
const registerQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    vendorId: fields.id.optional(),
    paymentAccountId: fields.id.optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
      .optional(),
  })
  .strict();

export function registerPurchasesReportRoutes(
  app: FastifyInstance,
  { apReports }: { apReports: ApReportService },
) {
  app.get('/purchases/reports/aging', async (request) => ({
    data: await apReports.aging(requirePrincipal(request), parseInput(agingQuery, request.query)),
  }));
  app.get('/purchases/reports/statement', async (request) => {
    const { vendorId, from, to } = parseInput(statementQuery, request.query);
    return { data: await apReports.statement(requirePrincipal(request), vendorId, { from, to }) };
  });
  app.get('/purchases/reports/ap-reconciliation', async (request) => ({
    data: await apReports.reconciliation(
      requirePrincipal(request),
      parseInput(reconciliationQuery, request.query),
    ),
  }));
  // Phase 4B-6.
  app.get('/purchases/reports/unpaid-bills', async (request) => ({
    data: await apReports.unpaidBills(
      requirePrincipal(request),
      parseInput(unpaidQuery, request.query),
    ),
  }));
  app.get('/purchases/reports/purchases-by-vendor', async (request) => ({
    data: await apReports.purchasesByVendor(
      requirePrincipal(request),
      parseInput(byVendorQuery, request.query),
    ),
  }));
  app.get('/purchases/reports/purchases-by-item', async (request) => ({
    data: await apReports.purchasesByItem(
      requirePrincipal(request),
      parseInput(byItemQuery, request.query),
    ),
  }));
  app.get('/purchases/reports/purchases-by-account', async (request) => ({
    data: await apReports.purchasesByAccount(
      requirePrincipal(request),
      parseInput(byAccountQuery, request.query),
    ),
  }));
  app.get('/purchases/reports/input-tax-summary', async (request) => ({
    data: await apReports.inputTaxSummary(
      requirePrincipal(request),
      parseInput(periodQuery, request.query),
    ),
  }));
  app.get('/purchases/reports/payment-register', async (request) => ({
    data: await apReports.paymentRegister(
      requirePrincipal(request),
      parseInput(registerQuery, request.query),
    ),
  }));
}
