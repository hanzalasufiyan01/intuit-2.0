import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OwnershipTransferService } from '../../application/ownership-transfer-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

const idParams = z.object({ id: fields.id });
const initiateBody = z.object({ toMembershipId: fields.id, replacementRoleId: fields.id }).strict();
const reasonBody = z
  .object({ reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();
const emptyBody = z.object({}).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

/**
 * Ownership transfer (master context section 8, ADR 0012). The Owner starts and may cancel (both
 * need the password re-authentication window and an MFA step-up); the new owner accepts (the same
 * verification) or declines. There is no other way to change the Owner.
 */
export function registerOwnershipRoutes(
  app: FastifyInstance,
  deps: { ownershipTransfers: OwnershipTransferService },
): void {
  const { ownershipTransfers } = deps;
  const base = '/organizations/current/ownership-transfers';

  app.get(base, async (request) => {
    const { limit } = parseInput(listQuery, request.query);
    return { data: await ownershipTransfers.list(requirePrincipal(request), limit) };
  });

  app.post(base, async (request, reply) => {
    requirePrincipal(request); // authenticate before validating the body
    const body = parseInput(initiateBody, request.body);
    const data = await ownershipTransfers.initiate(
      requirePrincipal(request),
      body,
      eventOrigin(request),
    );
    return reply.status(201).send({ data });
  });

  app.post(`${base}/:id/accept`, async (request) => {
    const { id } = parseInput(idParams, request.params);
    parseInput(emptyBody, request.body);
    return {
      data: await ownershipTransfers.accept(requirePrincipal(request), id, eventOrigin(request)),
    };
  });

  app.post(`${base}/:id/cancel`, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(reasonBody, request.body);
    return {
      data: await ownershipTransfers.cancel(
        requirePrincipal(request),
        id,
        reason,
        eventOrigin(request),
      ),
    };
  });

  app.post(`${base}/:id/decline`, async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { reason } = parseInput(reasonBody, request.body);
    return {
      data: await ownershipTransfers.decline(
        requirePrincipal(request),
        id,
        reason,
        eventOrigin(request),
      ),
    };
  });
}
