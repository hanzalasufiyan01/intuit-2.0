import { randomUUID } from 'node:crypto';
import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { designationsOfAccount, getAccount, isValidIsoDate } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  employeeByUser,
  getAdvance,
  getEmployee,
  getLeaveRequest,
  getLeaveType,
  getPayrollSettings,
  insertAdvance,
  insertLeaveRequest,
  insertLeaveType,
  leaveTypeCodeExists,
  leaveUsage,
  listAdvances,
  listEmployees,
  listLeaveRequests,
  listLeaveTypes,
  overlappingLeave,
  PayrollPermissions,
  repaidAmounts,
  repaymentsOfAdvance,
  takeNextPayrollNumber,
  updateAdvance,
  updateLeaveRequest,
  updateLeaveType,
  type Advance,
  type LeaveRequest,
  type LeaveStatus,
  type LeaveType,
} from '../modules/payroll/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';

/**
 * Payroll leave and salary advances (FP-25 follow-up, migration 0073).
 *
 * Leave: types with an annual entitlement; a request by or for an employee; approval by someone
 * else with `payroll.leave.manage`; a balance per year. Days are entered (half days allowed) and
 * must fit the dates: which days count as working days is an open policy decision, so nothing
 * derives them. Leave does not change a payslip.
 *
 * Advances: granted with a journal (Dr advances asset / Cr bank) and recovered by the pay run as a
 * payslip deduction line crediting the same asset account. The outstanding balance is principal
 * less the repayments of runs that are posted or paid, so voiding a run gives an instalment back.
 */

