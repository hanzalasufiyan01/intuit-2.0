import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApReportService } from '../../application/ap-report-service.js';
import { requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** AP aging, vendor statements and the AP reconciliation (Phase 4B-5; P4-49, brief §24). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const agingQuery = z.object({ asOf: isoDate, vendorId: fields.id.optional() }).strict();
const statementQuery = z.object({ vendorId: fields.id, from: isoDate, to: isoDate }).strict();
const reconciliationQuery = z.object({ asOf: isoDate }).strict();

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
}
