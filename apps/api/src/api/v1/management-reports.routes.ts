import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExpenseClaimReportService } from '../../application/expense-claim-report-service.js';
import type { CashBasisReportService } from '../../application/cash-basis-report-service.js';
import type { InventoryReportService } from '../../application/inventory-report-service.js';
import type { TaxLiabilityService } from '../../application/tax-liability-service.js';
import { requirePrincipal } from '../http/session.js';
import { parseInput } from '../http/validation.js';

/**
 * Management reports (FP-22): inventory low stock, slow-moving stock and COGS profitability, and
 * the tax liability review summary. Read-only; each report names the permission it needs in its
 * service.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const periodQuery = z.object({ from: isoDate, to: isoDate }).strict();
const asOfQuery = z.object({ asOf: isoDate }).strict();
const none = z.object({}).strict();

export function registerManagementReportRoutes(
  app: FastifyInstance,
  {
    inventoryReports,
    taxLiability,
    cashBasis,
    claimReports,
  }: {
    inventoryReports: InventoryReportService;
    taxLiability: TaxLiabilityService;
    cashBasis: CashBasisReportService;
    claimReports: ExpenseClaimReportService;
  },
) {
  app.get('/inventory/reports/purchase-suggestions', async (request) => ({
    data: await inventoryReports.purchaseSuggestions(requirePrincipal(request)),
  }));
  app.get('/inventory/reports/low-stock', async (request) => {
    parseInput(none, request.query);
    return { data: await inventoryReports.lowStock(requirePrincipal(request)) };
  });
  app.get('/inventory/reports/slow-moving', async (request) => ({
    data: await inventoryReports.slowMoving(
      requirePrincipal(request),
      parseInput(asOfQuery, request.query),
    ),
  }));
  app.get('/inventory/reports/cogs-profitability', async (request) => ({
    data: await inventoryReports.cogsProfitability(
      requirePrincipal(request),
      parseInput(periodQuery, request.query),
    ),
  }));
  app.get('/accounting/reports/profit-and-loss-cash-basis', async (request) => {
    const query = parseInput(
      periodQuery.extend({ includeZero: z.enum(['true', 'false']).default('false') }).strict(),
      request.query,
    );
    return {
      data: await cashBasis.profitAndLoss(requirePrincipal(request), {
        from: query.from,
        to: query.to,
        includeZero: query.includeZero === 'true',
      }),
    };
  });
  app.get('/expense-claims/reports/by-claimant', async (request) => ({
    data: await claimReports.byClaimant(
      requirePrincipal(request),
      parseInput(periodQuery, request.query),
    ),
  }));
  app.get('/accounting/reports/tax-liability', async (request) => ({
    data: await taxLiability.summary(
      requirePrincipal(request),
      parseInput(periodQuery, request.query),
    ),
  }));
}
