import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAccountingSettings } from '../../application/accounting-service.js';
import type { AuthorizationContext } from '../../application/authorization.js';
import type { CustomerService } from '../../application/customer-service.js';
import type { IdempotencyService } from '../../application/idempotency-service.js';
import type { InvoiceService } from '../../application/invoice-service.js';
import type { ItemService } from '../../application/item-service.js';
import type { PublicApiReadService } from '../../application/public-api-read-service.js';
import type { Transaction } from '../../database/client.js';
import { NotFoundError } from '../../domain/errors.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin } from '../http/session.js';
import { parseInput } from '../http/validation.js';
import { toCustomer, toInvoice, toItemResult } from './dto-v1.js';
import {
  CustomerCreateBody,
  CustomerUpdateBody,
  InvoiceDraftCreateBody,
  InvoiceDraftReplaceBody,
  ItemCreateBody,
  ItemUpdateBody,
  toCreateCustomerInput,
  toCreateItemInput,
  toInvoiceDraftInput,
  toUpdateCustomerInput,
  toUpdateItemInput,
} from './write-v1.js';

/**
 * The Public API draft write endpoints (ADR 0011 D1, section 22): customers, items and DRAFT
 * invoices — nothing else. Each handler is only
 *
 *   authenticate + authorize (scope ∩ platform policy ∩ organization boundary)
 *   -> validate the strict body -> the existing domain service in the integration's transaction
 *   -> map the result to a public DTO
 *
 * so every business rule, audit event and (internal) event of the web path applies unchanged and
 * nothing is duplicated here. Creates take an optional `Idempotency-Key` owned by the integration;
 * updates are checked against the resource `version` and never last-write-wins. There is no route
 * that issues, posts, approves, voids, refunds, records a receipt or touches a journal or ledger.
 */

export type AuthorizedRun = <T>(
  request: FastifyRequest,
  reply: FastifyReply,
  spec: { kind: 'read' | 'write'; permissions: readonly string[] },
  handler: (tx: Transaction, c: AuthorizationContext) => Promise<T>,
) => Promise<T>;

export interface PublicWriteDeps {
  authorized: AuthorizedRun;
  reads: PublicApiReadService;
  idempotency: IdempotencyService;
  customers: CustomerService;
  items: ItemService;
  invoices: InvoiceService;
}

const idParams = z.object({ id: z.uuid() }).strict();

export function registerPublicWrites(app: FastifyInstance, deps: PublicWriteDeps) {
  const { authorized, reads, idempotency, customers, items, invoices } = deps;

  /** A create: claims the integration's idempotency key, runs the domain write, answers 201. */
  function created<B, D>(
    path: string,
    operation: string,
    permission: string,
    schema: z.ZodType<B>,
    write: (
      tx: Transaction,
      c: AuthorizationContext,
      body: B,
      request: FastifyRequest,
    ) => Promise<D>,
  ) {
    app.post(path, (request, reply) =>
      authorized(request, reply, { kind: 'write', permissions: [permission] }, async (tx, c) => {
        const key = idempotencyKey(request);
        const body = parseInput(schema, request.body);
        const result = await idempotency.run(
          tx,
          c,
          { key, scope: `public.${operation}.create`, request: body },
          async () => ({ data: await write(tx, c, body, request) }),
        );
        markReplay(reply, result.replayed);
        void reply.status(201);
        return result.value;
      }),
    );
  }

  const customerDto = async (tx: Transaction, c: AuthorizationContext, id: string) => {
    const row = await reads.getCustomer(tx, c.organizationId, id);
    if (!row) throw new NotFoundError();
    return toCustomer(row);
  };
  const invoiceDto = async (tx: Transaction, c: AuthorizationContext, id: string) => {
    const found = await reads.getInvoice(tx, c.organizationId, id);
    if (!found) throw new NotFoundError();
    return toInvoice(found.row, found.lines);
  };

  // customers ---------------------------------------------------------------------------------
  created(
    '/customers',
    'customer',
    'customers.create',
    CustomerCreateBody,
    async (tx, c, body, r) => {
      const { customer } = await customers.createInTransaction(
        tx,
        c,
        toCreateCustomerInput(body),
        eventOrigin(r),
      );
      return customerDto(tx, c, customer.id);
    },
  );
  app.patch('/customers/:id', (request, reply) =>
    authorized(
      request,
      reply,
      { kind: 'write', permissions: ['customers.update'] },
      async (tx, c) => {
        const { id } = parseInput(idParams, request.params);
        const body = parseInput(CustomerUpdateBody, request.body);
        await customers.updateInTransaction(
          tx,
          c,
          id,
          toUpdateCustomerInput(body),
          eventOrigin(request),
          { customerVersionOnly: true },
        );
        return { data: await customerDto(tx, c, id) };
      },
    ),
  );

  // items (the result is returned by the write; there is no public item read) -------------------
  created('/items', 'item', 'catalog.items.manage', ItemCreateBody, async (tx, c, body, r) => {
    const item = await items.createInTransaction(tx, c, toCreateItemInput(body), eventOrigin(r));
    const settings = await requireAccountingSettings(tx, c.organizationId);
    return toItemResult(item, settings.baseCurrency);
  });
  app.patch('/items/:id', (request, reply) =>
    authorized(
      request,
      reply,
      { kind: 'write', permissions: ['catalog.items.manage'] },
      async (tx, c) => {
        const { id } = parseInput(idParams, request.params);
        const body = parseInput(ItemUpdateBody, request.body);
        const item = await items.updateInTransaction(
          tx,
          c,
          id,
          toUpdateItemInput(body),
          eventOrigin(request),
        );
        const settings = await requireAccountingSettings(tx, c.organizationId);
        return { data: toItemResult(item, settings.baseCurrency) };
      },
    ),
  );

  // draft invoices ----------------------------------------------------------------------------
  created(
    '/invoices',
    'invoice',
    'invoices.create',
    InvoiceDraftCreateBody,
    async (tx, c, body, r) => {
      const invoice = await invoices.createDraftInTransaction(
        tx,
        c,
        toInvoiceDraftInput(body),
        eventOrigin(r),
      );
      return invoiceDto(tx, c, invoice.id);
    },
  );
  // A draft is replaced as a whole (its lines are the lines sent), at the version the client read.
  app.put('/invoices/:id', (request, reply) =>
    authorized(
      request,
      reply,
      { kind: 'write', permissions: ['invoices.edit_draft'] },
      async (tx, c) => {
        const { id } = parseInput(idParams, request.params);
        const body = parseInput(InvoiceDraftReplaceBody, request.body);
        await invoices.updateDraftInTransaction(
          tx,
          c,
          id,
          { ...toInvoiceDraftInput(body), version: body.version },
          eventOrigin(request),
        );
        return { data: await invoiceDto(tx, c, id) };
      },
    ),
  );
}
