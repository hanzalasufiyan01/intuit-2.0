import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WarehouseService } from '../../application/warehouse-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Warehouses, transfers and document warehouses (FP-29 A3/A4, ADR 0014). Strict schemas. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const idParams = z.object({ id: fields.id }).strict();
const itemParams = z.object({ itemId: fields.id }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const createBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, 'Use letters, digits . _ - (up to 20).'),
    name: z.string().trim().min(1).max(120),
  })
  .strict();
const updateBody = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(120).optional(),
    archived: z.boolean().optional(),
    makeDefault: z.boolean().optional(),
  })
  .strict();
const transferBody = z
  .object({
    transferDate: isoDate,
    fromWarehouseId: fields.id,
    toWarehouseId: fields.id,
    memo: z.string().trim().max(2000).optional(),
    lines: z
      .array(
        z
          .object({
            itemId: fields.id,
            quantity,
            lots: z
              .array(z.object({ lotCode: z.string().trim().min(1).max(60), quantity }).strict())
              .max(500)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
  })
  .strict();
const voidBody = z
  .object({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500) })
  .strict();
const documentParams = z
  .object({ type: z.enum(['invoice', 'bill', 'vendor_credit']), id: fields.id })
  .strict();
const documentBody = z.object({ warehouseId: fields.id.nullable() }).strict();

export function registerInventoryWarehouseRoutes(
  app: FastifyInstance,
  { warehouses }: { warehouses: WarehouseService },
) {
  app.get('/inventory/warehouses', async (request) => ({
    data: await warehouses.list(requirePrincipal(request)),
  }));
  app.post('/inventory/warehouses', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body);
    return reply
      .status(201)
      .send({ data: await warehouses.create(principal, body, eventOrigin(request)) });
  });
  app.patch('/inventory/warehouses/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body);
    return { data: await warehouses.update(principal, id, body, eventOrigin(request)) };
  });
  app.get('/inventory/warehouses/:id/stock', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await warehouses.stock(principal, id) };
  });
  app.get('/inventory/items/:itemId/warehouses', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await warehouses.itemLocations(principal, itemId) };
  });

  app.get('/inventory/document-warehouse/:type/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { type, id } = parseInput(documentParams, request.params);
    return { data: await warehouses.getDocumentWarehouse(principal, type, id) };
  });
  app.put('/inventory/document-warehouse/:type/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { type, id } = parseInput(documentParams, request.params);
    const body = parseInput(documentBody, request.body);
    return {
      data: await warehouses.setDocumentWarehouse(
        principal,
        type,
        id,
        body.warehouseId,
        eventOrigin(request),
      ),
    };
  });

  app.get('/inventory/transfers', async (request) => {
    const principal = requirePrincipal(request);
    return {
      data: await warehouses.listTransfers(principal, parseInput(listQuery, request.query).limit),
    };
  });
  app.post('/inventory/transfers', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(transferBody, request.body);
    const result = await warehouses.postTransfer(
      principal,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/inventory/transfers/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await warehouses.getTransfer(principal, id) };
  });
  app.post('/inventory/transfers/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await warehouses.voidTransfer(principal, id, body, eventOrigin(request)) };
  });
}
