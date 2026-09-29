import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountingService } from '../../application/accounting-service.js';
import type { DimensionService } from '../../application/dimension-service.js';
import type { JournalService } from '../../application/journal-service.js';
import type { OpeningBalanceService } from '../../application/opening-balance-service.js';
import {
  accountSubtypes,
  accountTypes,
  designations,
  journalStatuses,
} from '../../modules/accounting/index.js';
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
export const accountBody = z.object({
  code: accountCode,
  name: z.string().trim().min(1, 'Name is required.').max(200),
  description: z.string().trim().max(1000).default(''),
  type: z.enum(accountTypes),
  parentId: fields.id.nullable().default(null),
  currencyCode: currency.optional(),
  subtype: z.enum(accountSubtypes).nullable().optional(),
  isMonetary: z.boolean().optional(),
});
const accountPatch = z
  .object({
    code: accountCode,
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(1000),
    type: z.enum(accountTypes),
    parentId: fields.id.nullable(),
    currencyCode: currency,
    subtype: z.enum(accountSubtypes).nullable(),
    isMonetary: z.boolean(),
  })
  .partial();
const designationsBody = z
  .object(Object.fromEntries(designations.map((d) => [d, fields.id.nullable().optional()])))
  .strict();

export const rateBody = z.object({
  fromCurrency: currency,
  rateDate: isoDate,
  rate: decimalString,
});
const rateQuery = z.object({ fromCurrency: currency.optional() });

// S8: opening balances (strict contracts; amounts are decimal strings in the account's currency).
const conversionDateBody = z.object({ conversionDate: isoDate.nullable() }).strict();
const openingCreateBody = z.object({ notes: z.string().trim().max(1000).default('') }).strict();
const openingLine = z
  .object({
    accountId: fields.id,
    description: z.string().trim().max(500).default(''),
    debit: decimalString.nullable().default(null),
    credit: decimalString.nullable().default(null),
    baseAmount: decimalString.nullable().default(null),
    dimensions: z
      .array(z.object({ dimensionTypeId: fields.id, dimensionValueId: fields.id }).strict())
      .max(20)
      .default([]),
  })
  .strict();
const openingLinesBody = z
  .object({ version: z.number().int().min(1), lines: z.array(openingLine).max(5000) })
  .strict();
const openingVersionBody = z.object({ version: z.number().int().min(1) }).strict();
const openingReverseBody = z
  .object({ reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();

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

// Strict: manual journals never carry line kinds or explicit base amounts (Decision 10).
const journalLine = z
  .object({
    accountId: fields.id.nullable().default(null),
    description: z.string().trim().max(500).default(''),
    debit: decimalString.nullable().default(null),
    credit: decimalString.nullable().default(null),
    // Line-level only (Decision 85): no journal-header dimensions exist.
    // Omitted on an edit: the line keeps its current assignments (see JournalService).
    dimensions: z
      .array(z.object({ dimensionTypeId: fields.id, dimensionValueId: fields.id }).strict())
      .max(50)
      .optional(),
  })
  .strict();
// Strict: manual journals have no header-level dimensions (Decision 85) or other extra fields.
const journalBody = z
  .object({
    entryDate: isoDate.nullable().default(null),
    description: z.string().trim().max(1000).default(''),
    reference: z.string().trim().max(100).default(''),
    currency,
    exchangeRate: decimalString.nullable().default(null),
    lines: z.array(journalLine).max(500).default([]),
  })
  .strict();
const journalPatch = z
  .object({
    entryDate: isoDate.nullable(),
    description: z.string().trim().max(1000),
    reference: z.string().trim().max(100),
    currency,
    exchangeRate: decimalString.nullable(),
    lines: z.array(journalLine).max(500),
  })
  .partial()
  .strict();
const journalQuery = z.object({
  status: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter(Boolean))
    .pipe(z.array(z.enum(journalStatuses)).optional()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.iso.datetime({ offset: true }).optional(),
});
// Decision 83: journal action bodies are strict; submit/post/withdraw take an empty object.
const decisionBody = z.object({ comment: z.string().trim().max(1000).optional() }).strict();
const reverseBody = z
  .object({
    reason: z.string().trim().min(3, 'A reason is required.').max(1000),
    reversalDate: isoDate.optional(),
  })
  .strict();
const emptyBody = z.object({}).strict();
const dimensionCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, 'Codes are 1-20 letters, digits, ".", "_" or "-".');
const dimensionScope = z
  .object({
    accountTypes: z.array(z.enum(accountTypes)).max(accountTypes.length),
    accountSubtypes: z.array(z.enum(accountSubtypes)).max(accountSubtypes.length),
  })
  .strict();
const dimensionTypeBody = z
  .object({
    code: dimensionCode,
    name: z.string().trim().min(1, 'Name is required.').max(100),
    description: z.string().trim().max(500).default(''),
    isRequired: z.boolean().default(false),
    scope: dimensionScope.default({ accountTypes: [], accountSubtypes: [] }),
  })
  .strict();
const dimensionTypePatch = z
  .object({
    code: dimensionCode,
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500),
    isRequired: z.boolean(),
    scope: dimensionScope,
  })
  .partial()
  .strict();
