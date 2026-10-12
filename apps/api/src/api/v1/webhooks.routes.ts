import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WebhookEndpointService } from '../../application/webhook-endpoint-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Webhook endpoint management by people (ADR 0011 section 11). Internal, cookie-authenticated
 * routes — not the Public API. Writes need `webhooks.manage`, a recent password confirmation and,
 * where the MFA policy applies, a recent second factor; reads need `webhooks.view`. The signing
 * secret appears in the create and rotate responses only. Every schema is strict.
 */

const version = z.number().int().min(1);
const eventTypes = z.array(z.string().trim().min(1).max(60)).min(1).max(30);
const createBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    url: z.string().trim().min(1).max(2048),
    integrationId: fields.id,
    eventTypes,
    payloadMode: z.enum(['thin', 'full']).optional(),
  })
  .strict();
const updateBody = z
  .object({
    version,
    name: z.string().trim().min(1).max(100).optional(),
    url: z.string().trim().min(1).max(2048).optional(),
    eventTypes: eventTypes.optional(),
    payloadMode: z.enum(['thin', 'full']).optional(),
  })
  .strict();
const versionBody = z.object({ version }).strict();
const disableBody = z.object({ version, reason: z.string().trim().max(500).optional() }).strict();
const deliveryQuery = z
  .object({
    endpointId: fields.id.optional(),
    status: z.enum(['pending', 'succeeded', 'dead', 'cancelled']).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerWebhookRoutes(
  app: FastifyInstance,
  { webhooks }: { webhooks: WebhookEndpointService },
) {
  app.get('/webhooks/event-types', async (request) => ({
    data: await webhooks.eventCatalog(requirePrincipal(request)),
  }));
  app.get('/webhooks/endpoints', async (request) => ({
    data: await webhooks.list(requirePrincipal(request)),
  }));
  app.post('/webhooks/endpoints', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body);
    const data = await webhooks.create(principal, body, eventOrigin(request));
    return reply.header('cache-control', 'no-store').status(201).send({ data });
  });
  app.get('/webhooks/endpoints/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await webhooks.get(requirePrincipal(request), id) };
  });
  app.patch('/webhooks/endpoints/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body);
    return { data: await webhooks.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/webhooks/endpoints/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version: expected } = parseInput(
      z.object({ version: z.coerce.number().int().min(1) }).strict(),
      request.query,
    );
    return {
      data: await webhooks.remove(principal, id, { version: expected }, eventOrigin(request)),
    };
  });
  app.post('/webhooks/endpoints/:id/rotate-secret', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const data = await webhooks.rotateSecret(principal, id, body, eventOrigin(request));
    return reply.header('cache-control', 'no-store').send({ data });
  });
  app.post('/webhooks/endpoints/:id/disable', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(disableBody, request.body);
    return { data: await webhooks.disable(principal, id, body, eventOrigin(request)) };
  });
  app.post('/webhooks/endpoints/:id/enable', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await webhooks.enable(principal, id, body, eventOrigin(request)) };
  });
  app.post('/webhooks/endpoints/:id/ping', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body);
    return { data: await webhooks.ping(principal, id, eventOrigin(request)) };
  });
  app.get('/webhooks/deliveries', async (request) => ({
    data: await webhooks.listDeliveries(
      requirePrincipal(request),
      parseInput(deliveryQuery, request.query),
    ),
  }));
  app.get('/webhooks/deliveries/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await webhooks.getDelivery(requirePrincipal(request), id) };
  });
  app.post('/webhooks/deliveries/:id/redeliver', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body);
    return { data: await webhooks.redeliver(principal, id, eventOrigin(request)) };
  });
}
