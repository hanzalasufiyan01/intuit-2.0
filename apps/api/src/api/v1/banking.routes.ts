import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BankingPostingService } from '../../application/banking-posting-service.js';
import type { BankingService } from '../../application/banking-service.js';
import { bankTransactionStatuses } from '../../modules/banking/index.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Banking (strict schemas; decimals as strings; amounts from the server). Reading needs
 * `banking.transactions.view`; the other actions have their own permissions. Voids and reopening a
 * reconciliation also need a recent password confirmation.
 */

/** A 5 MB statement as JSON (the content is escaped), with room for the mapping. */
const STATEMENT_BODY_LIMIT = 6 * 1024 * 1024;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const signedDecimal = z
  .string()
  .regex(/^-?\d{1,22}(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const positiveDecimal = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();
const versionBody = z.object({ version }).strict();
const reasonBody = z
  .object({ version, reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();

const accountBody = z
  .object({
    accountId: fields.id,
    name: z.string().trim().min(1).max(100).optional(),
    openingBalance: signedDecimal.optional(),
    openingBalanceDate: isoDate.nullable().optional(),
  })
  .strict();
const accountUpdateBody = z
  .object({
    version,
    name: z.string().trim().min(1).max(100).optional(),
    openingBalance: signedDecimal.optional(),
    openingBalanceDate: isoDate.nullable().optional(),
  })
  .strict();

const csvMapping = z
  .object({
    dateColumn: z.string().trim().min(1).max(200),
    descriptionColumn: z.string().trim().min(1).max(200),
    amountColumn: z.string().trim().max(200).optional(),
    debitColumn: z.string().trim().max(200).optional(),
    creditColumn: z.string().trim().max(200).optional(),
    referenceColumn: z.string().trim().max(200).optional(),
    balanceColumn: z.string().trim().max(200).optional(),
    dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']),
    decimalSeparator: z.enum(['.', ',']),
    delimiter: z.enum([',', ';', '\t', 'auto']),
  })
  .strict();
const importBody = z
  .object({
    format: z.enum(['csv', 'ofx']),
    content: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
    mapping: csvMapping.optional(),
  })
  .strict();
const previewBody = z
  .object({
    content: z
      .string()
      .min(1)
      .max(5 * 1024 * 1024),
  })
  .strict();

const transactionsQuery = z
  .object({
    status: z.enum(bankTransactionStatuses).optional(),
    search: z.string().trim().max(100).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    after: z.string().max(500).optional(),
  })
  .strict();
const registerQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    unmatchedOnly: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const listQuery = z
  .object({
    bankingAccountId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

const matchBody = z.object({ journalLineId: fields.id }).strict();
const excludeBody = z
  .object({ reason: z.string().trim().min(1, 'Give a reason.').max(500) })
  .strict();
const categorizeBody = z
  .object({
    categoryAccountId: fields.id,
    memo: z.string().trim().max(500).optional(),
    dimensionValueIds: z.array(fields.id).max(20).optional(),
  })
  .strict();
const transferBody = z
  .object({
    transferDate: isoDate,
    fromBankingAccountId: fields.id,
    toBankingAccountId: fields.id,
    fromAmount: positiveDecimal,
    toAmount: positiveDecimal.optional(),
    memo: z.string().trim().max(500).optional(),
    dimensionValueIds: z.array(fields.id).max(20).optional(),
  })
  .strict();
const statementBody = z
  .object({ statementDate: isoDate, statementBalance: signedDecimal })
  .strict();

const ruleShape = {
  name: z.string().trim().min(1).max(100),
  bankingAccountId: fields.id.nullable().optional(),
  priority: z.number().int().min(1).max(10_000).optional(),
  direction: z.enum(['in', 'out', 'any']).optional(),
  descriptionContains: z.string().trim().min(1).max(200).nullable().optional(),
  minAmount: positiveDecimal.nullable().optional(),
  maxAmount: positiveDecimal.nullable().optional(),
  categoryAccountId: fields.id,
  memo: z.string().trim().max(500).optional(),
};
const ruleBody = z.object(ruleShape).strict();
const ruleUpdateBody = z.object({ version, ...ruleShape }).strict();

export function registerBankingRoutes(
  app: FastifyInstance,
  { banking, bankingPosting }: { banking: BankingService; bankingPosting: BankingPostingService },
) {
  // Bank accounts
  app.get('/banking/accounts', async (request) => ({
    data: await banking.listAccounts(requirePrincipal(request)),
  }));
  app.post('/banking/accounts', async (request, reply) => {
    const body = parseInput(accountBody, request.body);
    const data = await banking.createAccount(requirePrincipal(request), body, eventOrigin(request));
    return reply.status(201).send({ data });
  });
  app.get('/banking/accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.getAccount(requirePrincipal(request), id) };
  });
  app.patch('/banking/accounts/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(accountUpdateBody, request.body);
    return {
      data: await banking.updateAccount(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  for (const [path, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/banking/accounts/:id/${path}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await banking.setAccountStatus(
          requirePrincipal(request),
          id,
          status,
          body,
          eventOrigin(request),
        ),
      };
    });
  }

  // Statements
  app.post('/banking/statements/preview', { bodyLimit: STATEMENT_BODY_LIMIT }, async (request) => {
    const body = parseInput(previewBody, request.body);
    return { data: await banking.previewCsv(requirePrincipal(request), body.content) };
  });
  app.post(
    '/banking/accounts/:id/statements',
    { bodyLimit: STATEMENT_BODY_LIMIT },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(importBody, request.body) as Parameters<
        BankingService['importStatement']
      >[2];
      const result = await banking.importStatement(
        principal,
        id,
        body,
        { idempotencyKey: idempotencyKey(request) },
        eventOrigin(request),
      );
      markReplay(reply, result.replayed);
      return reply.status(201).send({ data: result.value });
    },
  );
  app.get('/banking/accounts/:id/statements', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.listImports(requirePrincipal(request), id) };
  });

  // Transactions and matching
  app.get('/banking/accounts/:id/transactions', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(transactionsQuery, request.query);
    return { data: await banking.listTransactions(requirePrincipal(request), id, query) };
  });
  app.get('/banking/accounts/:id/register', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const query = parseInput(registerQuery, request.query);
    return { data: await banking.register(requirePrincipal(request), id, query) };
  });
  app.get('/banking/accounts/:id/unreconciled', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await bankingPosting.unreconciled(requirePrincipal(request), id) };
  });
  app.post('/banking/accounts/:id/auto-match', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.autoMatch(requirePrincipal(request), id, eventOrigin(request)) };
  });
  app.get('/banking/transactions/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.getTransaction(requirePrincipal(request), id) };
  });
  app.get('/banking/transactions/:id/suggestions', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.suggestMatches(requirePrincipal(request), id) };
  });
  app.post('/banking/transactions/:id/match', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(matchBody, request.body);
    return { data: await banking.match(requirePrincipal(request), id, body, eventOrigin(request)) };
  });
  app.post('/banking/transactions/:id/unmatch', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.unmatch(requirePrincipal(request), id, eventOrigin(request)) };
  });
  app.post('/banking/transactions/:id/exclude', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(excludeBody, request.body);
    return {
      data: await banking.exclude(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  app.post('/banking/transactions/:id/restore', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await banking.restore(requirePrincipal(request), id, eventOrigin(request)) };
  });
  app.post('/banking/transactions/:id/categorize', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(categorizeBody, request.body);
    const result = await bankingPosting.categorize(
      requirePrincipal(request),
      id,
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });

  // Entries
  app.get('/banking/entries', async (request) => ({
    data: await bankingPosting.listEntries(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.get('/banking/entries/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await bankingPosting.getEntry(requirePrincipal(request), id) };
  });
  app.post('/banking/entries/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await bankingPosting.voidEntry(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });

  // Transfers
  app.get('/banking/transfers', async (request) => ({
    data: await bankingPosting.listTransfers(
      requirePrincipal(request),
      parseInput(listQuery, request.query),
    ),
  }));
  app.post('/banking/transfers', async (request, reply) => {
    const body = parseInput(transferBody, request.body);
    const result = await bankingPosting.createTransfer(
      requirePrincipal(request),
      body,
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/banking/transfers/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await bankingPosting.getTransfer(requirePrincipal(request), id) };
  });
  app.post('/banking/transfers/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await bankingPosting.voidTransfer(
        requirePrincipal(request),
        id,
        body,
        eventOrigin(request),
      ),
    };
  });

  // Reconciliation
  app.post('/banking/accounts/:id/reconciliation/preview', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(statementBody, request.body);
    return {
      data: await bankingPosting.previewReconciliation(requirePrincipal(request), id, body),
    };
  });
  app.post('/banking/accounts/:id/reconciliations', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(statementBody, request.body);
    const data = await bankingPosting.completeReconciliation(
      requirePrincipal(request),
      id,
      body,
      eventOrigin(request),
    );
    return reply.status(201).send({ data });
  });
  app.get('/banking/accounts/:id/reconciliations', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await bankingPosting.listReconciliations(requirePrincipal(request), id) };
  });
  app.get('/banking/reconciliations/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await bankingPosting.getReconciliation(requirePrincipal(request), id) };
  });
  app.post('/banking/reconciliations/:id/reopen', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(reasonBody, request.body);
    return {
      data: await bankingPosting.reopen(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });

  // Rules
  app.get('/banking/rules', async (request) => ({
    data: await banking.listRules(requirePrincipal(request)),
  }));
  app.post('/banking/rules', async (request, reply) => {
    const body = parseInput(ruleBody, request.body);
    const data = await banking.createRule(requirePrincipal(request), body, eventOrigin(request));
    return reply.status(201).send({ data });
  });
  app.put('/banking/rules/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(ruleUpdateBody, request.body);
    return {
      data: await banking.updateRule(requirePrincipal(request), id, body, eventOrigin(request)),
    };
  });
  for (const [path, status] of [
    ['archive', 'ARCHIVED'],
    ['restore', 'ACTIVE'],
  ] as const) {
    app.post(`/banking/rules/:id/${path}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await banking.setRuleStatus(
          requirePrincipal(request),
          id,
          status,
          body,
          eventOrigin(request),
        ),
      };
    });
  }
}