export const dimensionValueBody = z
  .object({ code: dimensionCode, name: z.string().trim().min(1, 'Name is required.').max(100) })
  .strict();
const dimensionValuePatch = dimensionValueBody.partial().strict();
const typeValueParams = z.object({ id: fields.id, valueId: fields.id });

export const ledgerQuery = z.object({
  accountId: fields.id.optional(),
  // S3-19: fiscal_year makes a P&L account's opening match the Trial Balance.
  openingBasis: z.enum(['cumulative', 'fiscal_year']).default('cumulative'),
  dimensionValueIds: z
    .string()
    .optional()
    .transform((value) => value?.split(',').filter(Boolean))
    .pipe(z.array(fields.id).max(20).optional()),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

/** /api/v1/accounting — every route resolves the organization from the session. */
export function registerAccountingRoutes(
  app: FastifyInstance,
  deps: {
    accounting: AccountingService;
    journals: JournalService;
    dimensions: DimensionService;
    openingBalances: OpeningBalanceService;
  },
): void {
  const { accounting, journals, dimensions, openingBalances } = deps;
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

  // ---- System account designations ----
  app.get(`${base}/designations`, async (request) => ({
    data: await accounting.listDesignations(requirePrincipal(request)),
  }));
  app.put(`${base}/designations`, async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(designationsBody, request.body) as Record<string, string | null>;
    return {
      data: await accounting.updateDesignations(principal, body, eventOrigin(request)),
    };
  });

  // ---- Dimensions (Decisions 3, 16, 84) ----
  app.get(`${base}/dimensions`, async (request) => ({
    data: await dimensions.listDimensions(requirePrincipal(request)),
  }));
  app.post(`${base}/dimensions`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(dimensionTypeBody, request.body);
    return reply
      .status(201)
      .send({ data: await dimensions.createType(principal, body, eventOrigin(request)) });
  });
  app.patch(`${base}/dimensions/:id`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(dimensionTypePatch, request.body);
    return { data: await dimensions.updateType(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`${base}/dimensions/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParam('id'), request.params) as { id: string };
      return { data: await dimensions.setTypeStatus(principal, id, status, eventOrigin(request)) };
    });
    app.post(`${base}/dimensions/:id/values/:valueId/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id, valueId } = parseInput(typeValueParams, request.params);
      return {
        data: await dimensions.setValueStatus(principal, id, valueId, status, eventOrigin(request)),
      };
    });
  }
  app.post(`${base}/dimensions/:id/values`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(dimensionValueBody, request.body);
    return reply
      .status(201)
      .send({ data: await dimensions.createValue(principal, id, body, eventOrigin(request)) });
  });
  app.patch(`${base}/dimensions/:id/values/:valueId`, async (request) => {
    const principal = requirePrincipal(request);
    const { id, valueId } = parseInput(typeValueParams, request.params);
    const body = parseInput(dimensionValuePatch, request.body);
    return {
      data: await dimensions.updateValue(principal, id, valueId, body, eventOrigin(request)),
    };
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
  const noBody = (body: unknown) => parseInput(emptyBody, body ?? {});
  action('submit', (p, id, b, o) => (noBody(b), journals.submitJournal(p, id, o)));
  action('approve', (p, id, b, o) =>
    journals.decideJournal(p, id, 'approved', parseInput(decisionBody, b).comment ?? null, o),
  );
  action('reject', (p, id, b, o) =>
    journals.decideJournal(p, id, 'rejected', parseInput(decisionBody, b).comment ?? null, o),
  );
  action('withdraw', (p, id, b, o) => (noBody(b), journals.withdrawJournal(p, id, o)));
  action('post', (p, id, b, o) => (noBody(b), journals.postJournal(p, id, o)));
  action('reverse', (p, id, b, o) => journals.reverseJournal(p, id, parseInput(reverseBody, b), o));
  // L-9: a never-submitted imported draft may be discarded (kept as DISCARDED, never deleted).
  action('discard', (p, id, b, o) => (noBody(b), journals.discardImportedDraft(p, id, o)));

  // ---- Opening balances (S8) ----
  app.get(`${base}/settings/conversion-date`, async (request) => ({
    data: await openingBalances.getConversionDate(requirePrincipal(request)),
  }));
  app.put(`${base}/settings/conversion-date`, async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(conversionDateBody, request.body);
    return {
      data: await openingBalances.setConversionDate(principal, body, eventOrigin(request)),
    };
  });
  app.get(`${base}/opening-balances`, async (request) => ({
    data: await openingBalances.list(requirePrincipal(request)),
  }));
  app.post(`${base}/opening-balances`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(openingCreateBody, request.body);
    return reply
      .status(201)
      .send({ data: await openingBalances.create(principal, body, eventOrigin(request)) });
  });
  app.get(`${base}/opening-balances/:id`, async (request) => {
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    return { data: await openingBalances.get(requirePrincipal(request), id) };
  });
  app.put(`${base}/opening-balances/:id/lines`, async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    const body = parseInput(openingLinesBody, request.body);
    return {
      data: await openingBalances.replaceLines(principal, id, body, eventOrigin(request)),
    };
  });
  app.delete(`${base}/opening-balances/:id`, async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParam('id'), request.params) as { id: string };
    await openingBalances.delete(principal, id, eventOrigin(request));
    return reply.status(204).send();
  });
  const openingAction = (
    name: string,
    run: (
      principal: ReturnType<typeof requirePrincipal>,
      id: string,
      body: unknown,
      origin: ReturnType<typeof eventOrigin>,
    ) => Promise<unknown>,
  ) =>
    app.post(`${base}/opening-balances/:id/${name}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParam('id'), request.params) as { id: string };
      return { data: await run(principal, id, request.body, eventOrigin(request)) };
    });
  openingAction(
    'preview',
    (p, id, b) => (parseInput(emptyBody, b ?? {}), openingBalances.preview(p, id)),
  );
  openingAction('submit', (p, id, b, o) =>
    openingBalances.submit(p, id, parseInput(openingVersionBody, b), o),
  );
  openingAction(
    'withdraw',
    (p, id, b, o) => (parseInput(emptyBody, b ?? {}), openingBalances.withdraw(p, id, o)),
  );
  openingAction('post', (p, id, b, o) =>
    openingBalances.post(p, id, parseInput(openingVersionBody, b), o),
  );
  openingAction('reverse', (p, id, b, o) =>
    openingBalances.reverse(p, id, parseInput(openingReverseBody, b), o),
  );

  // ---- General ledger ----
  app.get(`${base}/ledger`, async (request) => {
    const query = parseInput(ledgerQuery, request.query);
    return { data: await accounting.ledger(requirePrincipal(request), query) };
  });
}
