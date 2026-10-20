import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InventoryLandedCostService } from '../../application/inventory-landed-cost-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Landed cost (FP-29 A8, ADR 0014). Strict schemas; the amount is in the base currency. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const idParams = z.object({ id: fields.id }).strict();
const listQuery = z
  .object({
    billId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const postBody = z
  .object({
    costDate: isoDate,
    billId: fields.id,
    description: z.string().trim().min(1).max(500),
    amount,
    basis: z.enum(['value', 'quantity']).default('value'),
    creditAccountId: fields.id,
  })
  .strict();
const voidBody = z
  .object({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500) })
  .strict();

export function registerInventoryLandedCostRoutes(
  app: FastifyInstance,
  { landedCosts }: { landedCosts: InventoryLandedCostService },
) {
  app.get('/inventory/landed-costs', async (request) => {
    const principal = requirePrincipal(request);
    return { data: await landedCosts.list(principal, parseInput(listQuery, request.query)) };
  });
  app.post('/inventory/landed-costs', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(postBody, request.body);
    const result = await landedCosts.post(
      principal,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/inventory/landed-costs/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await landedCosts.get(principal, id) };
  });
  app.post('/inventory/landed-costs/:id/void', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(voidBody, request.body);
    return { data: await landedCosts.void(principal, id, body, eventOrigin(request)) };
  });
}
