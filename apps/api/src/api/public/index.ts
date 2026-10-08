import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IntegrationAuthService } from '../../application/integration-auth-service.js';
import type { PublicApiReadService } from '../../application/public-api-read-service.js';
import {
  RateLimitedError,
  type RateDecision,
  type RateLimiter,
} from '../../application/rate-limiter.js';
import type { AuthorizationContext } from '../../application/authorization.js';
import type { Transaction } from '../../database/client.js';
import { NotFoundError, PermissionDeniedError, UnauthenticatedError } from '../../domain/errors.js';
import type { AppConfig } from '../../infrastructure/config/config.js';
import { eventOrigin } from '../http/session.js';
import { parseInput } from '../http/validation.js';
import { decodeCursor, encodeCursor, filterKey } from './cursor.js';
import {
  toAccount,
  toBill,
  toBillSummary,
  toCustomer,
  toInvoice,
  toInvoiceSummary,
  toItem,
  toVendor,
} from './dto-v1.js';
import { registerPublicErrors, rateLimitHeaders } from './errors.js';
import { buildOpenApiDocument } from './openapi.js';

/**
 * The Public API, version 1 (ADR 0011): `/public/v1`, read-only in this step. A separate Fastify
 * plugin with its own authentication, error contract, rate limiting and DTOs. It is authenticated
 * ONLY by `Authorization: Bearer <api token>` through IntegrationAuthService: cookies and
 * sessions are never read here, and the internal `/api/v1` never accepts tokens.
 *
 * Every endpoint requires, per request, the integration's scopes within the fixed platform policy
 * within the current non-Owner organization permission boundary (the effective permissions of the
 * integration context) to include one of its permissions.
 */

export interface PublicApiDeps {
  config: AppConfig;
  integrationAuth: IntegrationAuthService;
  reads: PublicApiReadService;
  limiter: RateLimiter;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const uuid = z.uuid();
const listBase = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).max(600).optional(),
  updated_since: z.iso.datetime({ offset: true }).optional(),
};
const status2 = z.enum(['ACTIVE', 'ARCHIVED']);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idParams = z.object({ id: uuid }).strict();

