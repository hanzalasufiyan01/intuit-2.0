import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PettyCashService } from '../../application/petty-cash-service.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/** Petty cash funds and counts (migration 0093). Strict schemas. */

const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const idParams = z.object({ id: fields.id }).strict();
const settingsBody = z
  .object({ overShortAccountId: fields.id.nullable(), version: z.number().int().min(0) })
  .strict();
const fundCreate = z
  .object({
    name: z.string().trim().min(1).max(100),
    accountId: fields.id,
    custodianName: z.string().trim().min(1).max(100),
    floatAmount: amount,
  })
  .strict();
const fundUpdate = z
  .object({
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(100).optional(),
    custodianName: z.string().trim().min(1).max(100).optional(),
    floatAmount: amount.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
const countBody = z
  .object({
    countDate: isoDate,
    countedAmount: amount,
    memo: z.string().trim().max(500).optional(),
  })
  .strict();
const countList = z
  .object({
    fundId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export function registerPettyCashRoutes(
  app: FastifyInstance,
  { pettyCash }: { pettyCash: PettyCashService },
) {
  app.get('/petty-cash/settings', async (request) => ({
    data: await pettyCash.getSettings(requirePrincipal(request)),
  }));
  app.put('/petty-cash/settings', async (request) => {
    const principal = requirePrincipal(request);
    return {
      data: await pettyCash.setSettings(
        principal,
        parseInput(settingsBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/petty-cash/funds', async (request) => ({
    data: await pettyCash.listFunds(requirePrincipal(request)),
  }));
  app.post('/petty-cash/funds', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await pettyCash.createFund(
        principal,
        parseInput(fundCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.patch('/petty-cash/funds/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await pettyCash.updateFund(
        principal,
        id,
        parseInput(fundUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/petty-cash/counts', async (request) => {
    const { fundId, limit } = parseInput(countList, request.query);
    return { data: await pettyCash.listCounts(requirePrincipal(request), fundId, limit) };
  });
  app.post('/petty-cash/funds/:id/counts', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return reply.status(201).send({
      data: await pettyCash.recordCount(
        principal,
        id,
        parseInput(countBody, request.body),
        eventOrigin(request),
      ),
    });
  });
}
