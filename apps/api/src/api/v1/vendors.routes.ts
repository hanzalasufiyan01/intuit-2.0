import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VendorService } from '../../application/vendor-service.js';
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

/** Vendors (Phase 4A-3; ADR 0004 P4-03, P4-20, P4-39). Every schema is strict. */

const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO 4217 currency code.');
const paymentTermsDays = z.number().int().min(0).max(365).nullable();
const creditLimit = z
  .string()
  .regex(/^(0|[1-9]\d{0,23})(\.\d{1,4})?$/, 'Enter a non-negative amount.')
  .nullable();
const accountNumber = z.string().trim().max(50, 'Use at most 50 characters.').nullable();

const termsShape = {
  currencyCode: currencyCode.optional(),
  paymentTermsDays: paymentTermsDays.optional(),
  creditLimit: creditLimit.optional(),
  accountNumber: accountNumber.optional(),
  defaultExpenseAccountId: fields.id.nullable().optional(),
  defaultTaxCodeId: fields.id.nullable().optional(),
  // ADR 0004 P4-12: the vendor's default tax recoverability (null: no default).
  defaultTaxRecoverable: z.boolean().nullable().optional(),
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

export function registerVendorRoutes(
  app: FastifyInstance,
  { vendors }: { vendors: VendorService },
) {
  app.get('/vendors', async (request) => ({
    data: await vendors.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/vendors', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body) as Parameters<VendorService['create']>[1];
    return reply
      .status(201)
      .send({ data: await vendors.create(principal, body, eventOrigin(request)) });
  });
  app.get('/vendors/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await vendors.get(requirePrincipal(request), id) };
  });
  app.patch('/vendors/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<VendorService['update']>[2];
    return { data: await vendors.update(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/vendors/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const { version } = parseInput(versionBody, request.body);
      return {
        data: await vendors.setStatus(principal, id, { version, status }, eventOrigin(request)),
      };
    });
  }

  // ---- Identity sub-resources (the Party rules, under vendors.update) ----
  app.post('/vendors/:id/contacts', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(contactBody, request.body);
    return reply
      .status(201)
      .send({ data: await vendors.addContact(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/vendors/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    const body = parseInput(contactPatch, request.body);
    return {
      data: await vendors.updateContact(principal, id, contactId, body, eventOrigin(request)),
    };
  });
  app.delete('/vendors/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    return { data: await vendors.removeContact(principal, id, contactId, eventOrigin(request)) };
  });
  app.post('/vendors/:id/addresses', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(addressBody, request.body);
    return reply
      .status(201)
      .send({ data: await vendors.addAddress(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/vendors/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    const body = parseInput(addressPatch, request.body);
    return {
      data: await vendors.updateAddress(principal, id, addressId, body, eventOrigin(request)),
    };
  });
  app.delete('/vendors/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    return { data: await vendors.removeAddress(principal, id, addressId, eventOrigin(request)) };
  });
}
