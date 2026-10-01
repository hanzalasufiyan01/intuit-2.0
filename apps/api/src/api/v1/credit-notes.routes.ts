import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CreditNoteService } from '../../application/credit-note-service.js';
import { creditNoteStatuses } from '../../modules/sales/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';
import { dimensionValueIds, discount, lineBody } from './invoices.routes.js';

/** Credit notes (Phase 3B step 12; Decision 41; D7). Strict schemas. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const draftShape = {
  customerId: fields.id,
  creditDate: isoDate,
  invoiceId: fields.id.nullable().optional(),
  currencyCode: z
    .string()
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.')
    .optional(),
  taxTreatment: z.enum(taxTreatments).optional(),
  discount: discount.nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  memo: z.string().trim().max(2000).optional(),
  dimensionValueIds: dimensionValueIds.optional(),
  lines: z.array(lineBody).min(1, 'Add at least one line.').max(500),
};
const createBody = z.object(draftShape).strict();
const updateBody = z.object({ version: z.number().int().min(1), ...draftShape }).strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const listQuery = z
  .object({
    status: z.enum(creditNoteStatuses).optional(),
    customerId: fields.id.optional(),
    invoiceId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    withCredit: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerCreditNoteRoutes(
  app: FastifyInstance,
  { creditNotes }: { creditNotes: CreditNoteService },
) {
  app.get('/sales/credit-notes', async (request) => ({
    data: await creditNotes.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/sales/credit-notes', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const body = parseInput(createBody, request.body) as Parameters<CreditNoteService['create']>[1];
    const result = await creditNotes.create(
      principal,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/sales/credit-notes/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await creditNotes.get(requirePrincipal(request), id) };
  });
  app.put('/sales/credit-notes/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<CreditNoteService['update']>[2];
    return { data: await creditNotes.update(principal, id, body, eventOrigin(request)) };
  });
  app.delete('/sales/credit-notes/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { version } = parseInput(versionQuery, request.query);
    return { data: await creditNotes.delete(principal, id, { version }, eventOrigin(request)) };
  });
  for (const action of ['submit', 'withdraw'] as const) {
    app.post(`/sales/credit-notes/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return { data: await creditNotes[action](principal, id, body, eventOrigin(request)) };
    });
  }
  app.post('/sales/credit-notes/:id/issue', async (request, reply) => {
    const principal = requirePrincipal(request);
    const key = idempotencyKey(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    const result = await creditNotes.issue(
      principal,
      id,
      body,
      { idempotencyKey: key },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.send({ data: result.value });
  });
}
