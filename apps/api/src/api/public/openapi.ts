import { z } from 'zod';
import {
  AccountDto,
  BillDto,
  BillSummaryDto,
  CustomerDto,
  ErrorDto,
  InvoiceDto,
  InvoiceSummaryDto,
  ItemResultDto,
  PageDto,
  VendorDto,
} from './dto-v1.js';
import {
  CustomerCreateBody,
  CustomerUpdateBody,
  InvoiceDraftCreateBody,
  InvoiceDraftReplaceBody,
  ItemCreateBody,
  ItemUpdateBody,
} from './write-v1.js';

/**
 * The OpenAPI 3.1 document of the Public API v1 (ADR 0011 section 14). Its schemas are generated
 * from the public DTOs — never from internal tables or domain objects. A committed copy lives in
 * docs/openapi/public-v1.json and a test compares it with this output, so a change to a DTO, a
 * query or an endpoint cannot ship without a visible contract change.
 */

const schemaOf = (dto: z.ZodType, io: 'input' | 'output' = 'output') => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(dto, { io }) as Record<string, unknown>;
  return schema;
};

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (item: string) => ({
  type: 'object',
  required: ['data', 'page'],
  additionalProperties: false,
  properties: { data: { type: 'array', items: ref(item) }, page: ref('Page') },
});
const single = (item: string) => ({
  type: 'object',
  required: ['data'],
  additionalProperties: false,
  properties: { data: ref(item) },
});

const errorResponses = {
  '400': {
    description: 'Invalid request',
    content: { 'application/json': { schema: ref('Error') } },
  },
  '401': {
    description: 'Missing, invalid, expired or revoked token',
    content: { 'application/json': { schema: ref('Error') } },
  },
  '403': {
    description: 'The token does not allow this request',
    content: { 'application/json': { schema: ref('Error') } },
  },
  '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
  '429': {
    description: 'Rate limit exceeded',
    headers: {
      'RateLimit-Limit': { schema: { type: 'integer' } },
      'RateLimit-Remaining': { schema: { type: 'integer' } },
      'RateLimit-Reset': {
        schema: { type: 'integer' },
        description: 'Seconds until the window ends',
      },
      'Retry-After': {
        schema: { type: 'integer' },
        description: 'Seconds to wait before retrying',
      },
    },
    content: { 'application/json': { schema: ref('Error') } },
  },
};

const rateHeaders = {
  'RateLimit-Limit': { schema: { type: 'integer' } },
  'RateLimit-Remaining': { schema: { type: 'integer' } },
  'RateLimit-Reset': { schema: { type: 'integer' } },
};

const limit = {
  name: 'limit',
  in: 'query',
  schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
};
const cursor = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque cursor from page.next_cursor of the previous page, with the same filters.',
  schema: { type: 'string' },
};
const updatedSince = {
  name: 'updated_since',
  in: 'query',
  description: 'Only rows updated at or after this instant (ISO 8601).',
  schema: { type: 'string', format: 'date-time' },
};
const enumParam = (name: string, values: string[]) => ({
  name,
  in: 'query',
  schema: { type: 'string', enum: values },
});
const uuidParam = (name: string) => ({
  name,
  in: 'query',
  schema: { type: 'string', format: 'uuid' },
});
const dateParam = (name: string) => ({
  name,
  in: 'query',
  schema: { type: 'string', format: 'date' },
});
const idPath = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

function collection(tag: string, scope: string, summary: string, item: string, params: object[]) {
  return {
    get: {
      tags: [tag],
      summary,
      'x-required-scope': scope,
      security: [{ bearerAuth: [] }],
      parameters: [limit, cursor, updatedSince, ...params],
      responses: {
        '200': {
          description: 'A page',
          headers: rateHeaders,
          content: { 'application/json': { schema: listOf(item) } },
        },
        ...errorResponses,
      },
    },
  };
}

function member(tag: string, scope: string, summary: string, item: string) {
  return {
    get: {
      tags: [tag],
      summary,
      'x-required-scope': scope,
      security: [{ bearerAuth: [] }],
      parameters: [idPath],
      responses: {
        '200': {
          description: 'The resource',
          headers: rateHeaders,
          content: { 'application/json': { schema: single(item) } },
        },
        ...errorResponses,
      },
    },
  };
}

const idempotencyKeyParam = {
  name: 'Idempotency-Key',
  in: 'header',
  description:
    'Optional. A retry with the same key and body returns the first response (header Idempotent-Replayed: true); the same key with a different body is a 409 idempotency_conflict. Keys belong to the integration and are kept 24 hours.',
  schema: { type: 'string', minLength: 1, maxLength: 200 },
};

const writeErrors = {
  ...errorResponses,
  '409': {
    description:
      'version_conflict (the version sent is stale), idempotency_conflict, invalid_state (not a draft), or another conflict with the current state',
    content: { 'application/json': { schema: ref('Error') } },
  },
};

function writeOperation(spec: {
  tag: string;
  scope: string;
  summary: string;
  body: string;
  result: string;
  created: boolean;
  member: boolean;
}) {
  return {
    tags: [spec.tag],
    summary: spec.summary,
    'x-required-scope': spec.scope,
    security: [{ bearerAuth: [] }],
    parameters: [...(spec.member ? [idPath] : []), ...(spec.created ? [idempotencyKeyParam] : [])],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref(spec.body) } },
    },
    responses: {
      [spec.created ? '201' : '200']: {
        description: spec.created ? 'Created' : 'Updated',
        headers: rateHeaders,
        content: { 'application/json': { schema: single(spec.result) } },
      },
      ...writeErrors,
    },
  };
}

