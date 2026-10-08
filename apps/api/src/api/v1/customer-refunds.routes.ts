import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustomerRefundService } from '../../application/customer-refund-service.js';
import { customerRefundStatuses } from '../../modules/sales/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Customer refunds (mirrors vendor refunds). Strict schemas; decimals as strings; base amounts
 * and realized FX come from the server. No drafts and no approval.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const recordBody = z
  .object({
    sourceType: z.enum(['receipt', 'credit_note']),
    sourceId: fields.id,
    refundDate: isoDate,
    amount: z
      .string()
      .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter a positive amount with up to 4 decimals.'),
    refundAccountId: fields.id.nullable().optional(),
    rateOverride: z
      .string()
      .regex(/^\d{1,18}(\.\d{1,10})?$/, 'Enter a positive rate with up to 10 decimals.')
      .nullable()
      .optional(),
    rateOverrideReason: z.string().trim().max(500).nullable().optional(),
    reference: z.string().trim().max(100).nullable().optional(),
    memo: z.string().trim().max(2000).optional(),
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
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(customerRefundStatuses)).max(2))
      .optional(),
    customerId: fields.id.optional(),
    receiptId: fields.id.optional(),
    creditNoteId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerCustomerRefundRoutes(
  app: FastifyInstance,
  { customerRefunds }: { customerRefunds: CustomerRefundService },
) {
  app.get('/sales/refunds', async (request) => ({
    data: await customerRefunds.list(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/sales/refunds', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(recordBody, request.body);
    const result = await customerRefunds.record(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/refunds/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await customerRefunds.get(requirePrincipal(request), id) };
  });
  app.post('/sales/refunds/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await customerRefunds.void(principal, id, body, eventOrigin(request)) };
  });
}
