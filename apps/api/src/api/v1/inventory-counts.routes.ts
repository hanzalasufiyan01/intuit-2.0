import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InventoryCountService } from '../../application/inventory-count-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Physical stock counts (FP-29 A5). Strict schemas; quantities are decimal strings. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const idParams = z.object({ id: fields.id }).strict();
const version = z.number().int().min(1);
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const startBody = z
  .object({
    countDate: isoDate,
    memo: z.string().trim().max(2000).optional(),
    itemIds: z.array(fields.id).min(1).max(2000).optional(),
    warehouseId: fields.id.optional(),
  })
  .strict();
const enterBody = z
  .object({
    lines: z
      .array(z.object({ itemId: fields.id, countedQuantity: quantity.nullable() }).strict())
      .min(1)
      .max(2000),
  })
  .strict();
const postBody = z
  .object({ version, unitCosts: z.record(fields.id, quantity).optional() })
  .strict();
const cancelBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();

export function registerInventoryCountRoutes(
  app: FastifyInstance,
  { inventoryCounts }: { inventoryCounts: InventoryCountService },
) {
  app.get('/inventory/counts', async (request) => {
    const principal = requirePrincipal(request);
    return {
      data: await inventoryCounts.list(principal, parseInput(listQuery, request.query).limit),
    };
  });
  app.post('/inventory/counts', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await inventoryCounts.start(
        principal,
        parseInput(startBody, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.get('/inventory/counts/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await inventoryCounts.get(principal, id) };
  });
  app.put('/inventory/counts/:id/lines', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await inventoryCounts.enter(
        principal,
        id,
        parseInput(enterBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/inventory/counts/:id/post', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await inventoryCounts.post(
        principal,
        id,
        parseInput(postBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/inventory/counts/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await inventoryCounts.cancel(
        principal,
        id,
        parseInput(cancelBody, request.body),
        eventOrigin(request),
      ),
    };
  });
}
