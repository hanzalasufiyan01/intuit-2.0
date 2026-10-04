import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  MAX_PAYMENT_BILLS,
  type VendorPaymentService,
} from '../../application/vendor-payment-service.js';
import { paymentStatuses } from '../../modules/purchases/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Vendor payments, prepayments and AP credit application (Phase 4B-2; ADR 0004 P4-25 to P4-29,
 * P4-33, P4-50). Strict schemas; decimals as strings; base amounts and FX from the server.
 * Approve and reject use the shared approval routes (/approvals/requests/:id/...).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter a positive amount with up to 4 decimals.');
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
// P4-50 / C1: at most 497 bills per payment (the 500-line journal cap).
const allocations = z
  .array(z.object({ billId: fields.id, amount }).strict())
  .max(MAX_PAYMENT_BILLS, `Settle at most ${MAX_PAYMENT_BILLS} bills at once.`);

const draftShape = {
  vendorId: fields.id,
  paymentDate: isoDate,
  currencyCode: currencyCode.optional(),
  amount,
  // P4-28: overrides the Purchases default payment account.
  paymentAccountId: fields.id.nullable().optional(),
  // P4-27: overrides the table rate; a reason is mandatory.
  rateOverride: z
    .string()
    .regex(/^\d{1,18}(\.\d{1,10})?$/, 'Enter a positive rate with up to 10 decimals.')
    .nullable()
    .optional(),
  rateOverrideReason: z.string().trim().max(500).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  // Planned allocations to posted bills only (C2).
  allocations,
};
const createBody = z.object(draftShape).strict();
const updateBody = z.object({ version: z.number().int().min(1), ...draftShape }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const voidBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason for the void.').max(500),
  })
  .strict();
const applyBody = z
  .object({
    sourceType: z.enum(['vendor_credit', 'payment']),
    sourceId: fields.id,
    date: isoDate,
    allocations: allocations.min(1, 'Choose at least one bill.'),
  })
  .strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(paymentStatuses)).max(4))
      .optional(),
    vendorId: fields.id.optional(),
    withUnallocated: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const openBillsQuery = z.object({ vendorId: fields.id, currencyCode }).strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerVendorPaymentRoutes(
  app: FastifyInstance,
  { vendorPayments }: { vendorPayments: VendorPaymentService },
) {
  app.get('/purchases/payments', async (request) => ({
    data: await vendorPayments.list(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/purchases/payments', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(createBody, request.body);
    const result = await vendorPayments.create(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/payments/open-bills', async (request) => ({
    data: await vendorPayments.openBills(
      requirePrincipal(request),
      parseInput(openBillsQuery, request.query),
    ),
  }));
  app.get('/purchases/payments/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendorPayments.get(requirePrincipal(request), id) };
  });
  app.put('/purchases/payments/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body);
    return { data: await vendorPayments.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/purchases/payments/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return { data: await vendorPayments.delete(principal, id, { version }, eventOrigin(request)) };
  });
  app.post('/purchases/payments/:id/submit', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await vendorPayments.submit(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/payments/:id/withdraw', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await vendorPayments.withdraw(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/payments/:id/record', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const result = await vendorPayments.record(
      principal,
      id,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
  app.post('/purchases/payments/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await vendorPayments.void(principal, id, body, eventOrigin(request)) };
  });
  // A2, A3: a vendor credit or a payment's prepayment applied to posted bills.
  app.post('/purchases/credit-applications', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(applyBody, request.body);
    const result = await vendorPayments.applyCredit(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  // Settlement history (payments, applications and their reversals).
  app.get('/purchases/bills/:id/allocations', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendorPayments.billAllocations(requirePrincipal(request), id) };
  });
  app.get('/purchases/vendor-credits/:id/allocations', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendorPayments.vendorCreditAllocations(requirePrincipal(request), id) };
  });
}
