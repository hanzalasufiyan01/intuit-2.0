import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiIntegrationService } from '../../application/api-integration-service.js';
import { integrationStatuses } from '../../modules/api-integrations/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * API integration management by people (ADR 0011, D2). These are internal, cookie-authenticated
 * routes for administrators — not the Public API. Every write needs `api_tokens.manage`, a recent
 * password confirmation and, where the MFA policy applies, a recent second factor. A token's
 * secret appears in the create/rotate response only.
 */

const version = z.number().int().min(1);
const scopes = z.array(z.string().trim().min(1).max(60)).max(50);
const createBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional(),
    scopes,
    responsibleMembershipId: fields.id.optional(),
  })
  .strict();
const updateBody = z
  .object({
    version,
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    scopes: scopes.optional(),
  })
  .strict();
const transitionBody = z
  .object({ version, reason: z.string().trim().max(500).optional() })
  .strict();
const revokeBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const enableBody = z.object({ version }).strict();
const reassignBody = z.object({ version, responsibleMembershipId: fields.id }).strict();
const tokenBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
const revokeTokenBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const listQuery = z.object({ status: z.enum(integrationStatuses).optional() }).strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerApiIntegrationRoutes(
  app: FastifyInstance,
  { apiIntegrations }: { apiIntegrations: ApiIntegrationService },
) {
  app.get('/api-integrations/scopes', async (request) => ({
    data: await apiIntegrations.scopeCatalog(requirePrincipal(request)),
  }));
  app.get('/api-integrations', async (request) => ({
    data: await apiIntegrations.list(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/api-integrations', async (request, reply) => {
    const body = parseInput(createBody, request.body);
    const data = await apiIntegrations.create(
      requirePrincipal(request),
      body,
      eventOrigin(request),
    );
    return reply.status(201).send({ data });
  });
  app.get('/api-integrations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await apiIntegrations.get(requirePrincipal(request), id) };
  });
  app.patch('/api-integrations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body);
    return {
      data: await apiIntegrations.update(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/api-integrations/:id/disable', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(transitionBody, request.body);
    return {
      data: await apiIntegrations.disable(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
  app.post('/api-integrations/:id/enable', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(enableBody, request.body);
    return {
      data: await apiIntegrations.enable(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/api-integrations/:id/revoke', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(revokeBody, request.body);
    return {
      data: await apiIntegrations.revoke(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/api-integrations/:id/reassign', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reassignBody, request.body);
    return {
      data: await apiIntegrations.reassign(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
  app.get('/api-integrations/:id/tokens', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await apiIntegrations.listTokens(requirePrincipal(request), id) };
  });
  // The credential is returned once: never cached.
  app.post('/api-integrations/:id/tokens', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(tokenBody, request.body);
    const data = await apiIntegrations.createToken(
      requirePrincipal(request),
      id,
      body,
      eventOrigin(request),
    );
    return reply.header('cache-control', 'no-store').status(201).send({ data });
  });
  app.post('/api-tokens/:id/rotate', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(tokenBody, request.body);
    const data = await apiIntegrations.rotateToken(
      requirePrincipal(request),
      id,
      body,
      eventOrigin(request),
    );
    return reply.header('cache-control', 'no-store').status(201).send({ data });
  });
  app.post('/api-tokens/:id/revoke', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(revokeTokenBody, request.body);
    return {
      data: await apiIntegrations.revokeToken(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });
}
