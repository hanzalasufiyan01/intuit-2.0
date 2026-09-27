import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountingService } from '../../application/accounting-service.js';
import type { JournalService } from '../../application/journal-service.js';
import { accountTypes, journalStatuses } from '../../modules/accounting/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Monetary values are accepted only as decimal strings, never JSON numbers. */
const decimalString = z.string().trim().max(40);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const currency = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 code, e.g. MVR.');
const idParam = (name: string) => z.object({ [name]: fields.id });

const setupBody = z.object({ baseCurrency: currency, templateKey: z.string().min(1).max(50) });
const settingsBody = z.object({ baseCurrency: currency });

const accountCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, 'Codes are 1-20 letters, digits, ".", "_" or "-".');
const accountBody = z.object({
  code: accountCode,
  name: z.string().trim().min(1, 'Name is required.').max(200),
  description: z.string().trim().max(1000).default(''),
  type: z.enum(accountTypes),
  parentId: fields.id.nullable().default(null),
});
const accountPatch = z
  .object({
    code: accountCode,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000),
    type: z.enum(accountTypes),
    parentId: fields.id.nullable(),
  })
  .partial();

const rateBody = z.object({ fromCurrency: currency, rateDate: isoDate, rate: decimalString });
const rateQuery = z.object({ fromCurrency: currency.optional() });

const fiscalYearBody = z.object({
  name: z.string().trim().min(1).max(100),
  startDate: isoDate,
  endDate: isoDate,
  periods: z
    .array(
      z.object({
        name: z.string().trim().max(100).optional(),
        startDate: isoDate,
        endDate: isoDate,
      }),
    )
    .max(60)
    .optional(),
});
const periodQuery = z.object({ fiscalYearId: fields.id.optional() });
const reopenBody = z.object({
  reason: z.string().trim().min(3, 'A reason is required.').max(1000),
});

const journalLine = z.object({
  accountId: fields.id.nullable().default(null),
  description: z.string().trim().max(500).default(''),
  debit: decimalString.nullable().default(null),
  credit: decimalString.nullable().default(null),
});
const journalBody = z.object({
  entryDate: isoDate.nullable().default(null),
  description: z.string().trim().max(1000).default(''),
  reference: z.string().trim().max(100).default(''),
  currency,
  exchangeRate: decimalString.nullable().default(null),
  lines: z.array(journalLine).max(500).default([]),
});
const journalPatch = z
  .object({
    entryDate: isoDate.nullable(),
    description: z.string().trim().max(1000),
    reference: z.string().trim().max(100),
    currency,
    exchangeRate: decimalString.nullable(),
    lines: z.array(journalLine).max(500),
  })
  .partial();
const journalQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter(Boolean))
    .pipe(z.array(z.enum(journalStatuses)).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});
