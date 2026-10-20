import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CustomerStatementService } from '../../application/customer-statement-service.js';
import type { RateLimiter } from '../../application/rate-limiter.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Customer statement links (customer portal v1, migration 0076). Staff routes need
 * `invoice_links.manage`. The two public routes are keyed by an unguessable token, rate limited per
 * address, never cached, and answer every invalid token with the same 404.
 */

const idParams = z.object({ id: fields.id }).strict();
const linkBody = z.object({ expiresInDays: z.number().int().min(1).max(90).default(30) }).strict();
const tokenParams = z.object({ token: z.string().min(20).max(80) }).strict();
const payParams = z.object({ token: z.string().min(20).max(80), invoiceId: fields.id }).strict();

const PUBLIC_PER_MINUTE = 30;

export function registerStatementRoutes(
  app: FastifyInstance,
  deps: { statements: CustomerStatementService; rateLimiter: RateLimiter },
): void {
  const { statements, rateLimiter: limiter } = deps;

  app.post('/customers/:id/statement-links', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(linkBody, request.body ?? {});
    reply.header('cache-control', 'no-store');
    return reply
      .status(201)
      .send({ data: await statements.create(principal, id, body, eventOrigin(request)) });
  });
  app.get('/customers/:id/statement-links', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await statements.list(principal, id) };
  });
  app.post('/customers/statement-links/:id/revoke', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return { data: await statements.revoke(principal, id, eventOrigin(request)) };
  });

  const guard = async (request: { ip: string }, reply: FastifyReply, bucket: string) => {
    reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex');
    const decision = await limiter.consume(`${bucket}:${request.ip}`, PUBLIC_PER_MINUTE);
    if (!decision.allowed) {
      return reply
        .header('retry-after', String(decision.resetSeconds))
        .status(429)
        .send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many requests.' } });
    }
    return null;
  };

  app.get('/public/statements/:token', async (request, reply) => {
    const blocked = await guard(request, reply, 'public-statement');
    if (blocked) return blocked;
    const { token } = parseInput(tokenParams, request.params);
    return { data: await statements.open(token, eventOrigin(request)) };
  });
  app.post('/public/statements/:token/invoices/:invoiceId/pay', async (request, reply) => {
    const blocked = await guard(request, reply, 'public-statement-pay');
    if (blocked) return blocked;
    const { token, invoiceId } = parseInput(payParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return reply
      .status(201)
      .send({ data: await statements.pay(token, invoiceId, eventOrigin(request)) });
  });
}
