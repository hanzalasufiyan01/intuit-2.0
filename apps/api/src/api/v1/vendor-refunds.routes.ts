import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VendorRefundService } from '../../application/vendor-refund-service.js';
import { refundStatuses } from '../../modules/purchases/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Vendor refunds (Phase 4B-3; ADR 0004 P4-30, P4-33, P4-42). Strict schemas; decimals as strings;
 * base amounts and realized FX come from the server. No drafts and no approval.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const recordBody = z
  .object({
    sourceType: z.enum(['payment', 'vendor_credit']),
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
      .pipe(z.array(z.enum(refundStatuses)).max(2))
      .optional(),
    vendorId: fields.id.optional(),
    paymentId: fields.id.optional(),
    vendorCreditId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerVendorRefundRoutes(
  app: FastifyInstance,
  { vendorRefunds }: { vendorRefunds: VendorRefundService },
) {
  app.get('/purchases/refunds', async (request) => ({
    data: await vendorRefunds.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/purchases/refunds', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(recordBody, request.body);
    const result = await vendorRefunds.record(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/refunds/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendorRefunds.get(requirePrincipal(request), id) };
  });
  app.post('/purchases/refunds/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await vendorRefunds.void(principal, id, body, eventOrigin(request)) };
  });
}
