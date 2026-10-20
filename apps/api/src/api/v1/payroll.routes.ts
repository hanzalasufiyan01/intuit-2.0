import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { PayrollService } from '../../application/payroll-service.js';
import { idempotencyKey, markReplay } from '../http/idempotency.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Payroll (FP-25). Every schema is strict; money and rates are decimal strings. The module must be
 * enabled for the organization (MODULE_DISABLED otherwise). Viewing needs `payroll.view`; each
 * workflow step has its own permission, and approve, post, pay and void also need a recent
 * password confirmation.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const version = z.number().int().min(0);
const idParams = z.object({ id: fields.id }).strict();
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).strict();

const settingsBody = z
  .object({
    version,
    basicSalaryExpenseAccountId: fields.id.nullable(),
    netPayPayableAccountId: fields.id.nullable(),
    advancesAccountId: fields.id.nullable().optional(),
    proration: z.enum(['calendar_days', 'none']),
    requireSeparateApprover: z.boolean(),
  })
  .strict();

const componentBase = {
  name: z.string().trim().min(1).max(100),
  calculation: z.enum(['fixed', 'percent_of_basic', 'percent_of_gross']),
  defaultValue: amount,
  expenseAccountId: fields.id.nullable().optional(),
  liabilityAccountId: fields.id.nullable().optional(),
};
const componentCreate = z
  .object({
    code: z.string().trim().min(1).max(20),
    kind: z.enum(['earning', 'deduction', 'employer_contribution']),
    ...componentBase,
  })
  .strict();
const componentUpdate = z
  .object({ version: z.number().int().min(1), isActive: z.boolean(), ...componentBase })
  .strict();

const employeeBody = {
  displayName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).nullable().optional(),
  nationalId: z.string().trim().max(40).nullable().optional(),
  linkedMembershipId: fields.id.nullable().optional(),
  hireDate: isoDate,
  terminationDate: isoDate.nullable().optional(),
  basicSalary: amount,
  salaryEffectiveFrom: isoDate.optional(),
  salaryReason: z.string().trim().max(500).optional(),
  bankAccountRef: z.string().trim().max(80).nullable().optional(),
  components: z
    .array(z.object({ componentId: fields.id, value: amount.nullable().optional() }).strict())
    .max(50),
};
const employeeCreate = z.object(employeeBody).strict();
const employeeUpdate = z.object({ version: z.number().int().min(1), ...employeeBody }).strict();

const runCreate = z.object({ periodStart: isoDate, periodEnd: isoDate, payDate: isoDate }).strict();
const runVersion = z.object({ version: z.number().int().min(1) }).strict();
const payBody = z
  .object({ version: z.number().int().min(1), bankAccountId: fields.id, paymentDate: isoDate })
  .strict();
const voidBody = z
  .object({ version: z.number().int().min(1), reason: z.string().trim().min(1).max(500) })
  .strict();

const adjustmentBody = z
  .object({
    employeeId: fields.id,
    componentId: fields.id,
    amount: z
      .string()
      .regex(/^(0|[1-9]\d{0,14})(\.\d{1,4})?$/, 'Enter an amount with up to 4 decimals.'),
    note: z.string().trim().max(200).optional(),
  })
  .strict();
const adjustmentParams = z.object({ id: fields.id, adjustmentId: fields.id }).strict();
const registerQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
  })
  .strict();

