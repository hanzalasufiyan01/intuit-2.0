import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ExpensePolicyService } from '../../application/expense-policy-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Expense policies (migration 0092). Strict schemas. */

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const name = z.string().trim().min(1).max(100);
const action = z.enum(['warn', 'block']);
const idParams = z.object({ id: fields.id }).strict();
const createBody = z
  .object({
    name,
    ruleType: z.enum(['max_amount', 'receipt_required_above']),
    amount,
    accountId: fields.id.nullable().optional(),
    action,
  })
  .strict();
const updateBody = z
  .object({
    version: z.number().int().min(1),
    name: name.optional(),
    amount: amount.optional(),
    action: action.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();

export function registerExpensePolicyRoutes(
  app: FastifyInstance,
  { expensePolicies }: { expensePolicies: ExpensePolicyService },
) {
  app.get('/purchases/expense-policies', async (request) => ({
    data: await expensePolicies.list(requirePrincipal(request)),
  }));
  app.post('/purchases/expense-policies', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await expensePolicies.create(
        principal,
        parseInput(createBody, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.patch('/purchases/expense-policies/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await expensePolicies.update(
        principal,
        id,
        parseInput(updateBody, request.body),
        eventOrigin(request),
      ),
    };
  });
}