export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Intuit 2.0 Public API',
      version: '1.0.0',
      description:
        'Reads, plus draft writes for customers, items and draft invoices; nothing can be issued, posted, approved, voided or refunded through this API, and an invoice created here stays a draft until a person issues it in the application. Authenticate with `Authorization: Bearer <api token>`. Money is a decimal string in the document currency, dates are ISO 8601, ids are UUIDs. Within v1 fields are only added: clients must tolerate unknown fields and unknown enum values. Pagination is by opaque cursor; there is no offset. Requests are rate limited per token and organization (headers RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset; HTTP 429 with Retry-After).',
    },
    servers: [{ url: '/public/v1' }],
    security: [{ bearerAuth: [] }],
    tags: ['customers', 'items', 'vendors', 'invoices', 'bills', 'accounts'].map((name) => ({
      name,
    })),
    paths: {
      '/customers': {
        ...collection('customers', 'customers:read', 'List customers', 'Customer', [
          enumParam('status', ['ACTIVE', 'ARCHIVED']),
        ]),
        post: writeOperation({
          tag: 'customers',
          scope: 'customers:write',
          summary: 'Create a customer',
          body: 'CustomerCreate',
          result: 'Customer',
          created: true,
          member: false,
        }),
      },
      '/customers/{id}': {
        ...member('customers', 'customers:read', 'Get a customer', 'Customer'),
        patch: writeOperation({
          tag: 'customers',
          scope: 'customers:write',
          summary: 'Update a customer (send the version you read)',
          body: 'CustomerUpdate',
          result: 'Customer',
          created: false,
          member: true,
        }),
      },
      // Items are written, not read: the frozen scope catalog has no items:read, so there is no
      // GET under /items. The write result is the only way an item is returned.
      '/items': {
        post: writeOperation({
          tag: 'items',
          scope: 'items:write',
          summary: 'Create an item',
          body: 'ItemCreate',
          result: 'ItemResult',
          created: true,
          member: false,
        }),
      },
      '/items/{id}': {
        patch: writeOperation({
          tag: 'items',
          scope: 'items:write',
          summary: 'Update an item (send the version you read)',
          body: 'ItemUpdate',
          result: 'ItemResult',
          created: false,
          member: true,
        }),
      },
      '/vendors': collection('vendors', 'vendors:read', 'List vendors', 'Vendor', [
        enumParam('status', ['ACTIVE', 'ARCHIVED']),
      ]),
      '/vendors/{id}': member('vendors', 'vendors:read', 'Get a vendor', 'Vendor'),
      '/invoices': {
        ...collection('invoices', 'invoices:read', 'List invoices', 'InvoiceSummary', [
          enumParam('status', ['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'VOID']),
          uuidParam('customer_id'),
          dateParam('date_from'),
          dateParam('date_to'),
        ]),
        post: writeOperation({
          tag: 'invoices',
          scope: 'invoices:write',
          summary: 'Create a DRAFT invoice (only a person can issue it, in the application)',
          body: 'InvoiceDraftCreate',
          result: 'Invoice',
          created: true,
          member: false,
        }),
      },
      '/invoices/{id}': {
        ...member('invoices', 'invoices:read', 'Get an invoice with its lines', 'Invoice'),
        put: writeOperation({
          tag: 'invoices',
          scope: 'invoices:write',
          summary: 'Replace a DRAFT invoice (the lines sent are the lines kept; send the version)',
          body: 'InvoiceDraftReplace',
          result: 'Invoice',
          created: false,
          member: true,
        }),
      },
      '/bills': collection('bills', 'bills:read', 'List bills', 'BillSummary', [
        enumParam('status', ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID']),
        uuidParam('vendor_id'),
        dateParam('date_from'),
        dateParam('date_to'),
      ]),
      '/bills/{id}': member('bills', 'bills:read', 'Get a bill with its lines', 'Bill'),
      '/accounts': collection('accounts', 'accounts:read', 'List accounts', 'Account', [
        enumParam('status', ['ACTIVE', 'ARCHIVED']),
        enumParam('type', ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
      ]),
      '/accounts/{id}': member('accounts', 'accounts:read', 'Get an account', 'Account'),
    },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Customer: schemaOf(CustomerDto),
        Vendor: schemaOf(VendorDto),
        InvoiceSummary: schemaOf(InvoiceSummaryDto),
        Invoice: schemaOf(InvoiceDto),
        BillSummary: schemaOf(BillSummaryDto),
        Bill: schemaOf(BillDto),
        Account: schemaOf(AccountDto),
        ItemResult: schemaOf(ItemResultDto),
        CustomerCreate: schemaOf(CustomerCreateBody, 'input'),
        CustomerUpdate: schemaOf(CustomerUpdateBody, 'input'),
        ItemCreate: schemaOf(ItemCreateBody, 'input'),
        ItemUpdate: schemaOf(ItemUpdateBody, 'input'),
        InvoiceDraftCreate: schemaOf(InvoiceDraftCreateBody, 'input'),
        InvoiceDraftReplace: schemaOf(InvoiceDraftReplaceBody, 'input'),
        Page: schemaOf(PageDto),
        Error: schemaOf(ErrorDto),
      },
    },
  };
}
