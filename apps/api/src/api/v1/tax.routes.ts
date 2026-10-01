import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TaxService } from '../../application/tax-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Tax codes and rate versions (Phase 3B step 2). Every schema is strict. */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const rate = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Enter a percentage with up to 4 decimal places.')
  .refine((value) => Number(value) <= 100, 'The rate cannot exceed 100%.');
const code = z
  .string()
  .trim()
  .regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use up to 20 upper-case letters, digits, "_" or "-".');
const name = z.string().trim().min(1, 'The name is required.').max(100);
const description = z.string().trim().max(500);
const version = z.number().int().min(1);

const createBody = z
  .object({
    code,
    name,
    description: description.default(''),
    taxAccountId: fields.id,
    rate,
    effectiveFrom: isoDate,
  })
  .strict();
const updateBody = z
  .object({
    version,
    name: name.optional(),
    description: description.optional(),
    taxAccountId: fields.id.optional(),
  })
  .strict();
const versionBody = z.object({ version }).strict();
const rateBody = z.object({ rate, effectiveFrom: isoDate }).strict();
const codeParams = z.object({ id: fields.id }).strict();
const rateParams = z.object({ id: fields.id, rateId: fields.id }).strict();

export function registerTaxRoutes(app: FastifyInstance, { tax }: { tax: TaxService }) {
  app.get('/tax/codes', async (request) => ({
    data: await tax.listCodes(requirePrincipal(request)),
  }));
  app.post('/tax/codes', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body);
    return reply
      .status(201)
      .send({ data: await tax.createCode(principal, body, eventOrigin(request)) });
  });
  app.patch('/tax/codes/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(codeParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<TaxService['updateCode']>[2];
    return { data: await tax.updateCode(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/tax/codes/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(codeParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await tax.setStatus(principal, id, { ...body, status }, eventOrigin(request)),
      };
    });
  }
  app.post('/tax/codes/:id/rates', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(codeParams, request.params);
    const body = parseInput(rateBody, request.body);
    return reply
      .status(201)
      .send({ data: await tax.addRate(principal, id, body, eventOrigin(request)) });
  });
  app.delete('/tax/codes/:id/rates/:rateId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, rateId } = parseInput(rateParams, request.params);
    return { data: await tax.deleteRate(principal, id, rateId, eventOrigin(request)) };
  });
}
