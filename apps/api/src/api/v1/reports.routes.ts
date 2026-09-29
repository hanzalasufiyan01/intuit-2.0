import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReportService } from '../../application/report-service.js';
import { requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Financial statements (Decision 4). Every route needs accounting.reports.view (S3-01). */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const flag = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');
const common = {
  includeZero: flag,
  currencyView: z.enum(['base', 'base_and_account']).default('base'),
  dimensionValueIds: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter(Boolean))
    .pipe(z.array(fields.id).max(20).optional()),
};
const range = {
  from: isoDate.optional(),
  to: isoDate.optional(),
  periodId: fields.id.optional(),
  fiscalYearId: fields.id.optional(),
};
const compare = z.enum(['previous_period', 'previous_year', 'custom']).optional();

// Strict: unknown query parameters are rejected rather than silently ignored.
export const trialBalanceQuery = z.object({ ...common, ...range }).strict();
export const profitAndLossQuery = z
  .object({
    ...common,
    ...range,
    compare,
    compareFrom: isoDate.optional(),
    compareTo: isoDate.optional(),
  })
  .strict();
export const balanceSheetQuery = z
  .object({
    ...common,
    asOf: isoDate.optional(),
    periodId: fields.id.optional(),
    fiscalYearId: fields.id.optional(),
    compare,
    compareAsOf: isoDate.optional(),
  })
  .strict();

export function registerReportRoutes(app: FastifyInstance, deps: { reports: ReportService }): void {
  const base = '/accounting/reports';
  app.get(`${base}/trial-balance`, async (request) => ({
    data: await deps.reports.trialBalance(
      requirePrincipal(request),
      parseInput(trialBalanceQuery, request.query),
    ),
  }));
  app.get(`${base}/profit-and-loss`, async (request) => ({
    data: await deps.reports.profitAndLoss(
      requirePrincipal(request),
      parseInput(profitAndLossQuery, request.query),
    ),
  }));
  app.get(`${base}/balance-sheet`, async (request) => ({
    data: await deps.reports.balanceSheet(
      requirePrincipal(request),
      parseInput(balanceSheetQuery, request.query),
    ),
  }));
}
