import { randomUUID } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { getCustomer } from '../modules/customers/index.js';
import {
  dueSchedules,
  findRun,
  frequencies,
  getSchedule,
  getScheduleLines,
  insertRun,
  insertSchedule,
  listRuns,
  listSchedules,
  occurrence,
  QuotePermissions,
  replaceScheduleLines,
  updateSchedule,
  type Frequency,
  type Schedule,
  type ScheduleStatus,
} from '../modules/quotes/index.js';
import { getItem, SalesPermissions } from '../modules/sales/index.js';
import { getTaxCode } from '../modules/tax/index.js';
import {
  hasPermission,
  resolveActingUserContext,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { InvoiceService } from './invoice-service.js';
import { systemOrigin } from './job-service.js';
import { withOrganization } from './organization-service.js';
import { inTransaction } from './unit-of-work.js';

/**
 * Recurring invoice schedules (FP-28, migration 0068). A schedule creates DRAFT sales invoices on
 * a calendar and nothing more: it never issues, sends or posts. Each (schedule, run date) is
 * generated at most once (unique run record), occurrences are counted from the start date so month
 * ends do not drift, and a schedule that was behind (the server was down) catches up one period at
 * a time. The background run acts with the permissions of the person who created the schedule;
 * if they lose the right, the schedule pauses with the reason instead of failing silently.
 */

const MAX_CATCH_UP_PER_RUN = 24;
const DUE_BATCH = 50;
const MAX_LINES = 100;

const versionConflict = () =>
  new ConflictError('VERSION_CONFLICT', 'The schedule changed; reload it and try again.');
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface ScheduleLineInput {
  itemId?: string | null | undefined;
  description?: string | undefined;
  quantity: string;
  unitPrice: string;
  taxCodeId?: string | null | undefined;
}

export interface ScheduleInput {
  name: string;
  customerId: string;
  frequency: Frequency;
  startDate: string;
  endDate?: string | null | undefined;
  reference?: string | null | undefined;
  memo?: string | undefined;
  paymentTermsDays?: number | null | undefined;
  lines: ScheduleLineInput[];
}

export class RecurringInvoiceService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly invoices: InvoiceService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private today() {
    return this.now.toISOString().slice(0, 10);
  }

  private audit(
    tx: Transaction,
    actor: { organizationId: string; userId: string },
    action: string,
    id: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      resourceType: 'recurring_invoice_schedule',
      resourceId: id,
      metadata,
      origin,
    });
  }

  private async view(tx: Transaction, organizationId: string, s: Schedule) {
    const [lines, runs] = await Promise.all([
      getScheduleLines(tx, organizationId, s.id),
      listRuns(tx, organizationId, s.id),
    ]);
    return {
      id: s.id,
      name: s.name,
      customerId: s.customerId,
      frequency: s.frequency,
      startDate: s.startDate,
      nextRunDate: s.nextRunDate,
      endDate: s.endDate,
      status: s.status,
      reference: s.reference,
      memo: s.memo,
      paymentTermsDays: s.paymentTermsDays,
      runCount: s.runCount,
      lastRunAt: s.lastRunAt?.toISOString() ?? null,
      lastError: s.lastError,
      version: s.version,
      lines: lines.map((l) => ({
        lineNo: l.lineNo,
        itemId: l.itemId,
        description: l.description,
        quantity: decimal(l.quantity).toFixed(),
        unitPrice: decimal(l.unitPrice).toFixed(),
        taxCodeId: l.taxCodeId,
      })),
      runs: runs.map((r) => ({ runDate: r.runDate, invoiceId: r.invoiceId })),
    };
  }

  private async validate(tx: Transaction, ctx: AuthorizationContext, input: ScheduleInput) {
    const issues: ValidationIssue[] = [];
    if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
    if (!(frequencies as readonly string[]).includes(input.frequency)) {
      issues.push({ path: 'frequency', message: 'Choose how often.' });
    }
    if (!isValidIsoDate(input.startDate)) {
      issues.push({ path: 'startDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (input.endDate) {
      if (!isValidIsoDate(input.endDate)) {
        issues.push({ path: 'endDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (isValidIsoDate(input.startDate) && input.endDate < input.startDate) {
        issues.push({ path: 'endDate', message: 'The end date is before the start date.' });
      }
    }
    if (!(await getCustomer(tx, ctx.organizationId, input.customerId))) {
      issues.push({ path: 'customerId', message: 'Choose a customer of this organization.' });
    }
    if (!input.lines.length || input.lines.length > MAX_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_LINES} lines.` });
    }
    const lines: {
      itemId: string | null;
      description: string;
      quantity: string;
      unitPrice: string;
      taxCodeId: string | null;
    }[] = [];
    for (const [i, line] of input.lines.entries()) {
      const item = line.itemId ? await getItem(tx, ctx.organizationId, line.itemId) : undefined;
      if (line.itemId && !item)
        issues.push({ path: `lines.${i}.itemId`, message: 'Unknown item.' });
      const description = (line.description?.trim() || item?.name || '').slice(0, 500);
      if (!description) {
        issues.push({
          path: `lines.${i}.description`,
          message: 'Describe the line or choose an item.',
        });
      }
      if (!decimal(line.quantity).gt(0)) {
        issues.push({ path: `lines.${i}.quantity`, message: 'Enter a quantity above zero.' });
      }
      if (decimal(line.unitPrice).lt(0)) {
        issues.push({ path: `lines.${i}.unitPrice`, message: 'Enter zero or more.' });
      }
      if (line.taxCodeId && !(await getTaxCode(tx, ctx.organizationId, line.taxCodeId))) {
        issues.push({ path: `lines.${i}.taxCodeId`, message: 'Unknown tax code.' });
      }
      lines.push({
        itemId: line.itemId ?? null,
        description,
        quantity: decimal(line.quantity).toFixed(6),
        unitPrice: decimal(line.unitPrice).toFixed(6),
        taxCodeId: line.taxCodeId ?? null,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    return lines;
  }

  list(principal: Principal, filter: { status?: ScheduleStatus | undefined }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listSchedules(tx, ctx.organizationId, filter);
        return Promise.all(rows.map((s) => this.view(tx, ctx.organizationId, s)));
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const s = await getSchedule(tx, ctx.organizationId, id);
        if (!s) throw new NotFoundError('Schedule not found.');
        return this.view(tx, ctx.organizationId, s);
      },
    );
  }

  create(principal: Principal, input: ScheduleInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringManage },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
        const lines = await this.validate(tx, ctx, input);
        const now = this.now;
        const schedule = await insertSchedule(tx, {
          organizationId: ctx.organizationId,
          name: input.name.trim(),
          customerId: input.customerId,
          frequency: input.frequency,
          startDate: input.startDate,
          nextRunDate: input.startDate,
          endDate: input.endDate || null,
          reference: input.reference?.trim() || null,
          memo: (input.memo ?? '').trim(),
          paymentTermsDays: input.paymentTermsDays ?? null,
          actingUserId: ctx.userId,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await replaceScheduleLines(tx, ctx.organizationId, schedule.id, lines);
        await this.audit(tx, ctx, 'recurring_invoice.created', schedule.id, origin, {
          name: schedule.name,
          frequency: schedule.frequency,
          startDate: schedule.startDate,
        });
        return this.view(tx, ctx.organizationId, schedule);
      },
    );
  }

  update(
    principal: Principal,
    id: string,
    input: ScheduleInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringManage },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
        const existing = await getSchedule(tx, ctx.organizationId, id, { forUpdate: true });
        if (!existing) throw new NotFoundError('Schedule not found.');
        if (existing.version !== input.version) throw versionConflict();
        if (existing.status === 'ENDED') throw invalidState('An ended schedule cannot be edited.');
        const lines = await this.validate(tx, ctx, input);
        // The start date and frequency fix the occurrences already generated.
        if (
          existing.runCount > 0 &&
          (input.startDate !== existing.startDate || input.frequency !== existing.frequency)
        ) {
          throw new ValidationError([
            {
              path: 'startDate',
              message: 'The start date and frequency cannot change after invoices were generated.',
            },
          ]);
        }
        const next = occurrence(input.startDate, input.frequency, existing.runCount);
        await replaceScheduleLines(tx, ctx.organizationId, id, lines);
        const updated = await updateSchedule(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            name: input.name.trim(),
            customerId: input.customerId,
            frequency: input.frequency,
            startDate: input.startDate,
            nextRunDate: next,
            endDate: input.endDate || null,
            reference: input.reference?.trim() || null,
            memo: (input.memo ?? '').trim(),
            paymentTermsDays: input.paymentTermsDays ?? null,
            // The person who last edited the schedule is the one it acts for.
            actingUserId: ctx.userId,
            lastError: null,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'recurring_invoice.updated', id, origin, { name: updated.name });
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  private setStatus(
    principal: Principal,
    id: string,
    input: { version: number },
    status: 'ACTIVE' | 'PAUSED' | 'ENDED',
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringManage },
      async (tx, ctx) => {
        const s = await getSchedule(tx, ctx.organizationId, id, { forUpdate: true });
        if (!s) throw new NotFoundError('Schedule not found.');
        if (s.version !== input.version) throw versionConflict();
        if (s.status === 'ENDED') throw invalidState('The schedule has ended.');
        if (s.status === status)
          throw invalidState(`The schedule is already ${status.toLowerCase()}.`);
        if (status === 'ACTIVE' && !hasPermission(ctx, SalesPermissions.InvoicesCreate)) {
          throw new PermissionDeniedError();
        }
        const updated = await updateSchedule(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status,
            ...(status === 'ACTIVE' ? { actingUserId: ctx.userId, lastError: null } : {}),
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(
          tx,
          ctx,
          `recurring_invoice.${status === 'ACTIVE' ? 'resumed' : status === 'PAUSED' ? 'paused' : 'ended'}`,
          id,
          origin,
        );
        return this.view(tx, ctx.organizationId, updated);
      },
    );
  }

  pause(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.setStatus(principal, id, input, 'PAUSED', origin);
  }

  resume(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.setStatus(principal, id, input, 'ACTIVE', origin);
  }

  end(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.setStatus(principal, id, input, 'ENDED', origin);
  }

  /**
   * Generates the draft invoice for the schedule's next run date and moves the schedule to its
   * next occurrence. Safe to repeat: a date that already has a run record only advances.
   */
  private async generateNext(
    tx: Transaction,
    ctx: AuthorizationContext,
    schedule: Schedule,
    origin: EventOrigin,
  ): Promise<{ invoiceId: string | null; schedule: Schedule }> {
    const runDate = schedule.nextRunDate;
    const existing = await findRun(tx, ctx.organizationId, schedule.id, runDate);
    let invoiceId: string | null = existing?.invoiceId ?? null;
    if (!existing) {
      const lines = await getScheduleLines(tx, ctx.organizationId, schedule.id);
      const invoice = await this.invoices.createDraftInTransaction(
        tx,
        ctx,
        {
          customerId: schedule.customerId,
          invoiceDate: runDate,
          ...(schedule.paymentTermsDays !== null
            ? { paymentTermsDays: schedule.paymentTermsDays }
            : {}),
          reference: schedule.reference ?? schedule.name.slice(0, 100),
          memo: schedule.memo,
          lines: lines.map((l) => ({
            ...(l.itemId ? { itemId: l.itemId } : {}),
            description: l.description,
            quantity: decimal(l.quantity).toFixed(),
            unitPrice: decimal(l.unitPrice).toFixed(),
            ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}),
          })),
        },
        origin,
      );
      invoiceId = invoice.id;
      await insertRun(tx, {
        organizationId: ctx.organizationId,
        scheduleId: schedule.id,
        runDate,
        invoiceId,
        createdAt: this.now,
      });
    }
    const runCount = schedule.runCount + 1;
    const next = occurrence(schedule.startDate, schedule.frequency, runCount);
    const ended = schedule.endDate !== null && next > schedule.endDate;
    const updated = await updateSchedule(tx, {
      organizationId: ctx.organizationId,
      id: schedule.id,
      version: schedule.version,
      set: {
        runCount,
        nextRunDate: next,
        status: ended ? 'ENDED' : schedule.status,
        lastRunAt: this.now,
        lastError: null,
        updatedAt: this.now,
      },
    });
    if (!updated) throw versionConflict();
    if (!existing) {
      await this.audit(tx, ctx, 'recurring_invoice.generated', schedule.id, origin, {
        runDate,
        invoiceId,
        runCount,
      });
    }
    return { invoiceId, schedule: updated };
  }

  /** Manual "generate now": the next occurrence, even if it lies in the future. */
  runNow(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: QuotePermissions.RecurringManage },
      async (tx, ctx) => {
        if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
        const s = await getSchedule(tx, ctx.organizationId, id, { forUpdate: true });
        if (!s) throw new NotFoundError('Schedule not found.');
        if (s.version !== input.version) throw versionConflict();
        if (s.status === 'ENDED') throw invalidState('The schedule has ended.');
        const result = await this.generateNext(tx, ctx, s, origin);
        return {
          invoiceId: result.invoiceId,
          schedule: await this.view(tx, ctx.organizationId, result.schedule),
        };
      },
    );
  }

  /**
   * The background run: every ACTIVE schedule that is due is brought up to date, one period at a
   * time (at most 24 per schedule per tick). Each schedule runs in its own transaction as the
   * person it acts for; a failure pauses that schedule with the reason and never stops the others.
   * Returns the number of drafts created.
   */
  async runDue(): Promise<number> {
    const today = this.today();
    const due = await inTransaction(this.deps.db, {}, (tx) => dueSchedules(tx, today, DUE_BATCH));
    let created = 0;
    for (const item of due) {
      const origin = systemOrigin(`recurring:${randomUUID()}`);
      try {
        created += await inTransaction(
          this.deps.db,
          { userId: item.actingUserId, organizationId: item.organizationId },
          async (tx) => {
            const ctx = await resolveActingUserContext(tx, item.actingUserId, item.organizationId);
            if (!hasPermission(ctx, SalesPermissions.InvoicesCreate))
              throw new PermissionDeniedError();
            let schedule = await getSchedule(tx, item.organizationId, item.scheduleId, {
              forUpdate: true,
            });
            let count = 0;
            while (
              schedule &&
              schedule.status === 'ACTIVE' &&
              schedule.nextRunDate <= today &&
              count < MAX_CATCH_UP_PER_RUN
            ) {
              const result = await this.generateNext(tx, ctx, schedule, origin);
              schedule = result.schedule;
              count += 1;
            }
            return count;
          },
        );
      } catch (error) {
        await inTransaction(this.deps.db, { organizationId: item.organizationId }, async (tx) => {
          const s = await getSchedule(tx, item.organizationId, item.scheduleId, {
            forUpdate: true,
          });
          if (!s || s.status !== 'ACTIVE') return;
          const message = (error instanceof Error ? error.message : 'The run failed.').slice(
            0,
            500,
          );
          await updateSchedule(tx, {
            organizationId: item.organizationId,
            id: s.id,
            version: s.version,
            set: { status: 'PAUSED', lastError: message, updatedAt: this.now },
          });
          await recordAuditEvent(tx, {
            occurredAt: this.now,
            organizationId: item.organizationId,
            actorUserId: null,
            actorType: 'system',
            action: 'recurring_invoice.paused_after_failure',
            resourceType: 'recurring_invoice_schedule',
            resourceId: s.id,
            metadata: { reason: message },
            origin,
          });
        });
      }
    }
    return created;
  }
}
