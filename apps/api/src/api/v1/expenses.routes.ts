import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExpenseService } from '../../application/expense-service.js';
import { discountTypes } from '../../modules/documents/index.js';
import { expenseStatuses } from '../../modules/purchases/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Direct expenses (Phase 4B-9; ADR 0004 P4-37, P4-39, P4-42, P4-44). Strict schemas; decimals as
 * strings; totals from the server. Approve and reject use the shared approval routes
 * (/approvals/requests/:id/...).
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
    // P4-12: an explicit choice (null: the default applies).
    taxRecoverable: z.boolean().nullable().optional(),
    dimensionValueIds: dimensionValueIds.optional(),
  })
  .strict();

const draftShape = {
  vendorId: fields.id,
  expenseDate: isoDate,
  // The supplier's receipt or invoice number; optional.
  vendorReference: z.string().trim().max(100).nullable().optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
    .optional(),
  // The bank, cash or card account paid from (P4-26); the Purchases default when omitted.
  paymentAccountId: fields.id.nullable().optional(),
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
const createBody = z.object(draftShape).strict();
const updateBody = z.object({ version: z.number().int().min(1), ...draftShape }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const voidBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason for the void.').max(500),
  })
  .strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(expenseStatuses)).max(4))
      .optional(),
    vendorId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerExpenseRoutes(
  app: FastifyInstance,
  { expenses }: { expenses: ExpenseService },
) {
  app.get('/purchases/expenses', async (request) => ({
    data: await expenses.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/purchases/expenses', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(createBody, request.body) as Parameters<ExpenseService['create']>[1];
    const result = await expenses.create(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/expenses/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await expenses.get(requirePrincipal(request), id) };
  });
  app.put('/purchases/expenses/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<ExpenseService['update']>[2];
    return { data: await expenses.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/purchases/expenses/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return { data: await expenses.delete(principal, id, { version }, eventOrigin(request)) };
  });
  app.post('/purchases/expenses/:id/submit', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await expenses.submit(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/expenses/:id/withdraw', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await expenses.withdraw(principal, id, body, eventOrigin(request)) };
  });
  app.post('/purchases/expenses/:id/post', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const result = await expenses.post(
      principal,
      id,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
  app.post('/purchases/expenses/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await expenses.void(principal, id, body, eventOrigin(request)) };
  });
}
