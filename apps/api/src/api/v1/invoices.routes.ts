import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvoiceService } from '../../application/invoice-service.js';
import { discountTypes, invoiceKinds, invoiceStatuses } from '../../modules/sales/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Invoices (Phase 3B steps 6–7). Strict schemas; decimals as strings; totals from the server. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const decimalString = (places: number, message: string) =>
  z.string().regex(new RegExp(`^(0|[1-9]\\d{0,21})(\\.\\d{1,${places}})?$`), message);
export const discount = z
  .object({
    type: z.enum(discountTypes),
    value: decimalString(4, 'Enter a non-negative discount with up to 4 decimals.'),
  })
  .strict();
export const dimensionValueIds = z.array(fields.id).max(20);

export const lineBody = z
  .object({
    itemId: fields.id.nullable().optional(),
    description: z.string().trim().max(1000).optional(),
    quantity: decimalString(6, 'Enter a quantity with up to 6 decimals.').refine(
      (v) => Number(v) > 0,
      'The quantity must be greater than zero.',
    ),
    unitPrice: decimalString(6, 'Enter a non-negative price with up to 6 decimals.').optional(),
    discount: discount.nullable().optional(),
    taxCodeId: fields.id.nullable().optional(),
    revenueAccountId: fields.id.nullable().optional(),
    dimensionValueIds: dimensionValueIds.optional(),
  })
  .strict();

const draftShape = {
  customerId: fields.id,
  invoiceDate: isoDate,
  dueDate: isoDate.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
    .optional(),
  taxTreatment: z.enum(taxTreatments).optional(),
  discount: discount.nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  dimensionValueIds: dimensionValueIds.optional(),
  lines: z.array(lineBody).min(1, 'Add at least one line.').max(500),
  // D5: the explicit base carrying value of a foreign-currency opening invoice.
  openingBaseTotal: z
    .string()
    .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.')
    .nullable()
    .optional(),
};
const createBody = z.object({ ...draftShape, kind: z.enum(invoiceKinds).optional() }).strict();
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
      .pipe(z.array(z.enum(invoiceStatuses)).max(4))
      .optional(),
    customerId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    open: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerInvoiceRoutes(
  app: FastifyInstance,
  { invoices }: { invoices: InvoiceService },
) {
  app.get('/sales/invoices', async (request) => ({
    data: await invoices.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/sales/invoices', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(createBody, request.body) as Parameters<InvoiceService['create']>[1];
    const result = await invoices.create(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/invoices/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await invoices.get(requirePrincipal(request), id) };
  });
  app.put('/sales/invoices/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<InvoiceService['update']>[2];
    return { data: await invoices.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/sales/invoices/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return { data: await invoices.delete(principal, id, { version }, eventOrigin(request)) };
  });
  app.post('/sales/invoices/:id/submit', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await invoices.submit(principal, id, body, eventOrigin(request)) };
  });
  app.post('/sales/invoices/:id/withdraw', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await invoices.withdraw(principal, id, body, eventOrigin(request)) };
  });
  app.post('/sales/invoices/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await invoices.void(principal, id, body, eventOrigin(request)) };
  });
  app.post('/sales/invoices/:id/issue', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const result = await invoices.issue(
      principal,
      id,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
}
