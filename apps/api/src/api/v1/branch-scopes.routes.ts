import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BranchScopeService } from '../../application/branch-scope-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Branch-scoped access (FP-24, migration 0084). Strict schemas. */

const params = z.object({ membershipId: fields.id }).strict();
const body = z.object({ dimensionValueIds: z.array(fields.id).max(50) }).strict();

export function registerBranchScopeRoutes(
  app: FastifyInstance,
  { branchScopes }: { branchScopes: BranchScopeService },
) {
  app.get('/organizations/current/branch-scopes', async (request) => ({
    data: await branchScopes.list(requirePrincipal(request)),
  }));
  app.get('/organizations/current/members/:membershipId/branch-scope', async (request) => {
    const principal = requirePrincipal(request);
    const { membershipId } = parseInput(params, request.params);
    return { data: await branchScopes.get(principal, membershipId) };
  });
  app.put('/organizations/current/members/:membershipId/branch-scope', async (request) => {
    const principal = requirePrincipal(request);
    const { membershipId } = parseInput(params, request.params);
    const input = parseInput(body, request.body);
    return { data: await branchScopes.set(principal, membershipId, input, eventOrigin(request)) };
  });
}
