import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApprovalService } from '../../application/approval-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

const actionKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, 'Unknown approvable action.');
const policyParams = z.object({ actionKey });
const policyBody = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Step name is required.').max(100),
        requiredApprovals: z.number().int().min(1).max(20),
        roleIds: z.array(fields.id).max(50).default([]),
        membershipIds: z.array(fields.id).max(200).default([]),
      }),
    )
    .min(1, 'A policy needs at least one step.')
    .max(10),
});
const requestParams = z.object({ requestId: fields.id });
const decisionBody = z.object({ comment: z.string().trim().max(1000).optional() });

/** /api/v1/approvals — the reusable Authority & Approval framework. */
export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: { approvals: ApprovalService },
): void {
  const { approvals } = deps;

  app.get('/approvals/policies', async (request) => ({
    data: await approvals.listPolicies(requirePrincipal(request)),
  }));
  app.put('/approvals/policies/:actionKey', async (request) => {
    const principal = requirePrincipal(request);
    const params = parseInput(policyParams, request.params);
    const body = parseInput(policyBody, request.body);
    return {
      data: await approvals.setPolicy(
        principal,
        { actionKey: params.actionKey, steps: body.steps },
        eventOrigin(request),
      ),
    };
  });
  app.delete('/approvals/policies/:actionKey', async (request, reply) => {
    const principal = requirePrincipal(request);
    const params = parseInput(policyParams, request.params);
    await approvals.deletePolicy(principal, params.actionKey, eventOrigin(request));
    return reply.status(204).send();
  });

  app.get('/approvals/requests', async (request) => ({
    data: await approvals.listPendingRequests(requirePrincipal(request)),
  }));
  for (const decision of ['approve', 'reject'] as const) {
    app.post(`/approvals/requests/:requestId/${decision}`, async (request) => {
      const principal = requirePrincipal(request);
      const { requestId } = parseInput(requestParams, request.params);
      const body = parseInput(decisionBody, request.body);
      return {
        data: await approvals.decide(
          principal,
          {
            requestId,
            decision: decision === 'approve' ? 'approved' : 'rejected',
            comment: body.comment ?? null,
          },
          eventOrigin(request),
        ),
      };
    });
  }
}
