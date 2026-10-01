import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ItemService } from '../../application/item-service.js';
import type { SalesSettingsService } from '../../application/sales-settings-service.js';
import { salesItemTypes } from '../../modules/sales/index.js';
import { taxTreatments } from '../../modules/tax/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Sales settings, numbering and items (Phase 3B steps 3 and 5). Every schema is strict. */

const numberingShape = z
  .object({
    prefix: z
      .string()
      .regex(/^[A-Za-z0-9/_.#-]{0,12}$/, 'Use up to 12 letters, digits or / _ . # -.'),
    minDigits: z.number().int().min(1).max(10),
    nextNumber: z.number().int().min(1).max(999_999_999_999),
  })
  .strict();

const settingsBody = z
  .object({
    version: z.number().int().min(0),
    arAccountId: fields.id.nullable(),
    defaultRevenueAccountId: fields.id.nullable(),
    defaultDepositAccountId: fields.id.nullable(),
    defaultTaxCodeId: fields.id.nullable(),
    defaultTaxTreatment: z.enum(taxTreatments),
    defaultPaymentTermsDays: z.number().int().min(0).max(365),
    numbering: z
      .object({
        invoice: numberingShape.optional(),
        credit_note: numberingShape.optional(),
        receipt: numberingShape.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const itemShape = {
  sku: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,49}$/, 'Use up to 50 letters, digits or . _ / # -.')
    .nullable()
    .or(z.literal('').transform(() => null)),
  name: z.string().trim().min(1, 'The name is required.').max(200),
  itemType: z.enum(salesItemTypes),
  description: z.string().trim().max(1000),
  unitPrice: z
    .string()
    .regex(/^(0|[1-9]\d{0,23})(\.\d{1,4})?$/, 'Enter a non-negative price.')
    .nullable(),
  revenueAccountId: fields.id.nullable(),
  taxCodeId: fields.id.nullable(),
};
const createItemBody = z
  .object({
    ...itemShape,
    sku: itemShape.sku.default(null),
    description: itemShape.description.default(''),
    unitPrice: itemShape.unitPrice.default(null),
    revenueAccountId: itemShape.revenueAccountId.default(null),
    taxCodeId: itemShape.taxCodeId.default(null),
  })
  .strict();
const updateItemBody = z
  .object({
    version: z.number().int().min(1),
    ...Object.fromEntries(Object.entries(itemShape).map(([k, v]) => [k, v.optional()])),
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

export function registerSalesRoutes(
  app: FastifyInstance,
  { salesSettings, items }: { salesSettings: SalesSettingsService; items: ItemService },
) {
  // ---- Settings and numbering ----
  app.get('/sales/settings', async (request) => ({
    data: await salesSettings.get(requirePrincipal(request)),
  }));
  app.put('/sales/settings', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(settingsBody, request.body);
    return { data: await salesSettings.update(principal, body, eventOrigin(request)) };
  });

  // ---- Items ----
  app.get('/sales/items', async (request) => ({
    data: await items.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/sales/items', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createItemBody, request.body);
    return reply
      .status(201)
      .send({ data: await items.create(principal, body, eventOrigin(request)) });
  });
  app.get('/sales/items/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await items.get(requirePrincipal(request), id) };
  });
  app.patch('/sales/items/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateItemBody, request.body) as Parameters<ItemService['update']>[2];
    return { data: await items.update(principal, id, body, eventOrigin(request)) };
  });
  for (const [action, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/sales/items/:id/${action}`, async (request) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const { version } = parseInput(versionBody, request.body);
      return {
        data: await items.setStatus(principal, id, { version, status }, eventOrigin(request)),
      };
    });
  }
}
