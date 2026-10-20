import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ClassificationService } from '../../application/classification-service.js';
import { customFieldTypes } from '../../modules/classification/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Customer groups, custom fields on customers, product categories and barcodes (migration 0088).
 * Strict schemas. Customer-side routes need customers.update to change; item-side routes need the
 * catalog management permission.
 */

const idParams = z.object({ id: fields.id }).strict();
const version = z.number().int().min(1);
const name = z.string().trim().min(1).max(100);
const namedCreate = z.object({ name }).strict();
const namedUpdate = z
  .object({ version, name: name.optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional() })
  .strict();
const fieldKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'Use lower-case letters, digits and "_".');
const fieldCreate = z
  .object({
    key: fieldKey,
    label: name,
    fieldType: z.enum(customFieldTypes),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
const fieldUpdate = z
  .object({
    version,
    label: name.optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
const fieldValues = z
  .object({
    values: z.record(
      fieldKey,
      z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]),
    ),
  })
  .strict();
const groupBody = z.object({ groupId: fields.id.nullable() }).strict();
const categoryBody = z.object({ categoryId: fields.id.nullable() }).strict();
const barcodesBody = z.object({ barcodes: z.array(z.string().max(64)).max(20) }).strict();
const barcodeParams = z.object({ code: z.string().min(1).max(64) }).strict();
const variantBody = z
  .object({
    groupId: fields.id.nullable(),
    attributes: z.record(z.string().min(1).max(40), z.string().min(1).max(100)).optional(),
  })
  .strict();
const binCreate = z
  .object({
    warehouseId: fields.id,
    code: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/, 'Use up to 20 letters, digits, ".", "_" or "-".'),
    name: z.string().trim().max(100).optional(),
  })
  .strict();
const binUpdate = z
  .object({
    version,
    name: z.string().trim().max(100).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
const binList = z.object({ warehouseId: fields.id.optional() }).strict();
const defaultBinBody = z.object({ warehouseId: fields.id, binId: fields.id.nullable() }).strict();

export function registerClassificationRoutes(
  app: FastifyInstance,
  { classification }: { classification: ClassificationService },
) {
  // Customer groups
  app.get('/customer-groups', async (request) => ({
    data: await classification.listNamed(requirePrincipal(request), 'group'),
  }));
  app.post('/customer-groups', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { name: n } = parseInput(namedCreate, request.body);
    return reply.status(201).send({
      data: await classification.createNamed(principal, 'group', n, eventOrigin(request)),
    });
  });
  app.patch('/customer-groups/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.updateNamed(
        principal,
        'group',
        id,
        parseInput(namedUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/customer-groups/:id/customers', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.customersInGroup(requirePrincipal(request), id) };
  });
  app.get('/customers/:id/group', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.getCustomerGroup(requirePrincipal(request), id) };
  });
  app.put('/customers/:id/group', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { groupId } = parseInput(groupBody, request.body);
    return {
      data: await classification.setCustomerGroup(principal, id, groupId, eventOrigin(request)),
    };
  });

  // Custom fields on customers
  app.get('/custom-fields', async (request) => ({
    data: await classification.listFields(requirePrincipal(request)),
  }));
  app.post('/custom-fields', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await classification.createField(
        principal,
        parseInput(fieldCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.patch('/custom-fields/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.updateField(
        principal,
        id,
        parseInput(fieldUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/customers/:id/custom-fields', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.getCustomerFields(requirePrincipal(request), id) };
  });
  app.put('/customers/:id/custom-fields', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { values } = parseInput(fieldValues, request.body);
    return {
      data: await classification.setCustomerFields(principal, id, values, eventOrigin(request)),
    };
  });

  // Variant groups and bins (migration 0090)
  app.get('/variant-groups', async (request) => ({
    data: await classification.listNamed(requirePrincipal(request), 'variant'),
  }));
  app.post('/variant-groups', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { name: n } = parseInput(namedCreate, request.body);
    return reply.status(201).send({
      data: await classification.createNamed(principal, 'variant', n, eventOrigin(request)),
    });
  });
  app.patch('/variant-groups/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.updateNamed(
        principal,
        'variant',
        id,
        parseInput(namedUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/variant-groups/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.variantGroupDetail(requirePrincipal(request), id) };
  });
  app.get('/sales/items/:id/variant', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.getItemVariant(requirePrincipal(request), id) };
  });
  app.put('/sales/items/:id/variant', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.setItemVariant(
        principal,
        id,
        parseInput(variantBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/inventory/bins', async (request) => {
    const { warehouseId } = parseInput(binList, request.query);
    return { data: await classification.listBins(requirePrincipal(request), warehouseId) };
  });
  app.post('/inventory/bins', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await classification.createBin(
        principal,
        parseInput(binCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.patch('/inventory/bins/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.updateBin(
        principal,
        id,
        parseInput(binUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/inventory/items/:id/default-bins', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.getDefaultBins(requirePrincipal(request), id) };
  });
  app.put('/inventory/items/:id/default-bin', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { warehouseId, binId } = parseInput(defaultBinBody, request.body);
    return {
      data: await classification.setDefaultBin(
        principal,
        id,
        binId,
        warehouseId,
        eventOrigin(request),
      ),
    };
  });

  // Item categories and barcodes
  app.get('/item-categories', async (request) => ({
    data: await classification.listNamed(requirePrincipal(request), 'category'),
  }));
  app.post('/item-categories', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { name: n } = parseInput(namedCreate, request.body);
    return reply.status(201).send({
      data: await classification.createNamed(principal, 'category', n, eventOrigin(request)),
    });
  });
  app.patch('/item-categories/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await classification.updateNamed(
        principal,
        'category',
        id,
        parseInput(namedUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/item-categories/:id/items', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.itemsInCategory(requirePrincipal(request), id) };
  });
  // Registered before /sales/items/:id so the static segment wins.
  app.get('/sales/items/by-barcode/:code', async (request) => {
    const { code } = parseInput(barcodeParams, request.params);
    return { data: await classification.itemByBarcode(requirePrincipal(request), code) };
  });
  app.get('/sales/items/:id/classification', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await classification.getItemClassification(requirePrincipal(request), id) };
  });
  app.put('/sales/items/:id/category', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { categoryId } = parseInput(categoryBody, request.body);
    return {
      data: await classification.setItemCategory(principal, id, categoryId, eventOrigin(request)),
    };
  });
  app.put('/sales/items/:id/barcodes', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const { barcodes } = parseInput(barcodesBody, request.body);
    return {
      data: await classification.setItemBarcodes(principal, id, barcodes, eventOrigin(request)),
    };
  });
}
