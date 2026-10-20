import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  createDimensionType,
  createDimensionValue,
  isValidIsoDate,
  listDimensionTypes,
  updateDimensionValue,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getUserProfiles } from '../modules/identity/index.js';
import { findMembership } from '../modules/organizations/index.js';
import {
  billableApprovedEntries,
  deleteTimeEntry,
  getMember,
  getProject,
  getTask,
  getTimeEntry,
  hoursLoggedOn,
  insertProject,
  insertTask,
  insertTimeEntry,
  ledgerResult,
  listMembers,
  listProjects,
  listTasks,
  listTimeEntries,
  ProjectPermissions,
  replaceMembers,
  takeNextProjectNumber,
  taskHours,
  taskNameExists,
  timeTotals,
  updateProject,
  updateTask,
  updateTimeEntry,
  type BillingMethod,
  type Project,
  type ProjectStatus,
  type TimeEntry,
  type TimeEntryStatus,
} from '../modules/projects/index.js';
import { getInvoice } from '../modules/sales/index.js';
import { SalesPermissions } from '../modules/sales/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { InvoiceService } from './invoice-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Projects, time tracking and billing of approved time (FP-26, docs/design/projects-job-costing.md;
 * migration 0067). A project owns one value of the PROJECT dimension, so the ledger's dimension
 * tags make every invoice, bill and expense line a project's revenue or cost without a second
 * source of truth. Time: log (own, on projects you belong to) -> submit -> approve/reject -> bill
 * once into a draft sales invoice. Rates are frozen on each entry when it is saved.
 */

const MODULE = 'projects' as const;
const DIMENSION_TYPE_CODE = 'PROJECT';
const ACCEPTS_TIME: readonly ProjectStatus[] = ['ACTIVE'];

