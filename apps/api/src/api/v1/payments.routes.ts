import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PaymentGatewayService } from '../../application/payment-gateway-service.js';
import type { RateLimiter } from '../../application/rate-limiter.js';
import { intentStatuses } from '../../modules/payments/index.js';
import { MOCK_SIGNATURE_HEADER } from '../../infrastructure/payments/mock-provider.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Online payments (migration 0075). Staff routes are authenticated and permission checked. The
 * unauthenticated routes are: the provider webhook (authenticated by its signature over the RAW
 * body, never by a cookie), and two customer routes behind an invoice share-link token. All are
 * rate limited per address and none returns anything about other invoices or tenants.
 *
 * `/public/mock-pay/*` is the simulated provider's hosted page backend. It exists only while the
 * mock provider is enabled and never moves money.
 */

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const idParams = z.object({ id: fields.id }).strict();
const settingsBody = z
  .object({
    version: z.number().int().min(0),
    mode: z.enum(['disabled', 'mock', 'live']),
    intentTtlMinutes: z.number().int().min(5).max(10080),
  })
  .strict();
const createBody = z.object({ invoiceId: fields.id, amount: amount.optional() }).strict();
const listQuery = z
  .object({
    invoiceId: fields.id.optional(),
    status: z.enum(intentStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
const tokenParams = z.object({ token: z.string().min(20).max(80) }).strict();
const providerParams = z.object({ provider: z.string().min(2).max(30) }).strict();
const refParams = z
  .object({
    ref: z
      .string()
      .min(3)
      .max(200)
      .regex(/^[A-Za-z0-9_]+$/),
  })
  .strict();
const settleBody = z.object({ outcome: z.enum(['succeeded', 'failed', 'cancelled']) }).strict();

const PUBLIC_PER_MINUTE = 20;
const WEBHOOK_PER_MINUTE = 300;

interface Deps {
  payments: PaymentGatewayService;
  rateLimiter: RateLimiter;
  /** Simulation controls; present only while the mock provider is enabled. */
  mockProvider?: {
    settle(
      ref: string,
      outcome: 'succeeded' | 'failed' | 'cancelled',
    ): { rawBody: string; headers: Record<string, string> };
  };
}

export function registerPaymentRoutes(app: FastifyInstance, deps: Deps): void {
  const { payments, rateLimiter: limiter } = deps;

  app.get('/payments/settings', async (request) => ({
    data: await payments.getSettings(requirePrincipal(request)),
  }));
  app.put('/payments/settings', async (request) => {
    const principal = requirePrincipal(request);
    const body = parseInput(settingsBody, request.body);
    return { data: await payments.saveSettings(principal, body, eventOrigin(request)) };
  });
  app.get('/payments/intents', async (request) => {
    const principal = requirePrincipal(request);
    return { data: await payments.list(principal, parseInput(listQuery, request.query)) };
  });
  app.get('/payments/intents/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await payments.get(principal, id) };
  });
  app.post('/payments/intents', async (request, reply) => {
    const principal = requirePrincipal(request);
    const body = parseInput(createBody, request.body);
    const result = await payments.create(
      principal,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.post('/payments/intents/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return { data: await payments.cancel(principal, id, eventOrigin(request)) };
  });
  app.post('/payments/intents/:id/reconcile', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return { data: await payments.reconcile(principal, id, eventOrigin(request)) };
  });

  // ---- Customer routes (no session; a live invoice share-link token is the credential) ----------

  const guardPublic = async (request: { ip: string }, reply: FastifyReply, bucket: string) => {
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

  app.post('/public/invoices/:token/pay', async (request, reply) => {
    const blocked = await guardPublic(request, reply, 'public-pay');
    if (blocked) return blocked;
    const { token } = parseInput(tokenParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return reply
      .status(201)
      .send({ data: await payments.createFromShareLink(token, eventOrigin(request)) });
  });
  app.get('/public/invoices/:token/payment', async (request, reply) => {
    const blocked = await guardPublic(request, reply, 'public-pay-status');
    if (blocked) return blocked;
    const { token } = parseInput(tokenParams, request.params);
    return { data: await payments.publicStatus(token, eventOrigin(request)) };
  });

  // ---- Provider webhook (signature over the raw body) --------------------------------------------

  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) =>
      done(null, body),
    );
    scoped.post('/payments/webhooks/:provider', async (request, reply) => {
      const decision = await limiter.consume(`payment-webhook:${request.ip}`, WEBHOOK_PER_MINUTE);
      reply.header('cache-control', 'no-store');
      if (!decision.allowed) {
        return reply
          .header('retry-after', String(decision.resetSeconds))
          .status(429)
          .send({ error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many requests.' } });
      }
      const { provider } = parseInput(providerParams, request.params);
      const raw = typeof request.body === 'string' ? request.body : '';
      const headers: Record<string, string | undefined> = {
        [MOCK_SIGNATURE_HEADER]: request.headers[MOCK_SIGNATURE_HEADER] as string | undefined,
      };
      const result = await payments.handleWebhook(provider, raw, headers, eventOrigin(request));
      return reply.status(200).send({ data: result });
    });
  });

  // ---- Simulated provider checkout (mock mode only) ----------------------------------------------

  if (deps.mockProvider) {
    const mock = deps.mockProvider;
    app.post('/public/mock-pay/:ref/settle', async (request, reply) => {
      const blocked = await guardPublic(request, reply, 'public-mock-pay');
      if (blocked) return blocked;
      const { ref } = parseInput(refParams, request.params);
      const { outcome } = parseInput(settleBody, request.body);
      // The simulated provider settles the charge, then delivers its signed webhook to us the
      // way a real provider would.
      let delivery;
      try {
        delivery = mock.settle(ref, outcome);
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'NOT_FOUND', message: 'Unknown simulated payment.' } });
      }
      const result = await payments.handleWebhook(
        'mock',
        delivery.rawBody,
        delivery.headers,
        eventOrigin(request),
      );
      return { data: { simulated: true, ...result } };
    });
  }
}
