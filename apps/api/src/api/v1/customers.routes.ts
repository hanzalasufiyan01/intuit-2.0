import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustomerService } from '../../application/customer-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';
import {
  addressBody,
  addressPatch,
  contactBody,
  contactPatch,
  createPartyBody,
  headerShape,
} from './parties.routes.js';

/** Customers (Phase 3B step 4; Decisions 8, 28, 48; D6). Every schema is strict. */

const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
const paymentTermsDays = z.number().int().min(0).max(365).nullable();
const creditLimit = z
  .string()
  .regex(/^(0|[1-9]\d{0,23})(\.\d{1,4})?$/, 'Enter a non-negative amount.')
  .nullable();

const termsShape = {
  currencyCode: currencyCode.optional(),
  paymentTermsDays: paymentTermsDays.optional(),
  creditLimit: creditLimit.optional(),
};

const createBody = z.union([
  z.object({ partyId: fields.id, ...termsShape }).strict(),
  z.object({ party: createPartyBody, ...termsShape }).strict(),
]);
const updateBody = z
  .object({
    version: z.number().int().min(1),
    ...termsShape,
    party: z
      .object({
        version: z.number().int().min(1),
        ...Object.fromEntries(Object.entries(headerShape).map(([k, v]) => [k, v.optional()])),
      })
      .strict()
      .optional(),
  })
  .strict();
const listQuery = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const versionBody = z.object({ version: z.number().int().min(1) }).strict();
const idParams = z.object({ id: fields.id }).strict();
const contactParams = z.object({ id: fields.id, contactId: fields.id }).strict();
const addressParams = z.object({ id: fields.id, addressId: fields.id }).strict();

export function registerCustomerRoutes(
  app: FastifyInstance,
  { customers }: { customers: CustomerService },
) {
  app.get('/customers', async (request) => ({
    data: await customers.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/customers', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body) as Parameters<CustomerService['create']>[1];
    return reply
      .status(201)
      .send({ data: await customers.create(principal, body, eventOrigin(request)) });
  });
  app.get('/customers/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await customers.get(requirePrincipal(request), id) };
  });
  app.patch('/customers/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<CustomerService['update']>[2];
    return { data: await customers.update(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/customers/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const { version } = parseInput(versionBody, request.body);
      return {
        data: await customers.setStatus(principal, id, { version, status }, eventOrigin(request)),
      };
    });
  }

  // ---- Identity sub-resources (D6) ----
  app.post('/customers/:id/contacts', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(contactBody, request.body);
    return reply
      .status(201)
      .send({ data: await customers.addContact(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/customers/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    const body = parseInput(contactPatch, request.body);
    return {
      data: await customers.updateContact(principal, id, contactId, body, eventOrigin(request)),
    };
  });
  app.delete('/customers/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    return { data: await customers.removeContact(principal, id, contactId, eventOrigin(request)) };
  });
  app.post('/customers/:id/addresses', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(addressBody, request.body);
    return reply
      .status(201)
      .send({ data: await customers.addAddress(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/customers/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    const body = parseInput(addressPatch, request.body);
    return {
      data: await customers.updateAddress(principal, id, addressId, body, eventOrigin(request)),
    };
  });
  app.delete('/customers/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    return { data: await customers.removeAddress(principal, id, addressId, eventOrigin(request)) };
  });
}
