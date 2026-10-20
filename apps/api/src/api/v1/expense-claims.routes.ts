import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExpenseClaimService } from '../../application/expense-claim-service.js';
import { claimStatuses } from '../../modules/expense-claims/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Employee expense claims. Strict schemas; decimals as strings. Approve and reject use the shared
 * approval routes (/approvals/requests/:id/...). Posting creates the reimbursable bill from the
 * employee as a vendor through Purchases, so it also needs the bill permissions.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const version = z.number().int().min(1);

const lineBody = z
  .object({
    expenseDate: isoDate,
    description: z.string().trim().min(1, 'Describe the expense.').max(500),
    accountId: fields.id.optional(),
    amount,
  })
  .strict();
const draftShape = {
  employeePartyId: fields.id,
  claimDate: isoDate,
  memo: z.string().trim().max(2000).optional(),
  lines: z.array(lineBody).min(1, 'Add at least one line.').max(100),
};
const createBody = z.object(draftShape).strict();
const updateBody = z.object({ version, ...draftShape }).strict();
const versionBody = z.object({ version }).strict();
// Submitting may carry the reason that confirms a warning from an expense policy (R-04).
const submitBody = z
  .object({ version, policyReason: z.string().trim().min(1).max(500).nullable().optional() })
  .strict();
const versionQuery = z.object({ version: z.coerce.number().int().min(1) }).strict();
const reasonBody = z
  .object({ version, reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();
const settingsBody = z
  .object({
    version: z.number().int().min(0),
    defaultExpenseAccountId: fields.id.nullable(),
    receiptRequiredOver: amount.nullable(),
  })
  .strict();
const listQuery = z
  .object({
    status: z
      .string()
      .transform((v) => v.split(',').filter(Boolean))
      .pipe(z.array(z.enum(claimStatuses)).max(6))
      .optional(),
    employeePartyId: fields.id.optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const idParams = z.object({ id: fields.id }).strict();

export function registerExpenseClaimRoutes(
  app: FastifyInstance,
  { expenseClaims }: { expenseClaims: ExpenseClaimService },
) {
  app.get('/expense-claims/settings', async (request) => ({
    data: await expenseClaims.getSettings(requirePrincipal(request)),
  }));
  app.put('/expense-claims/settings', async (request) => {
    const body = parseInput(settingsBody, request.body);
    return {
      data: await expenseClaims.updateSettings(
        requirePrincipal(request),
        body,
        eventOrigin(request),
      ),
    };
  });

  app.get('/expense-claims', async (request) => ({
    data: await expenseClaims.list(requirePrincipal(request), parseInput(listQuery, request.query)),
  }));
  app.post('/expense-claims', async (request, reply) => {
    const body = parseInput(createBody, request.body) as Parameters<
      ExpenseClaimService['create']
    >[1];
    const result = await expenseClaims.create(
      requirePrincipal(request),
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/expense-claims/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await expenseClaims.get(requirePrincipal(request), id) };
  });
  app.put('/expense-claims/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(updateBody, request.body) as Parameters<
      ExpenseClaimService['update']
    >[2];
    return {
      data: await expenseClaims.update(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.delete('/expense-claims/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const { version: v } = parseInput(versionQuery, request.query);
    return {
      data: await expenseClaims.delete(
        requirePrincipal(request),
        id,
        { version: v },
        eventOrigin(request),
      ),
    };
  });
  app.post('/expense-claims/:id/submit', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(submitBody, request.body);
    return {
      data: await expenseClaims.submit(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/expense-claims/:id/withdraw', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return {
      data: await expenseClaims.withdraw(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/expense-claims/:id/cancel', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await expenseClaims.cancel(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/expense-claims/:id/post', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(versionBody, request.body);
    return {
      data: await expenseClaims.post(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/expense-claims/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await expenseClaims.void(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
}
