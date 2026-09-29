import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrganizationProfileService } from '../../application/organization-profile-service.js';
import type { PartyService } from '../../application/party-service.js';
import { partyAddressKinds, partyKinds, partyRoles } from '../../modules/parties/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Organization legal profile and Party master (S4). Every schema is strict: unknown fields are
 * rejected (S4-22). Blank optional text becomes null.
 */

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value === '' ? null : value));
const optionalEmail = z
  .string()
  .trim()
  .max(254)
  .nullable()
  .transform((value) => (value === '' ? null : value))
  .pipe(z.email({ error: 'Enter a valid email address.' }).nullable());
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter ISO 3166 country code.');

// ---------------------------------------------------------------------------
// Organization profile (S4-02..S4-07, S4-12, S4-14)
// ---------------------------------------------------------------------------

const organizationAddress = z
  .object({
    line1: z.string().trim().min(1, 'Address line 1 is required.').max(200),
    line2: optionalText(200).default(null),
    city: optionalText(100).default(null),
    region: optionalText(100).default(null),
    postalCode: optionalText(20).default(null),
    countryCode,
  })
  .strict();

const profileBody = z
  .object({
    version: z.number().int().min(0),
    legalName: z.string().trim().min(1, 'The legal name is required.').max(200),
    tradingName: optionalText(200).default(null),
    tin: optionalText(50).default(null),
    gstRegistered: z.boolean().default(false),
    gstRegistrationNumber: optionalText(50).default(null),
    gstRegisteredFrom: isoDate.nullable().default(null),
    email: optionalEmail.default(null),
    phone: optionalText(40).default(null),
    website: optionalText(200).default(null),
    identifiers: z
      .array(
        z
          .object({
            scheme: z
              .string()
              .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Schemes are lower-case letters, digits or "_".'),
            value: z.string().trim().min(1).max(100),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    registeredAddress: organizationAddress.nullable().default(null),
    businessAddress: organizationAddress.nullable().default(null),
  })
  .strict();

// ---------------------------------------------------------------------------
// Parties (S4-08..S4-11, S4-13..S4-15, S4-20)
// ---------------------------------------------------------------------------

const headerShape = {
  kind: z.enum(partyKinds),
  displayName: optionalText(200),
  companyName: optionalText(200),
  firstName: optionalText(100),
  lastName: optionalText(100),
  reference: optionalText(50),
  tin: optionalText(50),
  email: optionalEmail,
  phone: optionalText(40),
  website: optionalText(200),
  notes: optionalText(2000),
};

const contactShape = {
  firstName: optionalText(100),
  lastName: optionalText(100),
  jobTitle: optionalText(100),
  email: optionalEmail,
  phone: optionalText(40),
  mobile: optionalText(40),
  isPrimary: z.boolean(),
  receivesDocuments: z.boolean(),
};
export const contactBody = z
  .object({
    ...Object.fromEntries(
      Object.entries(contactShape).map(([k, v]) => [
        k,
        k === 'isPrimary' || k === 'receivesDocuments'
          ? (v as z.ZodBoolean).default(false)
          : (v as ReturnType<typeof optionalText>).default(null),
      ]),
    ),
  })
  .strict()
  .refine((c) => c.firstName || c.lastName, {
    message: 'A contact person needs a first or last name.',
    path: ['firstName'],
  }) as unknown as z.ZodType<{
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isPrimary: boolean;
  receivesDocuments: boolean;
}>;
const contactPatch = z.object(contactShape).partial().strict();

const addressShape = {
  kind: z.enum(partyAddressKinds),
  label: optionalText(100),
  line1: z.string().trim().min(1, 'Address line 1 is required.').max(200),
  line2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  countryCode,
  isDefault: z.boolean(),
};
export const addressBody = z
  .object({
    ...addressShape,
    label: addressShape.label.default(null),
    line2: addressShape.line2.default(null),
    city: addressShape.city.default(null),
    region: addressShape.region.default(null),
    postalCode: addressShape.postalCode.default(null),
    isDefault: z.boolean().default(false),
  })
  .strict();
const addressPatch = z.object(addressShape).partial().strict();

export const createPartyBody = z
  .object({
    ...headerShape,
    displayName: headerShape.displayName.default(null),
    companyName: headerShape.companyName.default(null),
    firstName: headerShape.firstName.default(null),
    lastName: headerShape.lastName.default(null),
    reference: headerShape.reference.default(null),
    tin: headerShape.tin.default(null),
    email: headerShape.email.default(null),
    phone: headerShape.phone.default(null),
    website: headerShape.website.default(null),
    notes: headerShape.notes.default(null),
    roles: z.array(z.enum(partyRoles)).max(partyRoles.length).default([]),
    contacts: z.array(contactBody).max(50).default([]),
    addresses: z.array(addressBody).max(50).default([]),
  })
  .strict();
const updatePartyBody = z
  .object({
    version: z.number().int().min(1),
    ...Object.fromEntries(Object.entries(headerShape).map(([k, v]) => [k, v.optional()])),
    roles: z.array(z.enum(partyRoles)).max(partyRoles.length).optional(),
  })
  .strict();
const listQuery = z
  .object({
    search: z.string().trim().max(100).optional(),
    role: z.enum(partyRoles).optional(),
    status: z.enum(['active', 'archived', 'all']).default('active'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const emptyBody = z.object({}).strict();
const partyParams = z.object({ id: fields.id });
const contactParams = z.object({ id: fields.id, contactId: fields.id });
const addressParams = z.object({ id: fields.id, addressId: fields.id });

export function registerPartyRoutes(
  app: FastifyInstance,
  deps: { parties: PartyService; organizationProfile: OrganizationProfileService },
): void {
  const { parties, organizationProfile } = deps;

  // ---- Reference data and organization profile ----
  app.get('/reference/countries', async (request) => ({
    data: await organizationProfile.listCountries(requirePrincipal(request)),
  }));
  app.get('/organizations/current/profile', async (request) => ({
    data: await organizationProfile.getProfile(requirePrincipal(request)),
  }));
  app.put('/organizations/current/profile', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(profileBody, request.body);
    return { data: await organizationProfile.updateProfile(principal, body, eventOrigin(request)) };
  });

  // ---- Parties ----
  app.get('/parties', async (request) => ({
    data: await parties.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/parties', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createPartyBody, request.body);
    return reply
      .status(201)
      .send({ data: await parties.create(principal, body, eventOrigin(request)) });
  });
  app.get('/parties/:id', async (request) => {
    const { id } = parseInput(partyParams, request.params);
    return { data: await parties.get(requirePrincipal(request), id) };
  });
  app.patch('/parties/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(partyParams, request.params);
    const body = parseInput(updatePartyBody, request.body) as Parameters<PartyService['update']>[2];
    return { data: await parties.update(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/parties/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(partyParams, request.params);
      parseInput(emptyBody, request.body);
      return { data: await parties.setStatus(principal, id, status, eventOrigin(request)) };
    });
  }

  // ---- Contact persons ----
  app.post('/parties/:id/contacts', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(partyParams, request.params);
    const body = parseInput(contactBody, request.body);
    return reply
      .status(201)
      .send({ data: await parties.addContact(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/parties/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    const body = parseInput(contactPatch, request.body);
    return {
      data: await parties.updateContact(principal, id, contactId, body, eventOrigin(request)),
    };
  });
  app.delete('/parties/:id/contacts/:contactId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, contactId } = parseInput(contactParams, request.params);
    return { data: await parties.removeContact(principal, id, contactId, eventOrigin(request)) };
  });

  // ---- Addresses ----
  app.post('/parties/:id/addresses', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(partyParams, request.params);
    const body = parseInput(addressBody, request.body);
    return reply
      .status(201)
      .send({ data: await parties.addAddress(principal, id, body, eventOrigin(request)) });
  });
  app.patch('/parties/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    const body = parseInput(addressPatch, request.body);
    return {
      data: await parties.updateAddress(principal, id, addressId, body, eventOrigin(request)),
    };
  });
  app.delete('/parties/:id/addresses/:addressId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, addressId } = parseInput(addressParams, request.params);
    return { data: await parties.removeAddress(principal, id, addressId, eventOrigin(request)) };
  });
}
