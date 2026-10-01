import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ArReportService } from '../../application/ar-report-service.js';
import type { SalesSearchService } from '../../application/sales-search-service.js';
import { requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** AR aging, customer statements and the AR reconciliation (Phase 3B step 16). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const agingQuery = z.object({ asOf: isoDate, customerId: fields.id.optional() }).strict();
const statementQuery = z.object({ customerId: fields.id, from: isoDate, to: isoDate }).strict();
const reconciliationQuery = z.object({ asOf: isoDate }).strict();
const periodQuery = z.object({ from: isoDate, to: isoDate }).strict();
const searchQuery = z
  .object({
    q: z.string().max(100),
    limit: z.coerce.number().int().min(1).max(25).default(5),
  })
  .strict();

export function registerSalesReportRoutes(
  app: FastifyInstance,
  { arReports, salesSearch }: { arReports: ArReportService; salesSearch: SalesSearchService },
) {
  app.get('/sales/search', async (request) => ({
    data: await salesSearch.search(
      requirePrincipal(request),
      parseInput(searchQuery, request.query),
    ),
  }));
  app.get('/sales/reports/aging', async (request) => ({
    data: await arReports.aging(requirePrincipal(request), parseInput(agingQuery, request.query)),
  }));
  app.get('/sales/reports/statement', async (request) => {
    const { customerId, from, to } = parseInput(statementQuery, request.query);
    return { data: await arReports.statement(requirePrincipal(request), customerId, { from, to }) };
  });
  for (const [path, report] of [
    ['sales-by-customer', 'salesByCustomer'],
    ['sales-by-item', 'salesByItem'],
    ['tax-summary', 'taxSummary'],
  ] as const) {
    app.get(`/sales/reports/${path}`, async (request) => ({
      data: await arReports[report](
        requirePrincipal(request),
        parseInput(periodQuery, request.query),
      ),
    }));
  }
  app.get('/sales/reports/ar-reconciliation', async (request) => ({
    data: await arReports.reconciliation(
      requirePrincipal(request),
      parseInput(reconciliationQuery, request.query),
    ),
  }));
}
