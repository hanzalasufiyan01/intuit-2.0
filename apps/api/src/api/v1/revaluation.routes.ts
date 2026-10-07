import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RevaluationService } from '../../application/revaluation-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * The foreign-currency revaluation workflow (Phase 4B-10; ADR 0004 P4-52, Decision 9) on the frozen
 * S9 engine: list, detail, preview, post, submit for approval, post the approved run, withdraw and
 * cancel. Closing rates come from the exchange-rate table; the routes accept no manual rates.
 * Permissions are the S9 ones: view `accounting.journals.view`, post `accounting.journals.post`,
 * cancel `accounting.journals.reverse`; post and cancel need a recent password confirmation.
 * Approve and reject use the shared approval routes (/approvals/requests/:id/...).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const dateBody = z.object({ revaluationDate: isoDate }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const cancelBody = z
  .object({
    version: z.number().int().min(1),
    reason: z.string().trim().min(3, 'Give a reason of 3 to 500 characters.').max(500),
  })
  .strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerRevaluationRoutes(
  app: FastifyInstance,
  { revaluations }: { revaluations: RevaluationService },
) {
  app.get('/accounting/revaluations', async (request) => {
    const { limit } = parseInput(listQuery, request.query);
    return { data: await revaluations.list(requirePrincipal(request), { limit }) };
  });
  app.post('/accounting/revaluations/preview', async (request) => {
    const body = parseInput(dateBody, request.body);
    return { data: await revaluations.preview(requirePrincipal(request), body) };
  });
  // Posts directly; refused when an approval policy applies (use /submit).
  app.post('/accounting/revaluations', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(dateBody, request.body);
    const key = idempotencyKey(request);
    const run = await revaluations.post(principal, { ...body, runKey: key }, eventOrigin(request));
    markReplay(reply, run.replayed);
    return reply.status(run.replayed ? 200 : 201).send({ data: run });
  });
  app.post('/accounting/revaluations/submit', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(dateBody, request.body);
    const key = idempotencyKey(request);
    const run = await revaluations.submit(
      principal,
      { ...body, runKey: key },
      eventOrigin(request),
    );
    markReplay(reply, run.replayed);
    return reply.status(run.replayed ? 200 : 201).send({ data: run });
  });
  app.get('/accounting/revaluations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await revaluations.get(requirePrincipal(request), id) };
  });
  app.post('/accounting/revaluations/:id/post', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await revaluations.postApproved(principal, id, body, eventOrigin(request)) };
  });
  app.post('/accounting/revaluations/:id/withdraw', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return { data: await revaluations.withdraw(principal, id, body, eventOrigin(request)) };
  });
  app.post('/accounting/revaluations/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(cancelBody, request.body);
    return { data: await revaluations.cancel(principal, id, body, eventOrigin(request)) };
  });
}
