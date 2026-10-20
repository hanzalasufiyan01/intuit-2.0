import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrganizationGroupService } from '../../application/organization-group-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Groups of legal entities (FP-24, migration 0085). Strict schemas; read-only overview. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const groupParams = z.object({ groupId: fields.id }).strict();
const memberParams = z.object({ groupId: fields.id, organizationId: fields.id }).strict();
const createBody = z.object({ name: z.string().trim().min(1).max(120) }).strict();
const addBody = z.object({ organizationId: fields.id }).strict();
const overviewQuery = z.object({ from: isoDate, to: isoDate }).strict();

export function registerOrganizationGroupRoutes(
  app: FastifyInstance,
  { organizationGroups }: { organizationGroups: OrganizationGroupService },
) {
  app.get('/organization-groups', async (request) => ({
    data: await organizationGroups.list(requirePrincipal(request)),
  }));
  app.post('/organization-groups', async (request, reply) => {
    const principal = requirePrincipal(request);
    const input = parseInput(createBody, request.body);
    reply.code(201);
    return { data: await organizationGroups.create(principal, input, eventOrigin(request)) };
  });
  app.post('/organization-groups/:groupId/organizations', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { groupId } = parseInput(groupParams, request.params);
    const input = parseInput(addBody, request.body);
    reply.code(201);
    return {
      data: await organizationGroups.addOrganization(
        principal,
        groupId,
        input,
        eventOrigin(request),
      ),
    };
  });
  app.delete('/organization-groups/:groupId/organizations/:organizationId', async (request) => {
    const principal = requirePrincipal(request);
    const { groupId, organizationId } = parseInput(memberParams, request.params);
    return {
      data: await organizationGroups.removeOrganization(
        principal,
        groupId,
        organizationId,
        eventOrigin(request),
      ),
    };
  });
  app.delete('/organization-groups/:groupId', async (request) => {
    const principal = requirePrincipal(request);
    const { groupId } = parseInput(groupParams, request.params);
    return { data: await organizationGroups.delete(principal, groupId, eventOrigin(request)) };
  });
  app.get('/organization-groups/:groupId/overview', async (request) => {
    const principal = requirePrincipal(request);
    const { groupId } = parseInput(groupParams, request.params);
    return {
      data: await organizationGroups.overview(
        principal,
        groupId,
        parseInput(overviewQuery, request.query),
      ),
    };
  });
}
