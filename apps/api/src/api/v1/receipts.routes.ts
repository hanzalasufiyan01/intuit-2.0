import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ReceiptService } from '../../application/receipt-service.js';
import { receiptStatuses } from '../../modules/sales/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Receipts, allocations and customer credit (Phase 3B steps 8–11). Strict schemas. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const allocations = z.array(z.object({ invoiceId: fields.id, amount }).strict()).max(200);

const recordBody = z
  .object({
    customerId: fields.id,
    receiptDate: isoDate,
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
      .optional(),
    amount,
    depositAccountId: fields.id.optional(),
    exchangeRate: z
      .string()
      .regex(/^(0|[1-9]\d{0,17})(\.\d{1,10})?$/, 'Enter a rate with up to 10 decimals.')
      .optional(),
    rateOverrideReason: z.string().trim().max(500).optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    memo: z.string().trim().max(2000).optional(),
    allocations: allocations.default([]),
  })
  .strict();
const applyBody = z
  .object({
    sourceType: z.enum(['receipt', 'credit_note']),
    sourceId: fields.id,
    date: isoDate,
    allocations: allocations.min(1, 'Choose at least one invoice.'),
  })
  .strict();
const voidBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason for the void.').max(500),
  })
  .strict();
const listQuery = z
  .object({
    status: z.enum(receiptStatuses).optional(),
    customerId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    withCredit: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerReceiptRoutes(
  app: FastifyInstance,
  { receipts }: { receipts: ReceiptService },
) {
  app.get('/sales/receipts', async (request) => ({
    data: await receipts.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/sales/receipts', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(recordBody, request.body) as Parameters<ReceiptService['record']>[1];
    const result = await receipts.record(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/receipts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await receipts.get(requirePrincipal(request), id) };
  });
  app.post('/sales/receipts/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await receipts.void(principal, id, body, eventOrigin(request)) };
  });
  app.post('/sales/customer-credit/apply', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(applyBody, request.body);
    const result = await receipts.applyCredit(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
}
