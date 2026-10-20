import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DeliveryService, ReservationService } from '../../application/delivery-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Delivery notes and stock reservations (migration 0091, reversible defaults of ADR 0015). Strict
 * schemas. Delivery notes use the sales-order permissions; reservations use the inventory ones.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const quantity = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a quantity with up to 6 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const line = z.object({ orderLineNo: z.number().int().min(1), quantity }).strict();
const noteCreate = z
  .object({
    orderId: fields.id,
    deliveryDate: isoDate,
    memo: z.string().trim().max(2000).optional(),
    lines: z.array(line).min(1).max(200),
  })
  .strict();
const noteUpdate = z
  .object({
    version,
    deliveryDate: isoDate,
    memo: z.string().trim().max(2000).optional(),
    lines: z.array(line).min(1).max(200),
  })
  .strict();
const versionBody = z.object({ version }).strict();
const voidBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const noteList = z
  .object({
    orderId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const deleteQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const reservationCreate = z
  .object({
    itemId: fields.id,
    quantity,
    note: z.string().trim().max(200).optional(),
    expiresOn: isoDate.nullable().optional(),
  })
  .strict();
const reservationList = z
  .object({
    itemId: fields.id.optional(),
    orderId: fields.id.optional(),
    status: z.enum(['ACTIVE', 'RELEASED']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const releaseBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();

export function registerDeliveryRoutes(
  app: FastifyInstance,
  { deliveries, reservations }: { deliveries: DeliveryService; reservations: ReservationService },
) {
  app.get('/sales/delivery-notes', async (request) => ({
    data: await deliveries.list(requirePrincipal(request), parseInput(noteList, request.query)),
  }));
  app.post('/sales/delivery-notes', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await deliveries.create(
        principal,
        parseInput(noteCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.get('/sales/delivery-notes/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await deliveries.get(requirePrincipal(request), id) };
  });
  app.put('/sales/delivery-notes/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await deliveries.update(
        principal,
        id,
        parseInput(noteUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.delete('/sales/delivery-notes/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(deleteQuery, request.query);
    return { data: await deliveries.delete(principal, id, query, eventOrigin(request)) };
  });
  app.post('/sales/delivery-notes/:id/deliver', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await deliveries.deliver(
        principal,
        id,
        parseInput(versionBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/sales/delivery-notes/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await deliveries.void(
        principal,
        id,
        parseInput(voidBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/sales/orders/:id/fulfilment', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await deliveries.fulfilment(requirePrincipal(request), id) };
  });

  app.get('/inventory/reservations', async (request) => ({
    data: await reservations.list(
      requirePrincipal(request),
      parseInput(reservationList, request.query),
    ),
  }));
  app.post('/inventory/reservations', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await reservations.createManual(
        principal,
        parseInput(reservationCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.post('/inventory/reservations/:id/release', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await reservations.release(
        principal,
        id,
        parseInput(releaseBody, request.body ?? {}),
        eventOrigin(request),
      ),
    };
  });
  app.get('/inventory/items/:id/availability', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await reservations.availability(requirePrincipal(request), id) };
  });
  app.post('/sales/orders/:id/reserve', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return reply
      .status(201)
      .send({ data: await reservations.reserveOrder(principal, id, eventOrigin(request)) });
  });
}
