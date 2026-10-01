import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SalesOutputService } from '../../application/sales-output-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Issued-document PDFs and email (Phase 3B steps 14-15). Strict schemas. */

const idParams = z.object({ id: fields.id }).strict();
const emailBody = z
  .object({
    to: z.email({ error: 'Enter a valid email address.' }).max(254).optional(),
    subject: z.string().trim().max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .strict();

export function registerSalesOutputRoutes(
  app: FastifyInstance,
  { salesOutput }: { salesOutput: SalesOutputService },
) {
  for (const [segment, type] of [
    ['invoices', 'invoice'],
    ['credit-notes', 'credit_note'],
  ] as const) {
    app.get(`/sales/${segment}/:id/pdf`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      return { data: await salesOutput.pdf(requirePrincipal(request), type, id) };
    });
    app.get(`/sales/${segment}/:id/emails`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      return { data: await salesOutput.emails(requirePrincipal(request), type, id) };
    });
    app.post(`/sales/${segment}/:id/email`, async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(emailBody, request.body);
      return reply.status(202).send({
        data: await salesOutput.requestEmail(principal, type, id, body, eventOrigin(request)),
      });
    });
  }
}