const versionConflict = (noun: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${noun} changed; reload it and try again.`);
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface ProjectInput {
  name: string;
  description?: string | undefined;
  customerId?: string | null | undefined;
  status?: ProjectStatus | undefined;
  billingMethod: BillingMethod;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  budgetAmount?: string | null | undefined;
  budgetHours?: string | null | undefined;
  defaultBillRate: string;
  members: { userId: string; billRate?: string | null | undefined; costRate: string }[];
}

export interface TimeInput {
  projectId: string;
  taskId?: string | null | undefined;
  workDate: string;
  hours: string;
  description: string;
  billable?: boolean | undefined;
}

export class ProjectService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly invoices: InvoiceService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  private run<T>(
    principal: Principal,
    permission: string | undefined,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
    options: { sensitive?: boolean; readOnly?: boolean } = {},
  ) {
    return withOrganization(
      this.deps,
      principal,
      {
        ...(permission ? { permission } : {}),
        module: MODULE,
        ...(options.sensitive ? { sensitive: true } : {}),
        ...(options.readOnly ? { readOnlySnapshot: true } : {}),
      },
      work,
    );
  }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  private async projectDimensionType(tx: Transaction, ctx: AuthorizationContext) {
    const types = await listDimensionTypes(tx, ctx.organizationId);
    const existing = types.find((t) => t.code === DIMENSION_TYPE_CODE);
    if (existing) return existing;
    if (types.some((t) => t.name.toLowerCase() === 'project')) {
      throw new ValidationError([
        {
          path: 'name',
          message:
            'A dimension type named "Project" already exists with a different code; rename it before using projects.',
        },
      ]);
    }
    return createDimensionType(tx, {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      code: DIMENSION_TYPE_CODE,
      name: 'Project',
      description: 'Created by the Projects module; one value per project.',
      isRequired: false,
      scopeAccountTypes: [],
      scopeAccountSubtypes: [],
    });
  }

  private async memberViews(tx: Transaction, organizationId: string, projectId: string) {
    const members = await listMembers(tx, organizationId, projectId);
    const profiles = await getUserProfiles(
      tx,
      members.map((m) => m.userId),
    );
    return members.map((m) => ({
      userId: m.userId,
      displayName: profiles.get(m.userId)?.displayName ?? null,
      billRate: m.billRate === null ? null : decimal(m.billRate).toFixed(),
      costRate: decimal(m.costRate).toFixed(),
    }));
  }

  private view(p: Project) {
    return {
      id: p.id,
      number: p.number,
      name: p.name,
      description: p.description,
      customerId: p.customerId,
      status: p.status,
      billingMethod: p.billingMethod,
      startDate: p.startDate,
      endDate: p.endDate,
      budgetAmount: p.budgetAmount === null ? null : decimal(p.budgetAmount).toFixed(),
      budgetHours: p.budgetHours === null ? null : decimal(p.budgetHours).toFixed(),
      defaultBillRate: decimal(p.defaultBillRate).toFixed(),
      dimensionValueId: p.dimensionValueId,
      version: p.version,
    };
  }

  private async validateProject(tx: Transaction, ctx: AuthorizationContext, input: ProjectInput) {
    const issues: ValidationIssue[] = [];
    if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
    for (const key of ['startDate', 'endDate'] as const) {
      const value = input[key];
      if (value && !isValidIsoDate(value)) {
        issues.push({ path: key, message: 'Enter a valid date (YYYY-MM-DD).' });
      }
    }
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      issues.push({ path: 'endDate', message: 'The end date is before the start date.' });
    }
    if (input.customerId) {
      if (!(await getCustomer(tx, ctx.organizationId, input.customerId))) {
        issues.push({ path: 'customerId', message: 'Choose a customer of this organization.' });
      }
    } else if (input.billingMethod !== 'non_billable') {
      // Billable work needs someone to bill; checked again when billing.
    }
    const seen = new Set<string>();
    for (const [i, member] of input.members.entries()) {
      if (seen.has(member.userId)) {
        issues.push({ path: `members.${i}.userId`, message: 'List each person once.' });
      }
      seen.add(member.userId);
      const membership = await findMembership(tx, ctx.organizationId, member.userId);
      if (!membership || membership.status !== 'active') {
        issues.push({ path: `members.${i}.userId`, message: 'Choose an active member.' });
      }
    }
    if (issues.length) throw new ValidationError(issues);
  }

  listProjects(principal: Principal, filter: { status?: ProjectStatus | undefined }) {
    return this.run(
      principal,
      ProjectPermissions.View,
      async (tx, ctx) =>
        (await listProjects(tx, ctx.organizationId, filter)).map((p) => this.view(p)),
      { readOnly: true },
    );
  }

  getProject(principal: Principal, id: string) {
    return this.run(
      principal,
      ProjectPermissions.View,
      async (tx, ctx) => {
        const project = await getProject(tx, ctx.organizationId, id);
        if (!project) throw new NotFoundError('Project not found.');
        return {
          ...this.view(project),
          members: await this.memberViews(tx, ctx.organizationId, id),
        };
      },
      { readOnly: true },
    );
  }

  createProject(principal: Principal, input: ProjectInput, origin: EventOrigin) {
    return this.run(principal, ProjectPermissions.Manage, async (tx, ctx) => {
      await requireAccountingSettings(tx, ctx.organizationId);
      await this.validateProject(tx, ctx, input);
      const type = await this.projectDimensionType(tx, ctx);
      const number = await takeNextProjectNumber(tx, ctx.organizationId);
      const value = await createDimensionValue(tx, {
        organizationId: ctx.organizationId,
        dimensionTypeId: type.id,
        code: number,
        name: `${number} ${input.name.trim()}`.slice(0, 100),
        userId: ctx.userId,
      });
      const now = this.now;
      const project = await insertProject(tx, {
        organizationId: ctx.organizationId,
        number,
        name: input.name.trim(),
        description: (input.description ?? '').trim(),
        customerId: input.customerId ?? null,
        status: input.status ?? 'ACTIVE',
        billingMethod: input.billingMethod,
        startDate: input.startDate || null,
        endDate: input.endDate || null,
        budgetAmount:
          input.budgetAmount === null || input.budgetAmount === undefined
            ? null
            : decimal(input.budgetAmount).toFixed(4),
        budgetHours:
          input.budgetHours === null || input.budgetHours === undefined
            ? null
            : decimal(input.budgetHours).toFixed(2),
        defaultBillRate: decimal(input.defaultBillRate).toFixed(4),
        dimensionValueId: value.id,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await replaceMembers(
        tx,
        ctx.organizationId,
        project.id,
        input.members.map((m) => ({
          userId: m.userId,
          billRate:
            m.billRate === null || m.billRate === undefined ? null : decimal(m.billRate).toFixed(4),
          costRate: decimal(m.costRate).toFixed(4),
        })),
      );
      await this.audit(tx, ctx, 'project.created', 'project', project.id, origin, {
        number,
        billingMethod: project.billingMethod,
        members: input.members.length,
      });
      return {
        ...this.view(project),
        members: await this.memberViews(tx, ctx.organizationId, project.id),
      };
    });
  }

  updateProject(
    principal: Principal,
    id: string,
    input: ProjectInput & { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.Manage, async (tx, ctx) => {
      const existing = await getProject(tx, ctx.organizationId, id, { forUpdate: true });
      if (!existing) throw new NotFoundError('Project not found.');
      if (existing.version !== input.version) throw versionConflict('project');
      await this.validateProject(tx, ctx, input);
      const status = input.status ?? existing.status;
      if (['COMPLETED', 'CANCELLED'].includes(existing.status) && status !== existing.status) {
        throw invalidState(`A ${existing.status.toLowerCase()} project cannot be reopened.`);
      }
      const updated = await updateProject(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          name: input.name.trim(),
          description: (input.description ?? '').trim(),
          customerId: input.customerId ?? null,
          status,
          billingMethod: input.billingMethod,
          startDate: input.startDate || null,
          endDate: input.endDate || null,
          budgetAmount:
            input.budgetAmount === null || input.budgetAmount === undefined
              ? null
              : decimal(input.budgetAmount).toFixed(4),
          budgetHours:
            input.budgetHours === null || input.budgetHours === undefined
              ? null
              : decimal(input.budgetHours).toFixed(2),
          defaultBillRate: decimal(input.defaultBillRate).toFixed(4),
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('project');
      await replaceMembers(
        tx,
        ctx.organizationId,
        id,
        input.members.map((m) => ({
          userId: m.userId,
          billRate:
            m.billRate === null || m.billRate === undefined ? null : decimal(m.billRate).toFixed(4),
          costRate: decimal(m.costRate).toFixed(4),
        })),
      );
      await updateDimensionValue(tx, {
        organizationId: ctx.organizationId,
        id: existing.dimensionValueId,
        changes: { name: `${existing.number} ${input.name.trim()}`.slice(0, 100) },
        userId: ctx.userId,
      });
      await this.audit(tx, ctx, 'project.updated', 'project', id, origin, {
        number: updated.number,
        status: updated.status,
        statusChanged: updated.status !== existing.status,
      });
      return { ...this.view(updated), members: await this.memberViews(tx, ctx.organizationId, id) };
    });
  }

  // ---------------------------------------------------------------------------
  // Tasks (migration 0072)
  // ---------------------------------------------------------------------------

  private taskView(t: Awaited<ReturnType<typeof getTask>> & object, hours: string) {
    return {
      id: t.id,
      projectId: t.projectId,
      name: t.name,
      status: t.status,
      budgetHours: t.budgetHours === null ? null : decimal(t.budgetHours).toFixed(2),
      hours: decimal(hours).toFixed(2),
      overBudget: t.budgetHours !== null && decimal(hours).gt(t.budgetHours),
      version: t.version,
    };
  }

  listTasks(principal: Principal, projectId: string) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) => {
        // People who log time need the list to choose a task; everyone else needs projects.view.
        if (
          !hasPermission(ctx, ProjectPermissions.View) &&
          !hasPermission(ctx, ProjectPermissions.TimeLog)
        ) {
          throw new PermissionDeniedError();
        }
        if (!(await getProject(tx, ctx.organizationId, projectId))) {
          throw new NotFoundError('Project not found.');
        }
        const [tasks, hours] = await Promise.all([
          listTasks(tx, ctx.organizationId, projectId),
          taskHours(tx, ctx.organizationId, projectId),
        ]);
        return tasks.map((t) => this.taskView(t, hours.get(t.id) ?? '0'));
      },
      { readOnly: true },
    );
  }

  createTask(
    principal: Principal,
    projectId: string,
    input: { name: string; budgetHours?: string | null | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.Manage, async (tx, ctx) => {
      const project = await getProject(tx, ctx.organizationId, projectId);
      if (!project) throw new NotFoundError('Project not found.');
      const issues: ValidationIssue[] = [];
      if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
      else if (await taskNameExists(tx, ctx.organizationId, projectId, input.name.trim())) {
        issues.push({ path: 'name', message: 'This project already has a task with that name.' });
      }
      if (
        input.budgetHours !== null &&
        input.budgetHours !== undefined &&
        decimal(input.budgetHours).lt(0)
      ) {
        issues.push({ path: 'budgetHours', message: 'Enter zero or more.' });
      }
      if (issues.length) throw new ValidationError(issues);
      const now = this.now;
      const task = await insertTask(tx, {
        organizationId: ctx.organizationId,
        projectId,
        name: input.name.trim(),
        budgetHours:
          input.budgetHours === null || input.budgetHours === undefined
            ? null
            : decimal(input.budgetHours).toFixed(2),
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(tx, ctx, 'project.task_created', 'project_task', task.id, origin, {
        projectId,
        budgetHours: task.budgetHours,
      });
      return this.taskView(task, '0');
    });
  }

  updateTask(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name: string;
      status: 'OPEN' | 'DONE';
      budgetHours?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.Manage, async (tx, ctx) => {
      const existing = await getTask(tx, ctx.organizationId, id);
      if (!existing) throw new NotFoundError('Task not found.');
      const issues: ValidationIssue[] = [];
      if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
      else if (
        await taskNameExists(tx, ctx.organizationId, existing.projectId, input.name.trim(), id)
      ) {
        issues.push({ path: 'name', message: 'This project already has a task with that name.' });
      }
      if (
        input.budgetHours !== null &&
        input.budgetHours !== undefined &&
        decimal(input.budgetHours).lt(0)
      ) {
        issues.push({ path: 'budgetHours', message: 'Enter zero or more.' });
      }
      if (issues.length) throw new ValidationError(issues);
      const updated = await updateTask(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          name: input.name.trim(),
          status: input.status,
          budgetHours:
            input.budgetHours === null || input.budgetHours === undefined
              ? null
              : decimal(input.budgetHours).toFixed(2),
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('task');
      await this.audit(tx, ctx, 'project.task_updated', 'project_task', id, origin, {
        status: updated.status,
      });
      const hours = await taskHours(tx, ctx.organizationId, existing.projectId);
      return this.taskView(updated, hours.get(id) ?? '0');
    });
  }

  // ---------------------------------------------------------------------------
  // Time
  // ---------------------------------------------------------------------------

  private async timeViews(tx: Transaction, organizationId: string, rows: readonly TimeEntry[]) {
    const profiles = await getUserProfiles(tx, [...new Set(rows.map((r) => r.userId))]);
    return rows.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      taskId: e.taskId,
      userId: e.userId,
      displayName: profiles.get(e.userId)?.displayName ?? null,
      workDate: e.workDate,
      hours: decimal(e.hours).toFixed(),
      description: e.description,
      billable: e.billable,
      billRate: decimal(e.billRate).toFixed(),
      costRate: decimal(e.costRate).toFixed(),
      status: e.status,
      rejectReason: e.rejectReason,
      invoiceId: e.invoiceId,
      version: e.version,
    }));
  }

  /** Time the caller may see: everything with projects.view, otherwise only their own. */
  listTime(
    principal: Principal,
    filter: {
      projectId?: string | undefined;
      userId?: string | undefined;
      status?: TimeEntryStatus | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
    },
  ) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) => {
        const all = hasPermission(ctx, ProjectPermissions.View);
        if (!all && !hasPermission(ctx, ProjectPermissions.TimeLog))
          throw new PermissionDeniedError();
        const rows = await listTimeEntries(tx, ctx.organizationId, {
          ...filter,
          ...(all ? {} : { userId: ctx.userId }),
        });
        return this.timeViews(tx, ctx.organizationId, rows);
      },
      { readOnly: true },
    );
  }

  private async validateTime(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: TimeInput,
    selfEntryId?: string,
  ) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.workDate)) {
      issues.push({ path: 'workDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    } else if (input.workDate > this.now.toISOString().slice(0, 10)) {
      issues.push({ path: 'workDate', message: 'Time cannot be logged for a future date.' });
    }
    const hours = decimal(input.hours);
    if (!hours.gt(0) || hours.gt(24) || hours.decimalPlaces() > 2) {
      issues.push({
        path: 'hours',
        message: 'Enter hours above 0 and up to 24, with up to 2 decimals.',
      });
    }
    if (!input.description.trim())
      issues.push({ path: 'description', message: 'Say what was done.' });
    const project = await getProject(tx, ctx.organizationId, input.projectId);
    const member = project
      ? await getMember(tx, ctx.organizationId, project.id, ctx.userId)
      : undefined;
    if (!project) {
      issues.push({ path: 'projectId', message: 'Choose a project of this organization.' });
    } else if (!member) {
      issues.push({ path: 'projectId', message: 'You are not a member of this project.' });
    } else if (!ACCEPTS_TIME.includes(project.status)) {
      issues.push({
        path: 'projectId',
        message: `The project is ${project.status.toLowerCase().replace('_', ' ')}.`,
      });
    }
    if (!issues.length && input.taskId) {
      const task = await getTask(tx, ctx.organizationId, input.taskId);
      if (!task || task.projectId !== input.projectId) {
        issues.push({ path: 'taskId', message: 'Choose a task of this project.' });
      } else if (task.status !== 'OPEN') {
        issues.push({ path: 'taskId', message: 'The task is done.' });
      }
    }
    if (!issues.length) {
      const logged = decimal(
        await hoursLoggedOn(tx, ctx.organizationId, ctx.userId, input.workDate, selfEntryId),
      );
      if (logged.plus(hours).gt(24)) {
        issues.push({
          path: 'hours',
          message: `You have already logged ${logged.toFixed()} hours on this day.`,
        });
      }
    }
    if (issues.length) throw new ValidationError(issues);
    return { project: project!, member: member! };
  }

  logTime(principal: Principal, input: TimeInput, origin: EventOrigin) {
    return this.run(principal, ProjectPermissions.TimeLog, async (tx, ctx) => {
      const { project, member } = await this.validateTime(tx, ctx, input);
      const now = this.now;
      const entry = await insertTimeEntry(tx, {
        organizationId: ctx.organizationId,
        projectId: project.id,
        taskId: input.taskId ?? null,
        userId: ctx.userId,
        workDate: input.workDate,
        hours: decimal(input.hours).toFixed(2),
        description: input.description.trim(),
        billable: project.billingMethod === 'non_billable' ? false : (input.billable ?? true),
        billRate: member.billRate ?? project.defaultBillRate,
        costRate: member.costRate,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(tx, ctx, 'project.time_logged', 'project_time_entry', entry.id, origin, {
        projectId: project.id,
        hours: entry.hours,
        workDate: entry.workDate,
      });
      return (await this.timeViews(tx, ctx.organizationId, [entry]))[0]!;
    });
  }

  private async ownEntry(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const entry = await getTimeEntry(tx, ctx.organizationId, id, { forUpdate: true });
    // Someone else's entry answers like a missing one.
    if (!entry || entry.userId !== ctx.userId) throw new NotFoundError('Time entry not found.');
    return entry;
  }

  updateTime(
    principal: Principal,
    id: string,
    input: TimeInput & { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.TimeLog, async (tx, ctx) => {
      const entry = await this.ownEntry(tx, ctx, id);
      if (entry.version !== input.version) throw versionConflict('time entry');
      if (!['DRAFT', 'REJECTED'].includes(entry.status)) {
        throw invalidState('Only a draft or rejected entry can be edited.');
      }
      const { project, member } = await this.validateTime(tx, ctx, input, id);
      const updated = await updateTimeEntry(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          projectId: project.id,
          taskId: input.taskId ?? null,
          workDate: input.workDate,
          hours: decimal(input.hours).toFixed(2),
          description: input.description.trim(),
          billable:
            project.billingMethod === 'non_billable' ? false : (input.billable ?? entry.billable),
          billRate: member.billRate ?? project.defaultBillRate,
          costRate: member.costRate,
          status: 'DRAFT',
          rejectReason: null,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('time entry');
      await this.audit(tx, ctx, 'project.time_updated', 'project_time_entry', id, origin, {
        hours: updated.hours,
      });
      return (await this.timeViews(tx, ctx.organizationId, [updated]))[0]!;
    });
  }

  deleteTime(principal: Principal, id: string, origin: EventOrigin) {
    return this.run(principal, ProjectPermissions.TimeLog, async (tx, ctx) => {
      const entry = await this.ownEntry(tx, ctx, id);
      if (!['DRAFT', 'REJECTED'].includes(entry.status)) {
        throw invalidState('Only a draft or rejected entry can be deleted.');
      }
      await deleteTimeEntry(tx, ctx.organizationId, id);
      await this.audit(tx, ctx, 'project.time_deleted', 'project_time_entry', id, origin, {
        hours: entry.hours,
      });
      return { id, deleted: true as const };
    });
  }

  submitTime(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.run(principal, ProjectPermissions.TimeLog, async (tx, ctx) => {
      const entry = await this.ownEntry(tx, ctx, id);
      if (entry.version !== input.version) throw versionConflict('time entry');
      if (!['DRAFT', 'REJECTED'].includes(entry.status)) {
        throw invalidState('Only a draft or rejected entry can be submitted.');
      }
      const project = await getProject(tx, ctx.organizationId, entry.projectId);
      if (!project || !ACCEPTS_TIME.includes(project.status)) {
        throw invalidState('The project no longer accepts time.');
      }
      const updated = await updateTimeEntry(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          status: 'SUBMITTED',
          submittedAt: this.now,
          rejectReason: null,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('time entry');
      await this.audit(tx, ctx, 'project.time_submitted', 'project_time_entry', id, origin);
      return (await this.timeViews(tx, ctx.organizationId, [updated]))[0]!;
    });
  }

  private decide(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    decision: 'APPROVED' | 'REJECTED',
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.TimeApprove, async (tx, ctx) => {
      const entry = await getTimeEntry(tx, ctx.organizationId, id, { forUpdate: true });
      if (!entry) throw new NotFoundError('Time entry not found.');
      if (entry.version !== input.version) throw versionConflict('time entry');
      if (entry.status !== 'SUBMITTED') throw invalidState('Only submitted time can be decided.');
      const reason = input.reason?.trim();
      if (decision === 'REJECTED' && !reason) {
        throw new ValidationError([{ path: 'reason', message: 'Say why the time is rejected.' }]);
      }
      const updated = await updateTimeEntry(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          status: decision,
          decidedByUserId: ctx.userId,
          decidedAt: this.now,
          rejectReason: decision === 'REJECTED' ? reason! : null,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('time entry');
      await this.audit(
        tx,
        ctx,
        decision === 'APPROVED' ? 'project.time_approved' : 'project.time_rejected',
        'project_time_entry',
        id,
        origin,
        { hours: updated.hours, ...(reason ? { reason } : {}) },
      );
      return (await this.timeViews(tx, ctx.organizationId, [updated]))[0]!;
    });
  }

  approveTime(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.decide(principal, id, input, 'APPROVED', origin);
  }

  rejectTime(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return this.decide(principal, id, input, 'REJECTED', origin);
  }

  // ---------------------------------------------------------------------------
  // Billing
  // ---------------------------------------------------------------------------

  /**
   * Bills every approved, billable, unbilled entry of a project up to a date into ONE draft sales
   * invoice (one line per person and rate, tagged with the project). The entries become BILLED in
   * the same transaction, so the same hours can never be billed twice. Needs `projects.bill` and
   * `invoices.create`.
   */
  billProject(
    principal: Principal,
    projectId: string,
    input: { invoiceDate: string; upTo: string; itemId?: string | null | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, ProjectPermissions.Bill, async (tx, ctx) => {
      if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
      const issues: ValidationIssue[] = [];
      for (const key of ['invoiceDate', 'upTo'] as const) {
        if (!isValidIsoDate(input[key])) {
          issues.push({ path: key, message: 'Enter a valid date (YYYY-MM-DD).' });
        }
      }
      if (issues.length) throw new ValidationError(issues);
      const project = await getProject(tx, ctx.organizationId, projectId, { forUpdate: true });
      if (!project) throw new NotFoundError('Project not found.');
      if (project.billingMethod !== 'time_and_materials') {
        throw invalidState('Only time-and-materials projects bill their time.');
      }
      if (!project.customerId) {
        throw new ValidationError([
          { path: 'customerId', message: 'Choose the customer to bill on the project first.' },
        ]);
      }
      const entries = await billableApprovedEntries(tx, ctx.organizationId, projectId, input.upTo);
      if (!entries.length) {
        throw new ValidationError([
          { path: 'upTo', message: 'There is no approved billable time to bill.' },
        ]);
      }
      const accounting = await requireAccountingSettings(tx, ctx.organizationId);
      const places = minorUnits(accounting.baseCurrency);
      const profiles = await getUserProfiles(tx, [...new Set(entries.map((e) => e.userId))]);
      const groups = new Map<
        string,
        {
          userId: string;
          rate: string;
          hours: ReturnType<typeof decimal>;
          from: string;
          to: string;
        }
      >();
      for (const e of entries) {
        const key = `${e.userId}|${decimal(e.billRate).toFixed()}`;
        const g = groups.get(key) ?? {
          userId: e.userId,
          rate: decimal(e.billRate).toFixed(),
          hours: decimal(0),
          from: e.workDate,
          to: e.workDate,
        };
        g.hours = g.hours.plus(e.hours);
        if (e.workDate < g.from) g.from = e.workDate;
        if (e.workDate > g.to) g.to = e.workDate;
        groups.set(key, g);
      }
      const invoice = await this.invoices.createDraftInTransaction(
        tx,
        ctx,
        {
          customerId: project.customerId,
          invoiceDate: input.invoiceDate,
          reference: project.number,
          memo: `${project.number} ${project.name}: time up to ${input.upTo}`.slice(0, 500),
          lines: [...groups.values()].map((g) => ({
            ...(input.itemId ? { itemId: input.itemId } : {}),
            description:
              `${project.number} ${project.name} — ${profiles.get(g.userId)?.displayName ?? 'Team member'} (${g.from} to ${g.to})`.slice(
                0,
                500,
              ),
            quantity: g.hours.toFixed(2),
            unitPrice: decimal(g.rate).toFixed(places),
            dimensionValueIds: [project.dimensionValueId],
          })),
        },
        origin,
      );
      const now = this.now;
      for (const e of entries) {
        const billed = await updateTimeEntry(tx, {
          organizationId: ctx.organizationId,
          id: e.id,
          version: e.version,
          set: { status: 'BILLED', invoiceId: invoice.id, billedAt: now, updatedAt: now },
        });
        if (!billed) throw versionConflict('time entry');
      }
      const hours = entries.reduce((s, e) => s.plus(e.hours), decimal(0));
      await this.audit(tx, ctx, 'project.time_billed', 'project', projectId, origin, {
        invoiceId: invoice.id,
        entries: entries.length,
        hours: hours.toFixed(2),
      });
      return {
        invoiceId: invoice.id,
        entries: entries.length,
        hours: hours.toFixed(2),
        amount: decimal(invoice.total).toFixed(places),
      };
    });
  }

  /**
   * Releases billed time whose invoice was deleted or voided, so it can be billed again. Time
   * whose invoice still exists (draft or issued) is never released.
   */
  releaseTime(principal: Principal, projectId: string, origin: EventOrigin) {
    return this.run(principal, ProjectPermissions.Bill, async (tx, ctx) => {
      const project = await getProject(tx, ctx.organizationId, projectId);
      if (!project) throw new NotFoundError('Project not found.');
      const billed = await listTimeEntries(tx, ctx.organizationId, {
        projectId,
        status: 'BILLED',
        limit: 5000,
      });
      let released = 0;
      for (const e of billed) {
        const invoice = e.invoiceId
          ? await getInvoice(tx, ctx.organizationId, e.invoiceId)
          : undefined;
        if (invoice && invoice.status !== 'VOID') continue;
        const locked = await getTimeEntry(tx, ctx.organizationId, e.id, { forUpdate: true });
        if (!locked || locked.status !== 'BILLED') continue;
        const updated = await updateTimeEntry(tx, {
          organizationId: ctx.organizationId,
          id: e.id,
          version: locked.version,
          set: { status: 'APPROVED', invoiceId: null, billedAt: null, updatedAt: this.now },
        });
        if (updated) released += 1;
      }
      if (released) {
        await this.audit(tx, ctx, 'project.time_released', 'project', projectId, origin, {
          released,
        });
      }
      return { released };
    });
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  /**
   * One row per project: hours by state, billable value, cost and, for people who may view
   * accounting reports, the revenue and cost on the books under the project's dimension value.
   */
  summary(principal: Principal, filter: { projectId?: string | undefined }) {
    return this.run(
      principal,
      ProjectPermissions.View,
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const projects = filter.projectId
          ? [await getProject(tx, ctx.organizationId, filter.projectId)].filter(
              (p): p is Project => p !== undefined,
            )
          : await listProjects(tx, ctx.organizationId, {});
        if (filter.projectId && !projects.length) throw new NotFoundError('Project not found.');
        const totals = await timeTotals(tx, ctx.organizationId, filter.projectId);
        const canLedger = hasPermission(ctx, 'accounting.reports.view');
        const ledger = canLedger
          ? new Map(
              (
                await ledgerResult(
                  tx,
                  ctx.organizationId,
                  projects.map((p) => p.dimensionValueId),
                )
              ).map((r) => [r.dimension_value_id, r]),
            )
          : null;
        return {
          baseCurrency: accounting.baseCurrency,
          projects: projects.map((p) => {
            const mine = totals.filter((t) => t.project_id === p.id);
            const sum = (
              pick: (t: (typeof mine)[number]) => string,
              where: (t: (typeof mine)[number]) => boolean,
            ) => mine.filter(where).reduce((s, t) => s.plus(pick(t)), decimal(0));
            const counted = (t: (typeof mine)[number]) =>
              t.status === 'APPROVED' || t.status === 'BILLED';
            const hoursOf = (status: TimeEntryStatus) =>
              sum(
                (t) => t.hours,
                (t) => t.status === status,
              );
            const ledgerRow = ledger?.get(p.dimensionValueId);
            const revenue = ledgerRow ? decimal(ledgerRow.revenue) : null;
            const cost = ledgerRow ? decimal(ledgerRow.cost) : ledger ? decimal(0) : null;
            return {
              id: p.id,
              number: p.number,
              name: p.name,
              status: p.status,
              billingMethod: p.billingMethod,
              budgetHours: p.budgetHours === null ? null : decimal(p.budgetHours).toFixed(2),
              overBudgetHours:
                p.budgetHours !== null && sum((t) => t.hours, counted).gt(p.budgetHours),
              budgetAmount:
                p.budgetAmount === null ? null : decimal(p.budgetAmount).toFixed(places),
              hours: {
                draft: hoursOf('DRAFT').toFixed(2),
                submitted: hoursOf('SUBMITTED').toFixed(2),
                approved: hoursOf('APPROVED').toFixed(2),
                billed: hoursOf('BILLED').toFixed(2),
                rejected: hoursOf('REJECTED').toFixed(2),
                total: sum((t) => t.hours, counted).toFixed(2),
              },
              unbilledBillableAmount: sum(
                (t) => t.bill_amount,
                (t) => t.status === 'APPROVED' && t.billable,
              ).toFixed(places),
              billedAmount: sum(
                (t) => t.bill_amount,
                (t) => t.status === 'BILLED',
              ).toFixed(places),
              timeCost: sum((t) => t.cost_amount, counted).toFixed(places),
              ledger:
                revenue === null || cost === null
                  ? null
                  : {
                      revenue: revenue.toFixed(places),
                      cost: cost.toFixed(places),
                      profit: revenue.minus(cost).toFixed(places),
                    },
            };
          }),
        };
      },
      { readOnly: true },
    );
  }
}