const queries = {
  customers: z.object({ ...listBase, status: status2.optional() }).strict(),
  vendors: z.object({ ...listBase, status: status2.optional() }).strict(),
  items: z
    .object({
      ...listBase,
      status: status2.optional(),
      item_type: z.enum(['service', 'product']).optional(),
    })
    .strict(),
  invoices: z
    .object({
      ...listBase,
      status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'VOID']).optional(),
      customer_id: uuid.optional(),
      date_from: dateOnly.optional(),
      date_to: dateOnly.optional(),
    })
    .strict(),
  bills: z
    .object({
      ...listBase,
      status: z.enum(['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'VOID']).optional(),
      vendor_id: uuid.optional(),
      date_from: dateOnly.optional(),
      date_to: dateOnly.optional(),
    })
    .strict(),
  accounts: z
    .object({
      ...listBase,
      status: status2.optional(),
      type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']).optional(),
    })
    .strict(),
};

/** The permissions behind the scopes (ADR 0011, scopes.ts). Items follow the catalog's own rule. */
const PERMISSIONS = {
  customers: ['customers.view'],
  vendors: ['vendors.view'],
  invoices: ['invoices.view'],
  bills: ['bills.view'],
  accounts: ['accounting.accounts.view'],
  // The catalog has no item view permission: items are viewable by invoice, bill or catalog
  // managers (ItemService). No `items:read` scope exists, and none is invented.
  items: ['invoices.view', 'bills.view', 'catalog.items.manage'],
} as const;

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export function publicApi(deps: PublicApiDeps) {
  const { config, integrationAuth, reads, limiter } = deps;
  const limits = config.publicApi;

  /** Counts the request against the token and organization windows. */
  async function enforceLimits(
    c: AuthorizationContext,
    kind: 'read' | 'write',
  ): Promise<RateDecision> {
    const perToken = await limiter.consume(
      `token:${c.integration!.tokenId}:${kind}`,
      kind === 'read' ? limits.readPerMinute : limits.writePerMinute,
    );
    if (!perToken.allowed) throw new RateLimitedError(perToken);
    const perOrganization = await limiter.consume(
      `org:${c.organizationId}`,
      limits.organizationPerMinute,
    );
    if (!perOrganization.allowed) throw new RateLimitedError(perOrganization);
    return perToken.remaining <= perOrganization.remaining ? perToken : perOrganization;
  }

  async function authorized<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    spec: { kind: 'read' | 'write'; permissions: readonly string[] },
    handler: (tx: Transaction, c: AuthorizationContext) => Promise<T>,
  ): Promise<T> {
    const failures = `authfail:${request.ip || 'unknown'}`;
    const gate = await limiter.peek(failures, limits.failedAuthPerMinutePerIp);
    if (gate.remaining === 0) throw new RateLimitedError({ ...gate, allowed: false });
    let rate: RateDecision | undefined;
    try {
      const result = await integrationAuth.withIntegration(
        bearer(request),
        { origin: eventOrigin(request) },
        async (tx, c) => {
          rate = await enforceLimits(c, spec.kind);
          if (!spec.permissions.some((p) => c.permissions.has(p)))
            throw new PermissionDeniedError();
          return handler(tx, c);
        },
      );
      if (rate) rateLimitHeaders(reply, rate);
      return result;
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        await limiter.consume(failures, limits.failedAuthPerMinutePerIp);
      }
      throw error;
    }
  }

  /** One keyset page: parse, decode the bound cursor, query limit+1, map, and sign the next cursor. */
  async function page<
    Q extends { limit: number; cursor?: string | undefined },
    R extends { id: unknown; cursor_ts: unknown },
    D,
  >(
    c: AuthorizationContext,
    resource: string,
    query: Q,
    filters: Record<string, string | undefined>,
    fetch: (after: ReturnType<typeof decodeCursor> | null, take: number) => Promise<R[]>,
    map: (row: R) => D,
  ) {
    const scope = { resource, organizationId: c.organizationId, filters: filterKey(filters) };
    const after = query.cursor ? decodeCursor(config.session.secret, scope, query.cursor) : null;
    const rows = await fetch(after, query.limit + 1);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      data: items.map(map),
      page: {
        next_cursor:
          hasMore && last
            ? encodeCursor(config.session.secret, scope, {
                timestamp: String(last.cursor_ts),
                id: String(last.id),
              })
            : null,
        has_more: hasMore,
      },
    };
  }

  const common = (q: { status?: string | undefined; updated_since?: string | undefined }) => ({
    status: q.status,
    updatedSince: q.updated_since,
  });

  type Base = { limit: number; cursor?: string | undefined };

  return async function register(app: FastifyInstance) {
    registerPublicErrors(app);

    // The contract document needs no credentials.
    app.get('/openapi.json', async () => buildOpenApiDocument());

    /**
     * A paged collection. The request is authenticated before anything about it is validated, so
     * an unauthenticated caller learns nothing but the generic 401.
     */
    function collection<Q extends Base, R extends { id: unknown; cursor_ts: unknown }, D>(
      path: string,
      resource: keyof typeof PERMISSIONS,
      schema: z.ZodType<Q>,
      filters: (q: Q) => Record<string, string | undefined>,
      fetch: (
        tx: Transaction,
        c: AuthorizationContext,
        q: Q,
        after: ReturnType<typeof decodeCursor> | null,
        take: number,
      ) => Promise<R[]>,
      map: (row: R) => D,
    ) {
      app.get(path, (request, reply) =>
        authorized(
          request,
          reply,
          { kind: 'read', permissions: PERMISSIONS[resource] },
          (tx, c) => {
            const q = parseInput(schema, request.query);
            return page(
              c,
              resource,
              q,
              filters(q),
              (after, take) => fetch(tx, c, q, after, take),
              map,
            );
          },
        ),
      );
    }

    function member<D>(
      path: string,
      resource: keyof typeof PERMISSIONS,
      fetchOne: (tx: Transaction, c: AuthorizationContext, id: string) => Promise<D | undefined>,
    ) {
      app.get(path, (request, reply) =>
        authorized(
          request,
          reply,
          { kind: 'read', permissions: PERMISSIONS[resource] },
          async (tx, c) => {
            const { id } = parseInput(idParams, request.params);
            const data = await fetchOne(tx, c, id);
            if (data === undefined) throw new NotFoundError();
            return { data };
          },
        ),
      );
    }

    const base = (q: { status?: string | undefined; updated_since?: string | undefined }) => ({
      status: q.status,
      updated_since: q.updated_since,
    });

    collection(
      '/customers',
      'customers',
      queries.customers,
      base,
      (tx, c, q, after, take) => reads.listCustomers(tx, c.organizationId, common(q), after, take),
      toCustomer,
    );
    member('/customers/:id', 'customers', async (tx, c, id) => {
      const row = await reads.getCustomer(tx, c.organizationId, id);
      return row && toCustomer(row);
    });

    collection(
      '/vendors',
      'vendors',
      queries.vendors,
      base,
      (tx, c, q, after, take) => reads.listVendors(tx, c.organizationId, common(q), after, take),
      toVendor,
    );
    member('/vendors/:id', 'vendors', async (tx, c, id) => {
      const row = await reads.getVendor(tx, c.organizationId, id);
      return row && toVendor(row);
    });

    collection(
      '/items',
      'items',
      queries.items,
      (q) => ({ ...base(q), item_type: q.item_type }),
      (tx, c, q, after, take) =>
        reads.listItems(tx, c.organizationId, { ...common(q), itemType: q.item_type }, after, take),
      toItem,
    );
    member('/items/:id', 'items', async (tx, c, id) => {
      const row = await reads.getItem(tx, c.organizationId, id);
      return row && toItem(row);
    });

    collection(
      '/invoices',
      'invoices',
      queries.invoices,
      (q) => ({
        ...base(q),
        customer_id: q.customer_id,
        date_from: q.date_from,
        date_to: q.date_to,
      }),
      (tx, c, q, after, take) =>
        reads.listInvoices(
          tx,
          c.organizationId,
          { ...common(q), customerId: q.customer_id, dateFrom: q.date_from, dateTo: q.date_to },
          after,
          take,
        ),
      toInvoiceSummary,
    );
    member('/invoices/:id', 'invoices', async (tx, c, id) => {
      const found = await reads.getInvoice(tx, c.organizationId, id);
      return found && toInvoice(found.row, found.lines);
    });

    collection(
      '/bills',
      'bills',
      queries.bills,
      (q) => ({ ...base(q), vendor_id: q.vendor_id, date_from: q.date_from, date_to: q.date_to }),
      (tx, c, q, after, take) =>
        reads.listBills(
          tx,
          c.organizationId,
          { ...common(q), vendorId: q.vendor_id, dateFrom: q.date_from, dateTo: q.date_to },
          after,
          take,
        ),
      toBillSummary,
    );
    member('/bills/:id', 'bills', async (tx, c, id) => {
      const found = await reads.getBill(tx, c.organizationId, id);
      return found && toBill(found.row, found.lines);
    });

    collection(
      '/accounts',
      'accounts',
      queries.accounts,
      (q) => ({ ...base(q), type: q.type }),
      (tx, c, q, after, take) =>
        reads.listAccounts(tx, c.organizationId, { ...common(q), type: q.type }, after, take),
      toAccount,
    );
    member('/accounts/:id', 'accounts', async (tx, c, id) => {
      const row = await reads.getAccount(tx, c.organizationId, id);
      return row && toAccount(row);
    });
  };
}
