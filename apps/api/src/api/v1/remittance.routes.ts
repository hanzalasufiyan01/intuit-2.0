import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RemittanceService } from '../../application/remittance-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Vendor remittance advice: PDF and email (Phase 4B-7; ADR 0004 P4-46). View and download need
 * `vendor_payments.view`; generating and emailing need `vendor_payments.create`. No
 * re-authentication, no accounting effect.
 */

const idParams = z.object({ id: fields.id }).strict();
const generateBody = z.object({}).strict();
const emailBody = z
  .object({
    to: z.email({ error: 'Enter a valid email address.' }).max(254).optional(),
    subject: z.string().trim().min(1, 'Enter a subject.').max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .strict();

export function registerRemittanceRoutes(
  app: FastifyInstance,
  { remittance }: { remittance: RemittanceService },
) {
  app.get('/purchases/payments/:id/remittance', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await remittance.status(requirePrincipal(request), id) };
  });
  // Freezes the content on the first request and queues the PDF job; 202: generation is async.
  app.post('/purchases/payments/:id/remittance', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(generateBody, request.body ?? {});
    return reply
      .status(202)
      .send({ data: await remittance.request(principal, id, eventOrigin(request)) });
  });
  app.get('/purchases/payments/:id/remittance/emails', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await remittance.emails(requirePrincipal(request), id) };
  });
  app.post('/purchases/payments/:id/remittance/email', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(emailBody, request.body ?? {});
    return reply.status(202).send({
      data: await remittance.requestEmail(principal, id, body, eventOrigin(request)),
    });
  });
}
