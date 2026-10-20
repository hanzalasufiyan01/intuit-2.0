import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PayrollExtraService } from '../../application/payroll-extra-service.js';
import { leaveStatuses } from '../../modules/payroll/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Payroll leave and salary advances (FP-25). Strict schemas; the module must be enabled. Leave
 * requests for oneself need no payroll permission; everything else has its own key.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const version = z.number().int().min(1);
const idParams = z.object({ id: fields.id }).strict();

const typeCreate = z
  .object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(100),
    daysPerYear: amount,
    allowNegative: z.boolean().default(false),
  })
  .strict();
const typeUpdate = z
  .object({
    version,
    name: z.string().trim().min(1).max(100),
    daysPerYear: amount,
    allowNegative: z.boolean(),
    isActive: z.boolean(),
  })
  .strict();
const requestBody = z
  .object({
    employeeId: fields.id.optional(),
    leaveTypeId: fields.id,
    startDate: isoDate,
    endDate: isoDate,
    days: amount,
    reason: z.string().trim().max(500).optional(),
  })
  .strict();
const requestList = z
  .object({
    employeeId: fields.id.optional(),
    status: z.enum(leaveStatuses).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const balanceQuery = z
  .object({
    employeeId: fields.id.optional(),
    year: z.coerce.number().int().min(2000).max(2100).default(new Date().getUTCFullYear()),
  })
  .strict();
const versionBody = z.object({ version }).strict();
const approveBody = z.object({ version, note: z.string().trim().max(500).optional() }).strict();
const rejectBody = z.object({ version, note: z.string().trim().min(1).max(500) }).strict();

const grantBody = z
  .object({
    employeeId: fields.id,
    grantedDate: isoDate,
    principal: amount,
    installment: amount,
    bankAccountId: fields.id,
    note: z.string().trim().max(500).optional(),
  })
  .strict();
const advanceList = z
  .object({
    employeeId: fields.id.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
const cancelBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();

export function registerPayrollExtraRoutes(
  app: FastifyInstance,
  { payrollExtra }: { payrollExtra: PayrollExtraService },
) {
  app.get('/payroll/leave/types', async (request) => ({
    data: await payrollExtra.listLeaveTypes(requirePrincipal(request)),
  }));
  app.post('/payroll/leave/types', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await payrollExtra.createLeaveType(
        principal,
        parseInput(typeCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.put('/payroll/leave/types/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payrollExtra.updateLeaveType(
        principal,
        id,
        parseInput(typeUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/payroll/leave/requests', async (request) => ({
    data: await payrollExtra.listLeaveRequests(
      requirePrincipal(request),
      parseInput(requestList, request.query),
    ),
  }));
  app.post('/payroll/leave/requests', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await payrollExtra.requestLeave(
        principal,
        parseInput(requestBody, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.get('/payroll/leave/balances', async (request) => {
    const principal = requirePrincipal(request);
    const query = parseInput(balanceQuery, request.query);
    return {
      data: await payrollExtra.balancesFor(principal, query.employeeId ?? null, query.year),
    };
  });
  app.post('/payroll/leave/requests/:id/approve', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payrollExtra.approveLeave(
        principal,
        id,
        parseInput(approveBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/payroll/leave/requests/:id/reject', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payrollExtra.rejectLeave(
        principal,
        id,
        parseInput(rejectBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/payroll/leave/requests/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payrollExtra.cancelLeave(
        principal,
        id,
        parseInput(versionBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/payroll/advances', async (request) => ({
    data: await payrollExtra.listAdvances(
      requirePrincipal(request),
      parseInput(advanceList, request.query),
    ),
  }));
  app.post('/payroll/advances', async (request, reply) => {
    const principal = requirePrincipal(request);
    return reply.status(201).send({
      data: await payrollExtra.grantAdvance(
        principal,
        parseInput(grantBody, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.get('/payroll/advances/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await payrollExtra.getAdvance(principal, id) };
  });
  app.post('/payroll/advances/:id/cancel', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payrollExtra.cancelAdvance(
        principal,
        id,
        parseInput(cancelBody, request.body),
        eventOrigin(request),
      ),
    };
  });
}
