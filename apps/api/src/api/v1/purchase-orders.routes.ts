import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BillService } from '../../application/bill-service.js';
import type { PurchaseOrderService } from '../../application/purchase-order-service.js';
import { discountTypes } from '../../modules/documents/index.js';
import { matchModes, orderStatuses } from '../../modules/purchase-orders/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Purchase orders, goods receipts and three-way matching. Strict schemas; decimals as strings;
 * totals from the server. Approve and reject use the shared approval routes
 * (/approvals/requests/:id/...). An order creates no journal.
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
    dimensionValueIds: z.array(fields.id).max(20).optional(),
  })
  .strict();

const draftShape = {
  vendorId: fields.id,
  orderDate: isoDate,
  expectedDate: isoDate.nullable().optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
    .optional(),
  taxTreatment: z.enum(taxTreatments).optional(),
  discount: discount.nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  dimensionValueIds: z.array(fields.id).max(20).optional(),
  lines: z.array(lineBody).min(1, 'Add at least one line.').max(200),
};
const createBody = z.object(draftShape).strict();
const updateBody = z.object({ version: z.number().int().min(1), ...draftShape }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const closeBody = z
  .object({ version: z.number().int().min(1), reason: z.string().trim().max(500).optional() })
  .strict();
const reasonBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason.').max(500),
  })
  .strict();
const receiptBody = z
  .object({
    receiptDate: isoDate,
    reference: z.string().trim().max(100).nullable().optional(),
    memo: z.string().trim().max(2000).optional(),
    lines: z
      .array(
        z
          .object({
            orderLineId: fields.id,
            quantity: decimalString(6, 'Enter a quantity with up to 6 decimals.'),
          })
          .strict(),
      )
      .min(1, 'Add at least one line.')
      .max(200),
  })
  .strict();
const createBillBody = z
  .object({
    basis: z.enum(['received', 'ordered']).default('received'),
    billDate: isoDate,
    vendorReference: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
const linkBillBody = z.object({ billId: fields.id }).strict();
const settingsBody = z
  .object({
    version: z.number().int().min(0),
    matchMode: z.enum(matchModes),
    quantityTolerancePct: z.string().max(10),
    priceTolerancePct: z.string().max(10),
  })
  .strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(orderStatuses)).max(7))
      .optional(),
    vendorId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const receiptsQuery = z.object({ orderId: fields.id.optional() }).strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerPurchaseOrderRoutes(
  app: FastifyInstance,
  { purchaseOrders, bills }: { purchaseOrders: PurchaseOrderService; bills: BillService },
) {
  app.get('/purchases/order-settings', async (request) => ({
    data: await purchaseOrders.getSettings(requirePrincipal(request)),
  }));
  app.put('/purchases/order-settings', async (request) => {
    const body = parseInput(settingsBody, request.body);
    return {
      data: await purchaseOrders.updateSettings(
        requirePrincipal(request),
        body,
        eventOrigin(request),
      ),
    };
  });
  app.get('/purchases/reports/commitments', async (request) => ({
    data: await purchaseOrders.commitments(requirePrincipal(request)),
  }));

  app.get('/purchases/orders', async (request) => ({
    data: await purchaseOrders.list(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/purchases/orders', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body) as Parameters<
      PurchaseOrderService['create']
    >[1];
    const result = await purchaseOrders.create(
      principal,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/orders/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await purchaseOrders.get(requirePrincipal(request), id) };
  });
  app.put('/purchases/orders/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<
      PurchaseOrderService['update']
    >[2];
    return {
      data: await purchaseOrders.update(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.delete('/purchases/orders/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return {
      data: await purchaseOrders.delete(
        requirePrincipal(request),
        id,
        { version },
        eventOrigin(request),
      ),
    };
  });
  for (const action of ['submit', 'withdraw'] as const) {
    app.post(`/purchases/orders/:id/${action}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await purchaseOrders[action](
          requirePrincipal(request),
          id,
          body,
          eventOrigin(request),
        ),
      };
    });
  }
  app.post('/purchases/orders/:id/close', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(closeBody, request.body);
    return {
      data: await purchaseOrders.close(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/purchases/orders/:id/cancel', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await purchaseOrders.cancel(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });

  // Goods receiving
  app.post('/purchases/orders/:id/receipts', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(receiptBody, request.body);
    const result = await purchaseOrders.receive(
      requirePrincipal(request),
      id,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/purchases/receipts', async (request) => {
    const query = parseInput(receiptsQuery, request.query);
    return {
      data: await purchaseOrders.listReceipts(requirePrincipal(request), query.orderId ?? null),
    };
  });
  app.get('/purchases/receipts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await purchaseOrders.getReceipt(requirePrincipal(request), id) };
  });
  app.post('/purchases/receipts/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await purchaseOrders.voidReceipt(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });

  // Bills: convert an order into a linked draft bill, or link an existing draft
  app.post('/purchases/orders/:id/create-bill', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(createBillBody, request.body);
    const origin = eventOrigin(request);
    const draft = await purchaseOrders.billDraft(principal, id, body);
    const created = await bills.create(
      principal,
      draft,
      { idempotencyKey: idempotencyKey(request) },
      origin,
    );
    markReplay(reply, created.replayed);
    const bill = created.value as { id: string };
    if (!created.replayed) {
      await purchaseOrders.linkBill(principal, id, bill.id, origin);
    }
    return reply.status(201).send({ data: created.value });
  });
  app.post('/purchases/orders/:id/link-bill', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(linkBillBody, request.body);
    return {
      data: await purchaseOrders.linkBill(
        requirePrincipal(request),
        id,
        body.billId,
        eventOrigin(request),
      ),
    };
  });
}
