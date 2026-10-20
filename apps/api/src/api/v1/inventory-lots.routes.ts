import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InventoryLotService } from '../../application/inventory-lot-service.js';
import type { InventoryUnitService } from '../../application/inventory-unit-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Lots, serials and expiry (FP-29 A6, ADR 0014). Strict schemas. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const itemParams = z.object({ itemId: fields.id }).strict();
const documentParams = z
  .object({ type: z.enum(['bill', 'vendor_credit']), id: fields.id })
  .strict();
const lotsBody = z
  .object({
    lots: z
      .array(
        z
          .object({
            itemId: fields.id,
            lotCode: z.string().trim().min(1).max(60),
            expiryDate: isoDate.nullable().optional(),
            quantity,
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
const expiringQuery = z
  .object({
    days: z.coerce.number().int().min(0).max(3650).default(30),
    asOf: isoDate.optional(),
  })
  .strict();

export function registerInventoryLotRoutes(
  app: FastifyInstance,
  {
    inventoryLots,
    inventoryUnits,
  }: { inventoryLots: InventoryLotService; inventoryUnits: InventoryUnitService },
) {
  const unitRef = z
    .object({
      unit: z.string().trim().min(1).max(20),
      factor: z
        .string()
        .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.'),
    })
    .strict();
  const unitsBody = z
    .object({
      version: z.number().int().min(1),
      baseUnit: z.string().trim().min(1).max(20).optional(),
      purchaseUnit: unitRef.nullable().optional(),
      salesUnit: unitRef.nullable().optional(),
    })
    .strict();
  app.get('/inventory/items/:itemId/units', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await inventoryUnits.get(principal, itemId) };
  });
  app.put('/inventory/items/:itemId/units', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    const body = parseInput(unitsBody, request.body);
    return { data: await inventoryUnits.set(principal, itemId, body, eventOrigin(request)) };
  });
  app.get('/inventory/items/:itemId/lots', async (request) => {
    const principal = requirePrincipal(request);
    const { itemId } = parseInput(itemParams, request.params);
    return { data: await inventoryLots.itemLots(principal, itemId) };
  });
  app.get('/inventory/lots/expiring', async (request) => {
    const principal = requirePrincipal(request);
    const query = parseInput(expiringQuery, request.query);
    return {
      data: await inventoryLots.expiring(principal, {
        days: query.days,
        asOf: query.asOf ?? new Date().toISOString().slice(0, 10),
      }),
    };
  });
  app.get('/inventory/document-lots/:type/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { type, id } = parseInput(documentParams, request.params);
    return { data: await inventoryLots.getDocumentLots(principal, type, id) };
  });
  app.put('/inventory/document-lots/:type/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { type, id } = parseInput(documentParams, request.params);
    const body = parseInput(lotsBody, request.body);
    return {
      data: await inventoryLots.setDocumentLots(
        principal,
        type,
        id,
        body.lots,
        eventOrigin(request),
      ),
    };
  });
}