const decisionBody = z.object({ comment: z.string().trim().max(1000).optional() });
const reverseBody = z.object({
  reason: z.string().trim().min(3, 'A reason is required.').max(1000),
  reversalDate: isoDate.optional(),
});
const ledgerQuery = z.object({
  accountId: fields.id.optional(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** /api/v1/accounting — every route resolves the organization from the session. */
export function registerAccountingRoutes(
  app: FastifyInstance,
  deps: { accounting: AccountingService; journals: JournalService },
): void {
  const { accounting, journals } = deps;
  const base = '/accounting';

  // ---- Setup and dashboard ----
  app.get(`${base}/setup`, async (request) => ({
    data: await accounting.getSetup(requirePrincipal(request)),
  }));
  app.post(`${base}/setup`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(setupBody, request.body);
    return reply
      .status(201)
      .send({ data: await accounting.setUp(principal, body, eventOrigin(request)) });
  });
  app.patch(`${base}/settings`, async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(settingsBody, request.body);
    return { data: await accounting.updateSettings(principal, body, eventOrigin(request)) };
  });
  app.get(`${base}/dashboard`, async (request) => ({
    data: await accounting.dashboard(requirePrincipal(request)),
  }));

  // ---- Chart of accounts ----
  app.get(`${base}/accounts`, async (request) => ({
    data: await accounting.listAccounts(requirePrincipal(request)),
  }));
  app.post(`${base}/accounts`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(accountBody, request.body);
    return reply
      .status(201)
      .send({ data: await accounting.createAccount(principal, body, eventOrigin(request)) });
  });
  app.get(`${base}/accounts/:id`, async (request) => {
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await accounting.getAccount(requirePrincipal(request), id) };
  });
  app.patch(`${base}/accounts/:id`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(accountPatch, request.body);
    return { data: await accounting.updateAccount(principal, id, body, eventOrigin(request)) };
  });
  app.delete(`${base}/accounts/:id`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    await accounting.deleteAccount(principal, id, eventOrigin(request));
    return reply.status(204).send();
  });
  app.post(`${base}/accounts/:id/archive`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await accounting.archiveAccount(principal, id, eventOrigin(request)) };
  });

  // ---- Exchange rates ----
  app.get(`${base}/exchange-rates`, async (request) => {
    const query = parseInput(rateQuery, request.query);
    return { data: await accounting.listExchangeRates(requirePrincipal(request), query) };
  });
  app.post(`${base}/exchange-rates`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(rateBody, request.body);
    return reply
      .status(201)
      .send({ data: await accounting.recordExchangeRate(principal, body, eventOrigin(request)) });
  });

  // ---- Fiscal years and periods ----
  app.get(`${base}/fiscal-years`, async (request) => ({
    data: await accounting.listFiscalYears(requirePrincipal(request)),
  }));
  app.post(`${base}/fiscal-years`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(fiscalYearBody, request.body);
    return reply
      .status(201)
      .send({ data: await accounting.createFiscalYear(principal, body, eventOrigin(request)) });
  });
  app.get(`${base}/fiscal-years/:id`, async (request) => {
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await accounting.getFiscalYear(requirePrincipal(request), id) };
  });
  app.get(`${base}/periods`, async (request) => {
    const query = parseInput(periodQuery, request.query);
    return { data: await accounting.listPeriods(requirePrincipal(request), query) };
  });
  app.post(`${base}/periods/:id/close`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await accounting.closePeriod(principal, id, eventOrigin(request)) };
  });
  app.post(`${base}/periods/:id/reopen`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(reopenBody, request.body);
    const result = await accounting.reopenPeriod(principal, id, body.reason, eventOrigin(request));
    return reply.status(result.status === 'PENDING_APPROVAL' ? 202 : 200).send({ data: result });
  });

  // ---- Journals ----
  app.get(`${base}/journals`, async (request) => {
    const query = parseInput(journalQuery, request.query);
    return {
      data: await journals.listJournals(requirePrincipal(request), {
        statuses: query.status,
        limit: query.limit,
        before: query.before ? new Date(query.before) : undefined,
      }),
    };
  });
  app.post(`${base}/journals`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(journalBody, request.body);
    return reply
      .status(201)
      .send({ data: await journals.createJournal(principal, body, eventOrigin(request)) });
  });
  app.get(`${base}/journals/:id`, async (request) => {
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await journals.getJournal(requirePrincipal(request), id) };
  });
  app.patch(`${base}/journals/:id`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(journalPatch, request.body);
    return { data: await journals.updateJournal(principal, id, body, eventOrigin(request)) };
  });
  const action = (
    name: string,
    run: (
      principal: ReturnType<typeof requirePrincipal>,
      id: string,
      body: unknown,
      origin: ReturnType<typeof eventOrigin>,
    ) => Promise<unknown>,
  ) =>
    app.post(`${base}/journals/:id/${name}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParam('id'), request.params) as { id: string };
      return { data: await run(principal, id, request.body, eventOrigin(request)) };
    });
  action('submit', (p, id, _b, o) => journals.submitJournal(p, id, o));
  action('approve', (p, id, b, o) =>
    journals.decideJournal(p, id, 'approved', parseInput(decisionBody, b).comment ?? null, o),
  );
  action('reject', (p, id, b, o) =>
    journals.decideJournal(p, id, 'rejected', parseInput(decisionBody, b).comment ?? null, o),
  );
  action('withdraw', (p, id, _b, o) => journals.withdrawJournal(p, id, o));
  action('post', (p, id, _b, o) => journals.postJournal(p, id, o));
  action('reverse', (p, id, b, o) => journals.reverseJournal(p, id, parseInput(reverseBody, b), o));

  // ---- General ledger ----
  app.get(`${base}/ledger`, async (request) => {
    const query = parseInput(ledgerQuery, request.query);
    return { data: await accounting.ledger(requirePrincipal(request), query) };
  });
}
