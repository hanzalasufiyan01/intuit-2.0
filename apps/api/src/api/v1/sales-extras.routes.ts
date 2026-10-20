import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvoiceShareService } from '../../application/invoice-share-service.js';
import type { PaymentReminderService } from '../../application/payment-reminder-service.js';
import type { RateLimiter } from '../../application/rate-limiter.js';
import type { SalesOrderService } from '../../application/sales-order-service.js';
import { orderStatuses } from '../../modules/sales-extras/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Payment reminders, sales orders and invoice share links (FP-28). Strict schemas. The one
 * unauthenticated route, `GET /public/invoices/:token`, is rate limited per address, answers every
 * invalid token with the same 404, never caches and exposes nothing but the one issued invoice.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const versionBody = z.object({ version }).strict();

const settingsBody = z
  .object({
    version: z.number().int().min(0),
    autoEnabled: z.boolean(),
    firstAfterDays: z.number().int().min(0).max(365),
    repeatEveryDays: z.number().int().min(1).max(365),
    maxReminders: z.number().int().min(1).max(20),
  })
  .strict();
const sendBody = z.object({ to: z.string().trim().max(320).optional() }).strict();

const line = z
  .object({
    itemId: fields.id.nullable().optional(),
    description: z.string().trim().max(500).optional(),
    quantity: amount,
    unitPrice: amount,
    taxCodeId: fields.id.nullable().optional(),
  })
  .strict();
const orderBody = {
  customerId: fields.id,
  orderDate: isoDate,
  expectedDate: isoDate.nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  lines: z.array(line).min(1).max(200),
};
const orderCreate = z.object(orderBody).strict();
const orderUpdate = z.object({ version, ...orderBody }).strict();
const orderList = z
  .object({
    status: z.enum(orderStatuses).optional(),
    customerId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const cancelBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const invoiceBody = z
  .object({
    version,
    invoiceDate: isoDate.optional(),
    lines: z
      .array(z.object({ lineNo: z.number().int().min(1), quantity: amount }).strict())
      .min(1)
      .max(200)
      .optional(),
  })
  .strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const linkBody = z.object({ expiresInDays: z.number().int().min(1).max(90).default(30) }).strict();
const tokenParams = z.object({ token: z.string().min(20).max(80) }).strict();

const PUBLIC_VIEWS_PER_MINUTE = 30;

export function registerSalesExtraRoutes(
  app: FastifyInstance,
  {
    reminders,
    salesOrders,
    shareLinks,
    rateLimiter: limiter,
  }: {
    reminders: PaymentReminderService;
    salesOrders: SalesOrderService;
    shareLinks: InvoiceShareService;
    rateLimiter: RateLimiter;
  },
) {
  // Payment reminders
  app.get('/sales/reminders/settings', async (request) => ({
    data: await reminders.getSettings(requirePrincipal(request)),
  }));
  app.put('/sales/reminders/settings', async (request) => {
    const principal = requirePrincipal(request);
    return {
      data: await reminders.saveSettings(
        principal,
        parseInput(settingsBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/sales/reminders/overdue', async (request) => ({
    data: await reminders.listOverdue(requirePrincipal(request)),
  }));
  app.post('/sales/reminders/invoices/:id/send', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await reminders.send(
        principal,
        id,
        parseInput(sendBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  // Sales orders
  app.get('/sales/orders', async (request) => ({
    data: await salesOrders.list(requirePrincipal(request), parseInput(orderList, request.query)),
  }));
  app.post('/sales/orders', async (request, reply) => {
    const principal = requirePrincipal(request);
    const result = await salesOrders.create(
      principal,
      parseInput(orderCreate, request.body),
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/orders/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await salesOrders.get(requirePrincipal(request), id) };
  });
  app.put('/sales/orders/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await salesOrders.update(
        principal,
        id,
        parseInput(orderUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.delete('/sales/orders/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await salesOrders.delete(
        principal,
        id,
        parseInput(deleteQuery, request.query),
        eventOrigin(request),
      ),
    };
  });
  app.post('/sales/orders/:id/confirm', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await salesOrders.confirm(
        principal,
        id,
        parseInput(versionBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/sales/orders/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await salesOrders.cancel(
        principal,
        id,
        parseInput(cancelBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/sales/orders/:id/invoice', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await salesOrders.invoice(
        principal,
        id,
        parseInput(invoiceBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  // Share links (authenticated management)
  app.get('/sales/invoices/:id/share-links', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await shareLinks.list(principal, id) };
  });
  app.post('/sales/invoices/:id/share-links', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const data = await shareLinks.create(
      principal,
      id,
      parseInput(linkBody, request.body ?? {}),
      eventOrigin(request),
    );
    // The token is returned once: never cached.
    return reply.header('cache-control', 'no-store').status(201).send({ data });
  });
  app.post('/sales/share-links/:id/revoke', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return { data: await shareLinks.revoke(principal, id, eventOrigin(request)) };
  });

  // The public read: no session, rate limited per address.
  app.get('/public/invoices/:token', async (request, reply) => {
    const decision = await limiter.consume(`public-invoice:${request.ip}`, PUBLIC_VIEWS_PER_MINUTE);
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    if (!decision.allowed) {
      return reply
        .header('retry-after', String(decision.resetSeconds))
        .status(429)
        .send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many requests.' } });
    }
    const { token } = parseInput(tokenParams, request.params);
    return { data: await shareLinks.open(token) };
  });
}
