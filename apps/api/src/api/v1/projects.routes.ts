import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectService } from '../../application/project-service.js';
import {
  billingMethods,
  projectStatuses,
  timeEntryStatuses,
} from '../../modules/projects/index.js';
import { eventOrigin, requirePrincipal } from '../http/session.js';
import { fields, parseInput } from '../http/validation.js';

/**
 * Projects, time and billing (FP-26). Strict schemas; money, rates and hours are decimal strings.
 * The module must be enabled (MODULE_DISABLED otherwise). Time is logged by the person it belongs
 * to; managers approve; billing needs `projects.bill` and `invoices.create`.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.');
const amount = z
  .string()
  .regex(/^(0|[1-9]\d{0,21})(\.\d{1,6})?$/, 'Enter a number with up to 6 decimals.');
const idParams = z.object({ id: fields.id }).strict();
const version = z.number().int().min(1);
const versionBody = z.object({ version }).strict();

const projectBody = {
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(2000).optional(),
  customerId: fields.id.nullable().optional(),
  status: z.enum(projectStatuses).optional(),
  billingMethod: z.enum(billingMethods),
  startDate: isoDate.nullable().optional(),
  endDate: isoDate.nullable().optional(),
  budgetAmount: amount.nullable().optional(),
  budgetHours: amount.nullable().optional(),
  defaultBillRate: amount,
  members: z
    .array(
      z
        .object({ userId: fields.id, billRate: amount.nullable().optional(), costRate: amount })
        .strict(),
    )
    .max(200),
};
const projectCreate = z.object(projectBody).strict();
const projectUpdate = z.object({ version, ...projectBody }).strict();
const projectList = z.object({ status: z.enum(projectStatuses).optional() }).strict();

const timeBody = {
  projectId: fields.id,
  taskId: fields.id.nullable().optional(),
  workDate: isoDate,
  hours: amount,
  description: z.string().trim().min(1).max(500),
  billable: z.boolean().optional(),
};
const timeCreate = z.object(timeBody).strict();
const timeUpdate = z.object({ version, ...timeBody }).strict();
const timeList = z
  .object({
    projectId: fields.id.optional(),
    userId: fields.id.optional(),
    status: z.enum(timeEntryStatuses).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
const rejectBody = z.object({ version, reason: z.string().trim().min(1).max(500) }).strict();
const billBody = z
  .object({ invoiceDate: isoDate, upTo: isoDate, itemId: fields.id.nullable().optional() })
  .strict();
const taskCreate = z
  .object({ name: z.string().trim().min(1).max(150), budgetHours: amount.nullable().optional() })
  .strict();
const taskUpdate = z
  .object({
    version,
    name: z.string().trim().min(1).max(150),
    status: z.enum(['OPEN', 'DONE']),
    budgetHours: amount.nullable().optional(),
  })
  .strict();
const summaryQuery = z.object({ projectId: fields.id.optional() }).strict();

export function registerProjectRoutes(
  app: FastifyInstance,
  { projects }: { projects: ProjectService },
) {
  app.get('/projects', async (request) => ({
    data: await projects.listProjects(
      requirePrincipal(request),
      parseInput(projectList, request.query),
    ),
  }));
  app.post('/projects', async (request, reply) =>
    reply.status(201).send({
      data: await projects.createProject(
        requirePrincipal(request),
        parseInput(projectCreate, request.body),
        eventOrigin(request),
      ),
    }),
  );
  app.get('/projects/summary', async (request) => ({
    data: await projects.summary(
      requirePrincipal(request),
      parseInput(summaryQuery, request.query),
    ),
  }));
  app.get('/projects/:id/tasks', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return { data: await projects.listTasks(principal, id) };
  });
  app.post('/projects/:id/tasks', async (request, reply) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return reply.status(201).send({
      data: await projects.createTask(
        principal,
        id,
        parseInput(taskCreate, request.body),
        eventOrigin(request),
      ),
    });
  });
  app.put('/projects/tasks/:id', async (request) => {
    const principal = requirePrincipal(request);
    const { id } = parseInput(idParams, request.params);
    return {
      data: await projects.updateTask(
        principal,
        id,
        parseInput(taskUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.get('/projects/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await projects.getProject(requirePrincipal(request), id) };
  });
  app.put('/projects/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await projects.updateProject(
        requirePrincipal(request),
        id,
        parseInput(projectUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/projects/:id/bill', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await projects.billProject(
        requirePrincipal(request),
        id,
        parseInput(billBody, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.post('/projects/:id/release-time', async (request) => {
    const { id } = parseInput(idParams, request.params);
    parseInput(z.object({}).strict(), request.body);
    return {
      data: await projects.releaseTime(requirePrincipal(request), id, eventOrigin(request)),
    };
  });

  app.get('/projects/time/entries', async (request) => ({
    data: await projects.listTime(requirePrincipal(request), parseInput(timeList, request.query)),
  }));
  app.post('/projects/time/entries', async (request, reply) =>
    reply.status(201).send({
      data: await projects.logTime(
        requirePrincipal(request),
        parseInput(timeCreate, request.body),
        eventOrigin(request),
      ),
    }),
  );
  app.put('/projects/time/entries/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await projects.updateTime(
        requirePrincipal(request),
        id,
        parseInput(timeUpdate, request.body),
        eventOrigin(request),
      ),
    };
  });
  app.delete('/projects/time/entries/:id', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return { data: await projects.deleteTime(requirePrincipal(request), id, eventOrigin(request)) };
  });
  for (const [action, method] of [
    ['submit', 'submitTime'],
    ['approve', 'approveTime'],
  ] as const) {
    app.post(`/projects/time/entries/:id/${action}`, async (request) => {
      const { id } = parseInput(idParams, request.params);
      const body = parseInput(versionBody, request.body);
      return {
        data: await projects[method](requirePrincipal(request), id, body, eventOrigin(request)),
      };
    });
  }
  app.post('/projects/time/entries/:id/reject', async (request) => {
    const { id } = parseInput(idParams, request.params);
    return {
      data: await projects.rejectTime(
        requirePrincipal(request),
        id,
        parseInput(rejectBody, request.body),
        eventOrigin(request),
      ),
    };
  });
}
