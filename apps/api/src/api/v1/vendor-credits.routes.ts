import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PurchasesOutputService } from '../../application/purchases-output-service.js';
import type { VendorCreditService } from '../../application/vendor-credit-service.js';
import { discountTypes } from '../../modules/documents/index.js';
import { vendorCreditOrigins, vendorCreditStatuses } from '../../modules/purchases/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Vendor credits and debit notes (Phase 4B-1; ADR 0004 P4-23, P4-24, P4-37, P4-46). Strict
 * schemas; decimals as strings; totals from the server. Approve and reject use the shared
 * approval routes (/approvals/requests/:id/...).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const decimalString = (places: number, message: string) =>
  z.string().regex(new RegExp(`^(0|[1-9]\\d{0,21})(\\.\\d{1,${places}})?$`), message);
const discount = z
  .object({
    type: z.enum(discountTypes),
    value: decimalString(4, 'Enter a non-negative discount with up to 4 decimals.'),
  })
  .strict();
const dimensionValueIds = z.array(fields.id).max(20);

const lineBody = z
  .object({
    itemId: fields.id.nullable().optional(),
    description: z.string().trim().max(1000).optional(),
    accountId: fields.id.nullable().optional(),
    quantity: decimalString(6, 'Enter a quantity with up to 6 decimals.').refine(
      (v) => Number(v) > 0,
      'The quantity must be greater than zero.',
    ),
    unitPrice: decimalString(6, 'Enter a non-negative price with up to 6 decimals.').optional(),
    discount: discount.nullable().optional(),
    taxCodeId: fields.id.nullable().optional(),
    taxRecoverable: z.boolean().nullable().optional(),
    dimensionValueIds: dimensionValueIds.optional(),
  })
  .strict();

const draftShape = {
  vendorId: fields.id,
  creditDate: isoDate,
  // An optional reference to a posted bill of the same vendor (not applied, decided 2026-10-03).
  billId: fields.id.nullable().optional(),
  // Supplier credit notes: the supplier's credit-note number (required to post).
  vendorReference: z.string().trim().max(100).nullable().optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
    .optional(),
  rateOverride: z
    .string()
    .regex(/^\d{1,18}(\.\d{1,10})?$/, 'Enter a positive rate with up to 10 decimals.')
    .nullable()
    .optional(),
  rateOverrideReason: z.string().trim().max(500).nullable().optional(),
  taxTreatment: z.enum(taxTreatments).optional(),
  discount: discount.nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  dimensionValueIds: dimensionValueIds.optional(),
  // P4-50: at most 200 lines.
  lines: z.array(lineBody).min(1, 'Add at least one line.').max(200),
};
const createBody = z.object({ origin: z.enum(vendorCreditOrigins), ...draftShape }).strict();
const updateBody = z.object({ version: z.number().int().min(1), ...draftShape }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const voidBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason for the void.').max(500),
  })
  .strict();
const emailBody = z
  .object({
    to: z.email({ error: 'Enter a valid email address.' }).max(254).optional(),
    subject: z.string().trim().max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(vendorCreditStatuses)).max(4))
      .optional(),
    origin: z.enum(vendorCreditOrigins).optional(),
    vendorId: fields.id.optional(),
    billId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerVendorCreditRoutes(
  app: FastifyInstance,
  {
    vendorCredits,
    purchasesOutput,
  }: { vendorCredits: VendorCreditService; purchasesOutput: PurchasesOutputService },
) {
  app.get('/purchases/vendor-credits', async (request) => ({
    data: await vendorCredits.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/purchases/vendor-credits', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(createBody, request.body) as Parameters<
      VendorCreditService['create']
    >[1];
    const result = await vendorCredits.create(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/vendor-credits/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendorCredits.get(requirePrincipal(request), id) };
  });
  app.put('/purchases/vendor-credits/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<
      VendorCreditService['update']
    >[2];
    return { data: await vendorCredits.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/purchases/vendor-credits/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return { data: await vendorCredits.delete(principal, id, { version }, eventOrigin(request)) };
  });
  app.post('/purchases/vendor-credits/:id/submit', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await vendorCredits.submit(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/vendor-credits/:id/withdraw', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await vendorCredits.withdraw(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/vendor-credits/:id/post', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const result = await vendorCredits.post(
      principal,
      id,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
  app.post('/purchases/vendor-credits/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await vendorCredits.void(principal, id, body, eventOrigin(request)) };
  });
  // Debit notes: the immutable PDF and email (P4-46).
  app.get('/purchases/vendor-credits/:id/pdf', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await purchasesOutput.pdf(requirePrincipal(request), id) };
  });
  app.get('/purchases/vendor-credits/:id/emails', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await purchasesOutput.emails(requirePrincipal(request), id) };
  });
  app.post('/purchases/vendor-credits/:id/email', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(emailBody, request.body);
    return reply.status(202).send({
      data: await purchasesOutput.requestEmail(principal, id, body, eventOrigin(request)),
    });
  });
}