export const PAYROLL_ADVANCE_EVENT = 'payroll.advance_granted';
const MODULE = 'payroll' as const;
const versionConflict = (noun: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${noun} changed; reload it and try again.`);
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const isDate = (v: string) => isValidIsoDate(v);

export class PayrollExtraService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
  ) {
    journals.registerEventHandler(PAYROLL_ADVANCE_EVENT, (e) => e.payload.journal as never, {
      domainApproval: true,
    });
  }

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
  // Leave types
  // ---------------------------------------------------------------------------

  private typeView(t: LeaveType) {
    return {
      id: t.id,
      code: t.code,
      name: t.name,
      daysPerYear: decimal(t.daysPerYear).toFixed(),
      allowNegative: t.allowNegative,
      isActive: t.isActive,
      version: t.version,
    };
  }

  /** Visible to payroll viewers, leave managers and linked employees (they choose a type). */
  listLeaveTypes(principal: Principal) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) =>
        (await listLeaveTypes(tx, ctx.organizationId)).map((t) => this.typeView(t)),
      { readOnly: true },
    );
  }

  createLeaveType(
    principal: Principal,
    input: { code: string; name: string; daysPerYear: string; allowNegative: boolean },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.LeaveManage, async (tx, ctx) => {
      const issues: ValidationIssue[] = [];
      if (!/^[A-Z0-9_]{1,20}$/.test(input.code)) {
        issues.push({
          path: 'code',
          message: 'Use up to 20 capital letters, digits or underscores.',
        });
      } else if (await leaveTypeCodeExists(tx, ctx.organizationId, input.code)) {
        issues.push({ path: 'code', message: 'This code is already used.' });
      }
      if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
      const days = decimal(input.daysPerYear);
      if (days.lt(0) || days.gt(366))
        issues.push({ path: 'daysPerYear', message: 'Enter 0 to 366.' });
      if (issues.length) throw new ValidationError(issues);
      const now = this.now;
      const row = await insertLeaveType(tx, {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name.trim(),
        daysPerYear: days.toFixed(2),
        allowNegative: input.allowNegative,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(
        tx,
        ctx,
        'payroll.leave_type_created',
        'payroll_leave_type',
        row.id,
        origin,
        {
          code: row.code,
        },
      );
      return this.typeView(row);
    });
  }

  updateLeaveType(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name: string;
      daysPerYear: string;
      allowNegative: boolean;
      isActive: boolean;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.LeaveManage, async (tx, ctx) => {
      if (!(await getLeaveType(tx, ctx.organizationId, id)))
        throw new NotFoundError('Leave type not found.');
      const days = decimal(input.daysPerYear);
      if (!input.name.trim() || days.lt(0) || days.gt(366)) {
        throw new ValidationError([{ path: 'name', message: 'Enter a name and 0 to 366 days.' }]);
      }
      const row = await updateLeaveType(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          name: input.name.trim(),
          daysPerYear: days.toFixed(2),
          allowNegative: input.allowNegative,
          isActive: input.isActive,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!row) throw versionConflict('leave type');
      await this.audit(tx, ctx, 'payroll.leave_type_updated', 'payroll_leave_type', id, origin, {
        daysPerYear: row.daysPerYear,
        isActive: row.isActive,
      });
      return this.typeView(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Leave requests
  // ---------------------------------------------------------------------------

  private requestView(r: LeaveRequest, names: Map<string, string>, types: Map<string, LeaveType>) {
    return {
      id: r.id,
      employeeId: r.employeeId,
      employeeName: names.get(r.employeeId) ?? null,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: types.get(r.leaveTypeId)?.name ?? null,
      startDate: r.startDate,
      endDate: r.endDate,
      days: decimal(r.days).toFixed(),
      reason: r.reason,
      status: r.status,
      decisionNote: r.decisionNote,
      version: r.version,
    };
  }

  private async lookups(tx: Transaction, organizationId: string) {
    const [employees, types] = await Promise.all([
      listEmployees(tx, organizationId),
      listLeaveTypes(tx, organizationId),
    ]);
    return {
      names: new Map(employees.map((e) => [e.id, e.displayName])),
      types: new Map(types.map((t) => [t.id, t])),
    };
  }

  private async balances(
    tx: Transaction,
    organizationId: string,
    employeeId: string,
    year: number,
  ) {
    const [types, usage] = await Promise.all([
      listLeaveTypes(tx, organizationId),
      leaveUsage(tx, organizationId, employeeId, year),
    ]);
    return types
      .filter((t) => t.isActive)
      .map((t) => {
        const days = (status: string) =>
          usage
            .filter((u) => u.leave_type_id === t.id && u.status === status)
            .reduce((s, u) => s.plus(u.days), decimal(0));
        const taken = days('APPROVED');
        const pending = days('PENDING');
        return {
          leaveTypeId: t.id,
          name: t.name,
          entitlement: decimal(t.daysPerYear).toFixed(),
          taken: taken.toFixed(),
          pending: pending.toFixed(),
          remaining: decimal(t.daysPerYear).minus(taken).toFixed(),
        };
      });
  }

  /** All requests with payroll.leave.manage or payroll.view; otherwise only the caller's own. */
  listLeaveRequests(
    principal: Principal,
    filter: { employeeId?: string | undefined; status?: LeaveStatus | undefined; limit: number },
  ) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) => {
        const all =
          hasPermission(ctx, PayrollPermissions.LeaveManage) ||
          hasPermission(ctx, PayrollPermissions.View);
        let employeeId = filter.employeeId;
        if (!all) {
          const mine = await employeeByUser(tx, ctx.organizationId, ctx.userId);
          if (!mine) return [];
          employeeId = mine.id;
        }
        const [rows, look] = await Promise.all([
          listLeaveRequests(tx, ctx.organizationId, { ...filter, employeeId }),
          this.lookups(tx, ctx.organizationId),
        ]);
        return rows.map((r) => this.requestView(r, look.names, look.types));
      },
      { readOnly: true },
    );
  }

  balancesFor(principal: Principal, employeeId: string | null, year: number) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) => {
        const manager =
          hasPermission(ctx, PayrollPermissions.LeaveManage) ||
          hasPermission(ctx, PayrollPermissions.View);
        const mine = await employeeByUser(tx, ctx.organizationId, ctx.userId);
        const target = employeeId ?? mine?.id;
        if (!target) throw new NotFoundError('There is no employee record for you.');
        if (target !== mine?.id && !manager) throw new PermissionDeniedError();
        if (!(await getEmployee(tx, ctx.organizationId, target)))
          throw new NotFoundError('Employee not found.');
        return {
          employeeId: target,
          year,
          balances: await this.balances(tx, ctx.organizationId, target, year),
        };
      },
      { readOnly: true },
    );
  }

  /** A request for oneself (a linked employee) or, with payroll.leave.manage, for any employee. */
  requestLeave(
    principal: Principal,
    input: {
      employeeId?: string | undefined;
      leaveTypeId: string;
      startDate: string;
      endDate: string;
      days: string;
      reason?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, undefined, async (tx, ctx) => {
      const manager = hasPermission(ctx, PayrollPermissions.LeaveManage);
      const mine = await employeeByUser(tx, ctx.organizationId, ctx.userId);
      const employeeId = input.employeeId ?? mine?.id;
      if (!employeeId) throw new NotFoundError('There is no employee record for you.');
      if (employeeId !== mine?.id && !manager) throw new PermissionDeniedError();
      const employee = await getEmployee(tx, ctx.organizationId, employeeId);
      if (!employee) throw new NotFoundError('Employee not found.');
      const issues: ValidationIssue[] = [];
      const type = await getLeaveType(tx, ctx.organizationId, input.leaveTypeId);
      if (!type) issues.push({ path: 'leaveTypeId', message: 'Choose a leave type.' });
      else if (!type.isActive)
        issues.push({ path: 'leaveTypeId', message: 'This leave type is inactive.' });
      if (!isDate(input.startDate))
        issues.push({ path: 'startDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      if (!isDate(input.endDate))
        issues.push({ path: 'endDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      const days = decimal(input.days);
      if (!issues.length) {
        if (input.endDate < input.startDate)
          issues.push({ path: 'endDate', message: 'The end date is before the start date.' });
        else {
          const span = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
          if (!days.gt(0) || days.gt(span) || days.mul(2).decimalPlaces() > 0) {
            issues.push({
              path: 'days',
              message: `Enter days above 0 (whole or half) and at most ${span}.`,
            });
          }
        }
        if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) {
          issues.push({
            path: 'endDate',
            message: 'A request stays within one calendar year; split it at the year end.',
          });
        }
      }
      if (
        !issues.length &&
        (employee.hireDate > input.startDate ||
          (employee.terminationDate && employee.terminationDate < input.endDate))
      ) {
        issues.push({ path: 'startDate', message: 'The dates are outside the employment period.' });
      }
      if (
        !issues.length &&
        (await overlappingLeave(tx, {
          organizationId: ctx.organizationId,
          employeeId,
          startDate: input.startDate,
          endDate: input.endDate,
        }))
      ) {
        issues.push({
          path: 'startDate',
          message: 'Another leave request covers some of these dates.',
        });
      }
      if (issues.length) throw new ValidationError(issues);
      const now = this.now;
      const row = await insertLeaveRequest(tx, {
        organizationId: ctx.organizationId,
        employeeId,
        leaveTypeId: input.leaveTypeId,
        startDate: input.startDate,
        endDate: input.endDate,
        days: days.toFixed(2),
        reason: (input.reason ?? '').trim(),
        requestedByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(
        tx,
        ctx,
        'payroll.leave_requested',
        'payroll_leave_request',
        row.id,
        origin,
        {
          days: row.days,
          startDate: row.startDate,
        },
      );
      const look = await this.lookups(tx, ctx.organizationId);
      return this.requestView(row, look.names, look.types);
    });
  }

  private decide(
    principal: Principal,
    id: string,
    input: { version: number; note?: string | undefined },
    decision: 'APPROVED' | 'REJECTED',
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.LeaveManage, async (tx, ctx) => {
      const r = await getLeaveRequest(tx, ctx.organizationId, id, { forUpdate: true });
      if (!r) throw new NotFoundError('Leave request not found.');
      if (r.version !== input.version) throw versionConflict('leave request');
      if (r.status !== 'PENDING') throw invalidState('Only a pending request can be decided.');
      if (r.requestedByUserId === ctx.userId) {
        throw new AppError(
          'SELF_APPROVAL_PROHIBITED',
          403,
          'You cannot decide your own leave request.',
        );
      }
      const note = input.note?.trim();
      if (decision === 'REJECTED' && !note) {
        throw new ValidationError([{ path: 'note', message: 'Say why the request is rejected.' }]);
      }
      if (decision === 'APPROVED') {
        const type = await getLeaveType(tx, ctx.organizationId, r.leaveTypeId);
        const usage = await leaveUsage(
          tx,
          ctx.organizationId,
          r.employeeId,
          Number(r.startDate.slice(0, 4)),
        );
        const taken = usage
          .filter((u) => u.leave_type_id === r.leaveTypeId && u.status === 'APPROVED')
          .reduce((s, u) => s.plus(u.days), decimal(0));
        const after = decimal(type!.daysPerYear).minus(taken).minus(r.days);
        if (after.lt(0) && !type!.allowNegative) {
          throw new ConflictError(
            'CONFLICT',
            `The balance would be ${after.toFixed()} days; this leave type does not allow a negative balance.`,
          );
        }
      }
      const now = this.now;
      const updated = await updateLeaveRequest(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          status: decision,
          decidedByUserId: ctx.userId,
          decidedAt: now,
          decisionNote: note ?? null,
          updatedAt: now,
        },
      });
      if (!updated) throw versionConflict('leave request');
      await this.audit(
        tx,
        ctx,
        decision === 'APPROVED' ? 'payroll.leave_approved' : 'payroll.leave_rejected',
        'payroll_leave_request',
        id,
        origin,
        {
          days: updated.days,
        },
      );
      const look = await this.lookups(tx, ctx.organizationId);
      return this.requestView(updated, look.names, look.types);
    });
  }

  approveLeave(
    principal: Principal,
    id: string,
    input: { version: number; note?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.decide(principal, id, input, 'APPROVED', origin);
  }

  rejectLeave(
    principal: Principal,
    id: string,
    input: { version: number; note: string },
    origin: EventOrigin,
  ) {
    return this.decide(principal, id, input, 'REJECTED', origin);
  }

  /** The requester cancels their own request; a manager may cancel any. */
  cancelLeave(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.run(principal, undefined, async (tx, ctx) => {
      const r = await getLeaveRequest(tx, ctx.organizationId, id, { forUpdate: true });
      const manager = hasPermission(ctx, PayrollPermissions.LeaveManage);
      if (!r || (r.requestedByUserId !== ctx.userId && !manager))
        throw new NotFoundError('Leave request not found.');
      if (r.version !== input.version) throw versionConflict('leave request');
      if (!['PENDING', 'APPROVED'].includes(r.status))
        throw invalidState('This request can no longer be cancelled.');
      const updated = await updateLeaveRequest(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: { status: 'CANCELLED', updatedAt: this.now },
      });
      if (!updated) throw versionConflict('leave request');
      await this.audit(tx, ctx, 'payroll.leave_cancelled', 'payroll_leave_request', id, origin);
      const look = await this.lookups(tx, ctx.organizationId);
      return this.requestView(updated, look.names, look.types);
    });
  }

  // ---------------------------------------------------------------------------
  // Salary advances
  // ---------------------------------------------------------------------------

  private async advanceView(tx: Transaction, organizationId: string, a: Advance, repaid: string) {
    const outstanding = a.status === 'CANCELLED' ? decimal(0) : decimal(a.principal).minus(repaid);
    return {
      id: a.id,
      number: a.number,
      employeeId: a.employeeId,
      grantedDate: a.grantedDate,
      principal: decimal(a.principal).toFixed(),
      installment: decimal(a.installment).toFixed(),
      note: a.note,
      status:
        a.status === 'CANCELLED'
          ? ('CANCELLED' as const)
          : outstanding.lte(0)
            ? ('REPAID' as const)
            : ('ACTIVE' as const),
      repaid: decimal(repaid).toFixed(),
      outstanding: outstanding.toFixed(),
      journalId: a.journalId,
      cancelReason: a.cancelReason,
      version: a.version,
    };
  }

  listAdvances(principal: Principal, filter: { employeeId?: string | undefined; limit: number }) {
    return this.run(
      principal,
      PayrollPermissions.AdvancesManage,
      async (tx, ctx) => {
        const rows = await listAdvances(tx, ctx.organizationId, filter);
        const repaid = await repaidAmounts(
          tx,
          ctx.organizationId,
          rows.map((r) => r.id),
        );
        return Promise.all(
          rows.map((a) => this.advanceView(tx, ctx.organizationId, a, repaid.get(a.id) ?? '0')),
        );
      },
      { readOnly: true },
    );
  }

  getAdvance(principal: Principal, id: string) {
    return this.run(
      principal,
      PayrollPermissions.AdvancesManage,
      async (tx, ctx) => {
        const a = await getAdvance(tx, ctx.organizationId, id);
        if (!a) throw new NotFoundError('Advance not found.');
        const repaid = await repaidAmounts(tx, ctx.organizationId, [id]);
        return {
          ...(await this.advanceView(tx, ctx.organizationId, a, repaid.get(id) ?? '0')),
          repayments: await repaymentsOfAdvance(tx, ctx.organizationId, id),
        };
      },
      { readOnly: true },
    );
  }

  /** Pays an advance out: Dr the advances asset account / Cr the bank account, on the grant date. */
  grantAdvance(
    principal: Principal,
    input: {
      employeeId: string;
      grantedDate: string;
      principal: string;
      installment: string;
      bankAccountId: string;
      note?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(
      principal,
      PayrollPermissions.AdvancesManage,
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const places = minorUnits(accounting.baseCurrency);
        const settings = await getPayrollSettings(tx, ctx.organizationId);
        const issues: ValidationIssue[] = [];
        if (!settings?.advancesAccountId) {
          issues.push({
            path: 'settings',
            message: 'Choose the employee advances account in Payroll settings first.',
          });
        }
        const employee = await getEmployee(tx, ctx.organizationId, input.employeeId);
        if (!employee) issues.push({ path: 'employeeId', message: 'Choose an employee.' });
        if (!isDate(input.grantedDate))
          issues.push({ path: 'grantedDate', message: 'Enter a valid date (YYYY-MM-DD).' });
        else if (
          employee &&
          (employee.hireDate > input.grantedDate ||
            (employee.terminationDate && employee.terminationDate < input.grantedDate))
        ) {
          issues.push({
            path: 'grantedDate',
            message: 'The employee was not employed on that date.',
          });
        }
        const amount = decimal(input.principal);
        const installment = decimal(input.installment);
        if (!amount.gt(0) || amount.decimalPlaces() > places)
          issues.push({ path: 'principal', message: 'Enter an amount above zero.' });
        if (!installment.gt(0) || installment.gt(amount) || installment.decimalPlaces() > places) {
          issues.push({
            path: 'installment',
            message: 'The instalment must be above zero and not above the advance.',
          });
        }
        const bank = await getAccount(tx, ctx.organizationId, input.bankAccountId);
        if (
          !bank ||
          bank.status !== 'ACTIVE' ||
          !bank.isLeaf ||
          !['BANK', 'CASH'].includes(bank.subtype ?? '')
        ) {
          issues.push({ path: 'bankAccountId', message: 'Choose a bank or cash account.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const asset = await getAccount(tx, ctx.organizationId, settings!.advancesAccountId!);
        if (
          !asset ||
          asset.status !== 'ACTIVE' ||
          !asset.isLeaf ||
          asset.isControlAccount ||
          asset.subtype !== 'OTHER_CURRENT_ASSET' ||
          (await designationsOfAccount(tx, ctx.organizationId, asset.id)).length
        ) {
          throw new ValidationError([
            {
              path: 'settings',
              message: 'The employee advances account in Payroll settings is no longer usable.',
            },
          ]);
        }
        await assertOpenPeriod(tx, ctx.organizationId, input.grantedDate);
        const id = randomUUID();
        const number = await takeNextPayrollNumber(tx, ctx.organizationId, 'advance');
        const text = `Salary advance ${number}`;
        const event = await this.journals.receiveEventInTransaction(tx, {
          organizationId: ctx.organizationId,
          sourceModule: 'payroll',
          eventType: PAYROLL_ADVANCE_EVENT,
          eventKey: `payroll_advance:${id}:granted`,
          payload: {
            advanceId: id,
            number,
            journal: {
              entryDate: input.grantedDate,
              description: text,
              reference: number,
              currency: accounting.baseCurrency,
              exchangeRate: null,
              sourceRef: { module: 'payroll', type: 'advance', id },
              lines: [
                {
                  accountId: asset.id,
                  description: text,
                  debit: amount.toFixed(places),
                  credit: null,
                  dimensions: [],
                },
                {
                  accountId: input.bankAccountId,
                  description: text,
                  debit: null,
                  credit: amount.toFixed(places),
                  dimensions: [],
                },
              ],
            },
          },
          occurredAt: this.now,
          origin,
        });
        if (!event.journalId)
          throw new AppError('CONFLICT', 409, 'The advance was not posted; try again.');
        const now = this.now;
        const row = await insertAdvance(tx, {
          id,
          organizationId: ctx.organizationId,
          number,
          employeeId: input.employeeId,
          grantedDate: input.grantedDate,
          principal: amount.toFixed(4),
          installment: installment.toFixed(4),
          note: (input.note ?? '').trim(),
          bankAccountId: input.bankAccountId,
          journalId: event.journalId,
          accountingEventId: event.eventId,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit(tx, ctx, 'payroll.advance_granted', 'payroll_advance', id, origin, {
          number,
          principal: row.principal,
          journalId: event.journalId,
        });
        return this.advanceView(tx, ctx.organizationId, row, '0');
      },
      { sensitive: true },
    );
  }

  /** Cancels an advance nothing has been recovered from: its journal is reversed. */
  cancelAdvance(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return this.run(
      principal,
      PayrollPermissions.AdvancesManage,
      async (tx, ctx) => {
        const a = await getAdvance(tx, ctx.organizationId, id, { forUpdate: true });
        if (!a) throw new NotFoundError('Advance not found.');
        if (a.version !== input.version) throw versionConflict('advance');
        if (a.status === 'CANCELLED') throw invalidState('The advance is already cancelled.');
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        const repayments = await repaymentsOfAdvance(tx, ctx.organizationId, id);
        if (repayments.some((r) => r.runStatus === 'POSTED' || r.runStatus === 'PAID')) {
          throw invalidState(
            'An advance with recovered instalments cannot be cancelled; void those pay runs first.',
          );
        }
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'payroll',
          a.journalId,
          { reason: `Advance ${a.number} cancelled: ${reason}` },
          origin,
        );
        const updated = await updateAdvance(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'CANCELLED',
            cancelReason: reason,
            cancelJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('advance');
        await this.audit(tx, ctx, 'payroll.advance_cancelled', 'payroll_advance', id, origin, {
          number: a.number,
          reason,
          reversalJournalId: reversal.id,
        });
        return this.advanceView(tx, ctx.organizationId, updated, '0');
      },
      { sensitive: true },
    );
  }
}