export function registerPayrollRoutes(
  app: FastifyInstance,
  { payroll }: { payroll: PayrollService },
) {
  app.get('/payroll/settings', async (request) => ({
    data: await payroll.getSettings(requirePrincipal(request)),
  }));
  app.put('/payroll/settings', async (request) => ({
    data: await payroll.saveSettings(
      requirePrincipal(request),
      parseInput(settingsBody, request.body),
      eventOrigin(request),
    ),
  }));

  app.get('/payroll/components', async (request) => ({
    data: await payroll.listComponents(requirePrincipal(request)),
  }));
  app.post('/payroll/components', async (request, reply) =>
    reply.status(201).send({
      data: await payroll.createComponent(
        requirePrincipal(request),
        parseInput(componentCreate, request.body),
        eventOrigin(request),
      ),
    }),
  );
  app.put('/payroll/components/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.updateComponent(
        requirePrincipal(request),
        id,
        parseInput(componentUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/payroll/employees', async (request) => ({
    data: await payroll.listEmployees(requirePrincipal(request), eventOrigin(request)),
  }));
  app.post('/payroll/employees', async (request, reply) =>
    reply.status(201).send({
      data: await payroll.createEmployee(
        requirePrincipal(request),
        parseInput(employeeCreate, request.body),
        eventOrigin(request),
      ),
    }),
  );
  app.get('/payroll/employees/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await payroll.getEmployee(requirePrincipal(request), id, eventOrigin(request)) };
  });
  app.put('/payroll/employees/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.updateEmployee(
        requirePrincipal(request),
        id,
        parseInput(employeeUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/payroll/runs', async (request) => {
    const query = parseInput(listQuery, request.query);
    return { data: await payroll.listRuns(requirePrincipal(request), query.limit) };
  });
  app.post('/payroll/runs', async (request, reply) => {
    const result = await payroll.createRun(
      requirePrincipal(request),
      parseInput(runCreate, request.body),
      { idempotencyKey: idempotencyKey(request) },
      eventOrigin(request),
    );
    markReplay(reply, result.replayed);
    return reply.status(201).send({ data: result.value });
  });
  app.get('/payroll/runs/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await payroll.getRun(requirePrincipal(request), id, eventOrigin(request)) };
  });
  for (const [action, method] of [
    ['recalculate', 'recalculateRun'],
    ['approve', 'approveRun'],
    ['post', 'postRun'],
  ] as const) {
    app.post(`/payroll/runs/:id/${action}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(runVersion, request.body);
      return {
        data: await payroll[method](requirePrincipal(request), id, body, eventOrigin(request)),
      };
    });
  }
  app.post('/payroll/runs/:id/pay', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.payRun(
        requirePrincipal(request),
        id,
        parseInput(payBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/payroll/runs/:id/void', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.voidRun(
        requirePrincipal(request),
        id,
        parseInput(voidBody, request.body),
        eventOrigin(request),
      ),
    };
  });

  app.get('/payroll/employees/:id/salary-history', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.salaryHistory(requirePrincipal(request), id, eventOrigin(request)),
    };
  });
  app.post('/payroll/runs/:id/announce-payslips', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body ?? {});
    return { data: await payroll.notifyPayslips(principal, id, eventOrigin(request)) };
  });
  app.get('/payroll/runs/:id/adjustments', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await payroll.listAdjustments(requirePrincipal(request), id, eventOrigin(request)),
    };
  });
  app.post('/payroll/runs/:id/adjustments', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    const body = parseInput(adjustmentBody, request.body);
    return reply
      .status(201)
      .send({ data: await payroll.addAdjustment(principal, id, body, eventOrigin(request)) });
  });
  app.delete('/payroll/runs/:id/adjustments/:adjustmentId', async (request) => {
    const principal = requirePrincipal(request);
    const { id, adjustmentId } = parseInput(adjustmentParams, request.params);
    return {
      data: await payroll.removeAdjustment(principal, id, adjustmentId, eventOrigin(request)),
    };
  });
  app.get('/payroll/reports/register', async (request) => ({
    data: await payroll.registerReport(
      requirePrincipal(request),
      parseInput(registerQuery, request.query),
      eventOrigin(request),
    ),
  }));
  app.get('/payroll/payslips/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await payroll.getPayslip(requirePrincipal(request), id, eventOrigin(request)) };
  });
  const pdfReply = (reply: FastifyReply, file: { fileName: string; content: Buffer }) =>
    reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'no-store')
      .send(file.content);
  app.get('/payroll/payslips/:id/pdf', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const file = await payroll.payslipPdf(
      requirePrincipal(request),
      id,
      'any',
      eventOrigin(request),
    );
    return pdfReply(reply, file);
  });
  app.get('/payroll/my-payslips/:id/pdf', async (request, reply) => {
    const { id } = parseInput(idParams, request.params);
    const file = await payroll.payslipPdf(
      requirePrincipal(request),
      id,
      'own',
      eventOrigin(request),
    );
    return pdfReply(reply, file);
  });
  app.get('/payroll/my-payslips', async (request) => ({
    data: await payroll.myPayslips(requirePrincipal(request)),
  }));
}
