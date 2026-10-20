import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QuoteService } from '../../application/quote-service.js';
import type { RecurringInvoiceService } from '../../application/recurring-invoice-service.js';
import { frequencies, quoteStatuses, scheduleStatuses } from '../../modules/quotes/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Sales quotes and recurring invoice schedules (FP-28). Strict schemas; amounts are decimal
 * strings. Neither posts to the ledger: a quote converts into, and a schedule generates, DRAFT
 * sales invoices. Converting and generating also need `invoices.create`.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const versionBody = z.object({ version }).strict();
const line = z
  .object({
    itemId: fields.id.nullable().optional(),
    description: z.string().trim().max(500).optional(),
    quantity: amount,
    unitPrice: amount,
    taxCodeId: fields.id.nullable().optional(),
  })
  .strict();

const quoteBody = {
  customerId: fields.id,
  quoteDate: isoDate,
  validUntil: isoDate,
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  lines: z.array(line).min(1).max(200),
};
const quoteCreate = z.object(quoteBody).strict();
const quoteUpdate = z.object({ version, ...quoteBody }).strict();
const quoteList = z
  .object({
    status: z.enum(quoteStatuses).optional(),
    customerId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const declineBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const convertBody = z.object({ version, invoiceDate: isoDate.optional() }).strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();

const scheduleBody = {
  name: z.string().trim().min(1).max(150),
  customerId: fields.id,
  frequency: z.enum(frequencies),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  lines: z.array(line).min(1).max(100),
};
const scheduleCreate = z.object(scheduleBody).strict();
const scheduleUpdate = z.object({ version, ...scheduleBody }).strict();
const scheduleList = z.object({ status: z.enum(scheduleStatuses).optional() }).strict();

export function registerQuoteRoutes(
  app: FastifyInstance,
  { quotes, recurring }: { quotes: QuoteService; recurring: RecurringInvoiceService },
) {
  app.get('/sales/quotes', async (request) => ({
    data: await quotes.list(requirePrincipal(request), parseInput(quoteList, request.query)),
  }));
  app.post('/sales/quotes', async (request, reply) => {
    const result = await quotes.create(
      requirePrincipal(request),
      parseInput(quoteCreate, request.body),
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/quotes/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await quotes.get(requirePrincipal(request), id) };
  });
  app.put('/sales/quotes/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await quotes.update(
        requirePrincipal(request),
        id,
        parseInput(quoteUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.delete('/sales/quotes/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await quotes.delete(
        requirePrincipal(request),
        id,
        parseInput(deleteQuery, request.query),
        eventOrigin(request),
      ),
    };
  });
  for (const [action, method] of [
    ['send', 'send'],
    ['accept', 'accept'],
  ] as const) {
    app.post(`/sales/quotes/:id/${action}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      return {
        data: await quotes[method](
          requirePrincipal(request),
          id,
          parseInput(versionBody, request.body),
          eventOrigin(request),
        ),
      };
    });
  }
  app.post('/sales/quotes/:id/decline', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await quotes.decline(
        requirePrincipal(request),
        id,
        parseInput(declineBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/sales/quotes/:id/convert', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await quotes.convert(
        requirePrincipal(request),
        id,
        parseInput(convertBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/sales/recurring-invoices', async (request) => ({
    data: await recurring.list(requirePrincipal(request), parseInput(scheduleList, request.query)),
  }));
  app.post('/sales/recurring-invoices', async (request, reply) =>
    reply.status(201).send({
      data: await recurring.create(
        requirePrincipal(request),
        parseInput(scheduleCreate, request.body),
        eventOrigin(request),
      ),
    }),
  );
  app.get('/sales/recurring-invoices/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await recurring.get(requirePrincipal(request), id) };
  });
  app.put('/sales/recurring-invoices/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await recurring.update(
        requirePrincipal(request),
        id,
        parseInput(scheduleUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  for (const [action, method] of [
    ['pause', 'pause'],
    ['resume', 'resume'],
    ['end', 'end'],
    ['run-now', 'runNow'],
  ] as const) {
    app.post(`/sales/recurring-invoices/:id/${action}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      return {
        data: await recurring[method](
          requirePrincipal(request),
          id,
          parseInput(versionBody, request.body),
          eventOrigin(request),
        ),
      };
    });
  }
}
