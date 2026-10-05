import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_BATCH_BILLS,
  type PaymentBatchService,
} from '../../application/payment-batch-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Batch "Pay bills" (Phase 4B-4; ADR 0004 P4-32, P4-50). Strict schemas; decimals as strings;
 * every amount, rate, base and realized FX comes from the server through the 4B-2 payments.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
const recordBody = z
  .object({
    paymentDate: isoDate,
    accounts: z
      .array(z.object({ currencyCode, paymentAccountId: fields.id }).strict())
      .max(20)
      .optional(),
    rateOverrides: z
      .array(
        z
          .object({
            currencyCode,
            rate: z
              .string()
              .regex(/^\d{1,18}(\.\d{1,10})?$/, 'Enter a positive rate with up to 10 decimals.'),
            reason: z.string().trim().min(1, 'Give a reason for the manual rate.').max(500),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    memo: z.string().trim().max(2000).optional(),
    // D5: at most 2,000 bills per batch (P4-50's per-payment and vendor limits also apply).
    bills: z
      .array(
        z
          .object({
            billId: fields.id,
            amount: z
              .string()
              .regex(
                /^(0|[1-9]\d{0,21})(\.\d{1,4})?$/,
                'Enter a positive amount with up to 4 decimals.',
              ),
          })
          .strict(),
      )
      .min(1, 'Choose at least one bill.')
      .max(MAX_BATCH_BILLS, `A batch pays at most ${MAX_BATCH_BILLS} bills.`),
  })
  .strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const openBillsQuery = z
  .object({
    vendorId: fields.id.optional(),
    currencyCode: currencyCode.optional(),
    dueBefore: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_BATCH_BILLS).default(500),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();
/**
 * 2,000 bills of `{ billId, amount }` exceed the app-wide 64 KB body limit, so this one route
 * allows 512 KB (about three times the largest valid batch); the schema still caps the content.
 */
const BATCH_BODY_LIMIT = 512 * 1024;

export function registerPaymentBatchRoutes(
  app: FastifyInstance,
  { paymentBatches }: { paymentBatches: PaymentBatchService },
) {
  app.get('/purchases/pay-bills/open-bills', async (request) => ({
    data: await paymentBatches.payableBills(
      requirePrincipal(request),
      parseInput(openBillsQuery, request.query),
    ),
  }));
  app.get('/purchases/payment-batches', async (request) => ({
    data: await paymentBatches.list(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post(
    '/purchases/payment-batches',
    { bodyLimit: BATCH_BODY_LIMIT },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const key = idempotencyKey(request);
      const body = parseInput(recordBody, request.body);
      const result = await paymentBatches.record(
        principal,
        body,
        { idempotencyKey: key },
        eventOrigin(request),
      );
      markReplay(reply, result.replayed);
      return reply.status(201).send({ data: result.value });
    },
  );
  app.get('/purchases/payment-batches/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await paymentBatches.get(requirePrincipal(request), id) };
  });
}
