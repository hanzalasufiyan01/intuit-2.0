import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InventoryService } from '../../application/inventory-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Inventory (strict schemas; decimals as strings; costs and balances from the server). Viewing
 * needs `inventory.view`; tracking items, settings and adjustments have their own permissions.
 * Voiding an adjustment and changing the settings also need a recent password confirmation.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const signedQuantity = z
  .string()
  .regex(/^-?(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const version = z.number().int().min(0);
const itemParams = z.object({ itemId: fields.id }).strict();
const idParams = z.object({ id: fields.id }).strict();

const trackBody = z
  .object({
    inventoryAccountId: fields.id,
    cogsAccountId: fields.id,
    reorderPoint: quantity.nullable().optional(),
  })
  .strict();
const trackUpdateBody = z
  .object({
    version: z.number().int().min(1),
    inventoryAccountId: fields.id.optional(),
    cogsAccountId: fields.id.optional(),
    reorderPoint: quantity.nullable().optional(),
  })
  .strict();
const settingsBody = z
  .object({
    version,
    negativeStockPolicy: z.enum(['block', 'allow']),
    adjustmentAccountId: fields.id.nullable(),
  })
  .strict();
const adjustmentBody = z
  .object({
    adjustmentDate: isoDate,
    reason: z.string().trim().min(1, 'Give a reason.').max(500),
    memo: z.string().trim().max(2000).optional(),
    adjustmentAccountId: fields.id.optional(),
    lines: z
      .array(
        z
          .object({
            itemId: fields.id,
            quantityChange: signedQuantity,
            unitCost: quantity.optional(),
          })
          .strict(),
      )
      .min(1, 'Add at least one line.')
      .max(200),
  })
  .strict();
const voidBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(1, 'Give a reason for the void.').max(500),
  })
  .strict();
const movementsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

export function registerInventoryRoutes(
  app: FastifyInstance,
  { inventory }: { inventory: InventoryService },
) {
  app.get('/inventory/settings', async (request) => ({
    data: await inventory.getSettings(requirePrincipal(request)),
  }));
  app.put('/inventory/settings', async (request) => {
    const body = parseInput(settingsBody, request.body);
    return {
      data: await inventory.updateSettings(requirePrincipal(request), body, eventOrigin(request)),
    };
  });

  app.get('/inventory/items', async (request) => ({
    data: await inventory.listItems(requirePrincipal(request)),
  }));
  app.get('/inventory/valuation', async (request) => ({
    data: await inventory.valuation(requirePrincipal(request)),
  }));
  app.get('/inventory/items/:itemId', async (request) => {
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await inventory.getItem(requirePrincipal(request), itemId) };
  });
  app.post('/inventory/items/:itemId', async (request, reply) => {
    const { itemId } = parseInput(itemParams, request.params);
    const body = parseInput(trackBody, request.body);
    const data = await inventory.trackItem(
      requirePrincipal(request),
      itemId,
      body,
      eventOrigin(request),
    );
    return reply.status(201).send({ data });
  });
  app.patch('/inventory/items/:itemId', async (request) => {
    const { itemId } = parseInput(itemParams, request.params);
    const body = parseInput(trackUpdateBody, request.body);
    return {
      data: await inventory.updateTrackedItem(
        requirePrincipal(request),
        itemId,
        body,
        eventOrigin(request),
      ),
    };
  });
  app.delete('/inventory/items/:itemId', async (request) => {
    const { itemId } = parseInput(itemParams, request.params);
    return {
      data: await inventory.untrackItem(requirePrincipal(request), itemId, eventOrigin(request)),
    };
  });
  app.get('/inventory/items/:itemId/movements', async (request) => {
    const { itemId } = parseInput(itemParams, request.params);
    const query = parseInput(movementsQuery, request.query);
    return {
      data: await inventory.listItemMovements(
        requirePrincipal(request),
        itemId,
        query.limit,
        query.after,
      ),
    };
  });

  app.get('/inventory/adjustments', async (request) => {
    const query = parseInput(listQuery, request.query);
    return { data: await inventory.listAdjustments(requirePrincipal(request), query.limit) };
  });
  app.post('/inventory/adjustments', async (request, reply) => {
    const body = parseInput(adjustmentBody, request.body);
    const result = await inventory.postAdjustment(
      requirePrincipal(request),
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/inventory/adjustments/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await inventory.getAdjustment(requirePrincipal(request), id) };
  });
  app.post('/inventory/adjustments/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return {
      data: await inventory.voidAdjustment(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
}
