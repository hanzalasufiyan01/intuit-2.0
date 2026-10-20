import { sql } from 'drizzle-orm';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  designationsOfAccount,
  getAccount,
  isValidIsoDate,
  type AccountWithFacts,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { findMembershipById, getOrganization } from '../modules/organizations/index.js';
import {
  activeAdvancesFor,
  buildRunPosting,
  calculatePayslip,
  componentCodeExists,
  deleteRunPayslips,
  employedDays,
  employeeByUser,
  getComponent,
  getEmployee,
  getPayrollSettings,
  getPayslip,
  getRun,
  insertComponent,
  insertEmployee,
  insertPayslip,
  insertPayslipLines,
  insertRepayments,
  insertRun,
  insertNotification,
  insertSalaryChange,
  listSalaryHistory,
  sentNotificationFor,
  latestPostedPeriodEnd,
  salaryHistoryOf,
  salaryOn,
  salaryTimeline,
  listComponents,
  deleteRunAdjustment,
  insertRunAdjustment,
  listRunAdjustments,
  type RunAdjustment,
  listEmployeeComponents,
  listEmployees,
  listPayslipLines,
  listPayslips,
  listPayslipsOfUser,
  listRuns,
  NegativeNetPay,
  overlappingRun,
  PayrollPermissions,
  repaidAmounts,
  replaceEmployeeComponents,
  savePayrollSettings,
  takeNextPayrollNumber,
  updateComponent,
  updateEmployee,
  updateRun,
  type ComponentDefinition,
  type EmployeeForPayroll,
  type PayrollComponent,
  type PayrollEmployee,
  type PayrollRun,
  type PayslipResult,
} from '../modules/payroll/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { PdfRenderer } from '../infrastructure/pdf/pdf-renderer.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';

/**
 * Payroll v1 (FP-25, docs/design/payroll.md; migration 0066). The module is off until enabled for
 * the organization. A pay run is calculated from employees and pay components into frozen
 * payslips, approved (by someone other than the preparer unless the organization turns that off),
 * posted to the ledger through the `payroll.run_posted` accounting event
 * (Dr salary and employer-cost expense / Cr deduction, contribution and net-pay liabilities, dated
 * the last day of the period) and paid (Dr net pay payable / Cr bank). Statutory rates are not
 * built in: they are components the organization configures. Posting and payment are idempotent
 * through the accounting-event key and the run's status.
 */

export const PAYROLL_RUN_EVENT = 'payroll.run_posted';
export const PAYROLL_PAYMENT_EVENT = 'payroll.run_paid';
const MODULE = 'payroll' as const;
const MAX_EMPLOYEES_PER_RUN = 2000;

const versionConflict = (noun: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${noun} changed; reload it and try again.`);
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

export interface SettingsInput {
  version: number;
  basicSalaryExpenseAccountId: string | null;
  netPayPayableAccountId: string | null;
  advancesAccountId?: string | null | undefined;
  proration: 'calendar_days' | 'none';
  requireSeparateApprover: boolean;
}

export interface ComponentInput {
  code: string;
  name: string;
  kind: 'earning' | 'deduction' | 'employer_contribution';
  calculation: 'fixed' | 'percent_of_basic' | 'percent_of_gross';
  defaultValue: string;
  expenseAccountId?: string | null | undefined;
  liabilityAccountId?: string | null | undefined;
}

export interface EmployeeInput {
  /**
   * When the basic salary takes effect. Omitted: a salary entered with the employee replaces the
   * current salary (a correction). Given: a dated change (not into a period already posted).
   */
  salaryEffectiveFrom?: string | undefined;
  salaryReason?: string | undefined;
  displayName: string;
  email?: string | null | undefined;
  nationalId?: string | null | undefined;
  linkedMembershipId?: string | null | undefined;
  hireDate: string;
  terminationDate?: string | null | undefined;
  basicSalary: string;
  bankAccountRef?: string | null | undefined;
  components: { componentId: string; value?: string | null | undefined }[];
}

const mask = (value: string | null) =>
  value === null ? null : `${'•'.repeat(Math.max(0, value.length - 3))}${value.slice(-3)}`;

type AccountRole = 'expense' | 'liability' | 'bank' | 'asset';
const ROLE_SUBTYPES: Record<AccountRole, readonly string[]> = {
  expense: ['OPERATING_EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE'],
  liability: ['OTHER_CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  bank: ['BANK', 'CASH'],
  asset: ['OTHER_CURRENT_ASSET'],
};
const ROLE_HINT: Record<AccountRole, string> = {
  expense: 'an expense account',
  liability: 'a current or long-term liability account (not Accounts Payable or a card)',
  bank: 'a bank or cash account',
  asset: 'an other current asset account',
};

export class PayrollService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
    private readonly renderer?: PdfRenderer,
  ) {
    // Payroll posts inside the run it belongs to; the journal is complete and payroll has its own
    // approval step, so the generic journal approval policy does not apply (like Inventory).
    for (const event of [PAYROLL_RUN_EVENT, PAYROLL_PAYMENT_EVENT]) {
      journals.registerEventHandler(event, (e) => e.payload.journal as never, {
        domainApproval: true,
      });
    }
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
  // Account checks
  // ---------------------------------------------------------------------------

  private async accountIssue(
    tx: Transaction,
    organizationId: string,
    accountId: string,
    role: AccountRole,
    path: string,
  ): Promise<ValidationIssue | null> {
    const account: AccountWithFacts | undefined = await getAccount(tx, organizationId, accountId);
    if (!account) return { path, message: 'Choose an account of this organization.' };
    if (account.status !== 'ACTIVE') return { path, message: 'The account is archived.' };
    if (!account.isLeaf) return { path, message: 'Choose a posting (leaf) account.' };
    if (account.isControlAccount) {
      return { path, message: 'A control account cannot be used for payroll.' };
    }
    if (role !== 'bank' && (await designationsOfAccount(tx, organizationId, accountId)).length) {
      return { path, message: 'A designated system account cannot be used for payroll.' };
    }
    if (!account.subtype || !ROLE_SUBTYPES[role].includes(account.subtype)) {
      return { path, message: `Choose ${ROLE_HINT[role]}.` };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  private settingsView(row: Awaited<ReturnType<typeof getPayrollSettings>>) {
    return {
      basicSalaryExpenseAccountId: row?.basicSalaryExpenseAccountId ?? null,
      netPayPayableAccountId: row?.netPayPayableAccountId ?? null,
      advancesAccountId: row?.advancesAccountId ?? null,
      proration: row?.proration ?? ('calendar_days' as const),
      requireSeparateApprover: row?.requireSeparateApprover ?? true,
      version: row?.version ?? 0,
    };
  }

  getSettings(principal: Principal) {
    return this.run(
      principal,
      PayrollPermissions.View,
      async (tx, ctx) => this.settingsView(await getPayrollSettings(tx, ctx.organizationId)),
      { readOnly: true },
    );
  }

  saveSettings(principal: Principal, input: SettingsInput, origin: EventOrigin) {
    return this.run(
      principal,
      PayrollPermissions.SettingsManage,
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const issues: ValidationIssue[] = [];
        if (input.basicSalaryExpenseAccountId) {
          const issue = await this.accountIssue(
            tx,
            ctx.organizationId,
            input.basicSalaryExpenseAccountId,
            'expense',
            'basicSalaryExpenseAccountId',
          );
          if (issue) issues.push(issue);
        }
        if (input.netPayPayableAccountId) {
          const issue = await this.accountIssue(
            tx,
            ctx.organizationId,
            input.netPayPayableAccountId,
            'liability',
            'netPayPayableAccountId',
          );
          if (issue) issues.push(issue);
        }
        if (input.advancesAccountId) {
          const issue = await this.accountIssue(
            tx,
            ctx.organizationId,
            input.advancesAccountId,
            'asset',
            'advancesAccountId',
          );
          if (issue) issues.push(issue);
        }
        if (issues.length) throw new ValidationError(issues);
        const saved = await savePayrollSettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          values: {
            basicSalaryExpenseAccountId: input.basicSalaryExpenseAccountId,
            netPayPayableAccountId: input.netPayPayableAccountId,
            advancesAccountId: input.advancesAccountId ?? null,
            proration: input.proration,
            requireSeparateApprover: input.requireSeparateApprover,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!saved) throw versionConflict('payroll settings');
        await this.audit(
          tx,
          ctx,
          'payroll.settings_updated',
          'payroll_settings',
          ctx.organizationId,
          origin,
          {
            proration: saved.proration,
            requireSeparateApprover: saved.requireSeparateApprover,
          },
        );
        return this.settingsView(saved);
      },
      { sensitive: true },
    );
  }

  // ---------------------------------------------------------------------------
  // Components
  // ---------------------------------------------------------------------------

  private componentView(c: PayrollComponent) {
    return {
      id: c.id,
      code: c.code,
      name: c.name,
      kind: c.kind,
      calculation: c.calculation,
      defaultValue: decimal(c.defaultValue).toFixed(),
      expenseAccountId: c.expenseAccountId,
      liabilityAccountId: c.liabilityAccountId,
      isActive: c.isActive,
      version: c.version,
    };
  }

  listComponents(principal: Principal) {
    return this.run(
      principal,
      PayrollPermissions.View,
      async (tx, ctx) =>
        (await listComponents(tx, ctx.organizationId)).map((c) => this.componentView(c)),
      { readOnly: true },
    );
  }

  private async validateComponent(tx: Transaction, organizationId: string, input: ComponentInput) {
    const issues: ValidationIssue[] = [];
    if (!/^[A-Z0-9_]{1,20}$/.test(input.code)) {
      issues.push({
        path: 'code',
        message: 'Use up to 20 capital letters, digits or underscores.',
      });
    }
    if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
    const value = decimal(input.defaultValue);
    if (value.lt(0)) issues.push({ path: 'defaultValue', message: 'Enter zero or more.' });
    if (input.calculation !== 'fixed' && value.gt(100)) {
      issues.push({ path: 'defaultValue', message: 'A percentage cannot exceed 100.' });
    }
    if (input.kind === 'earning' && input.calculation === 'percent_of_gross') {
      issues.push({
        path: 'calculation',
        message:
          'An earning cannot be a share of gross pay; use a share of basic or a fixed amount.',
      });
    }
    const needsExpense = input.kind !== 'deduction';
    const needsLiability = input.kind !== 'earning';
    if (needsExpense) {
      if (!input.expenseAccountId) {
        issues.push({ path: 'expenseAccountId', message: 'Choose the expense account.' });
      } else {
        const issue = await this.accountIssue(
          tx,
          organizationId,
          input.expenseAccountId,
          'expense',
          'expenseAccountId',
        );
        if (issue) issues.push(issue);
      }
    } else if (input.expenseAccountId) {
      issues.push({ path: 'expenseAccountId', message: 'A deduction has no expense account.' });
    }
    if (needsLiability) {
      if (!input.liabilityAccountId) {
        issues.push({ path: 'liabilityAccountId', message: 'Choose the liability account.' });
      } else {
        const issue = await this.accountIssue(
          tx,
          organizationId,
          input.liabilityAccountId,
          'liability',
          'liabilityAccountId',
        );
        if (issue) issues.push(issue);
      }
    } else if (input.liabilityAccountId) {
      issues.push({ path: 'liabilityAccountId', message: 'An earning has no liability account.' });
    }
    if (issues.length) throw new ValidationError(issues);
  }

  createComponent(principal: Principal, input: ComponentInput, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.SettingsManage, async (tx, ctx) => {
      await this.validateComponent(tx, ctx.organizationId, input);
      const now = this.now;
      if (await componentCodeExists(tx, ctx.organizationId, input.code)) {
        throw new ValidationError([{ path: 'code', message: 'This code is already used.' }]);
      }
      const created = await insertComponent(tx, {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name.trim(),
        kind: input.kind,
        calculation: input.calculation,
        defaultValue: decimal(input.defaultValue).toFixed(6),
        expenseAccountId: input.kind === 'deduction' ? null : (input.expenseAccountId ?? null),
        liabilityAccountId: input.kind === 'earning' ? null : (input.liabilityAccountId ?? null),
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(
        tx,
        ctx,
        'payroll.component_created',
        'payroll_component',
        created.id,
        origin,
        {
          code: created.code,
          kind: created.kind,
        },
      );
      return this.componentView(created);
    });
  }

  updateComponent(
    principal: Principal,
    id: string,
    input: Omit<ComponentInput, 'code' | 'kind'> & { version: number; isActive: boolean },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.SettingsManage, async (tx, ctx) => {
      const existing = await getComponent(tx, ctx.organizationId, id);
      if (!existing) throw new NotFoundError('Pay component not found.');
      await this.validateComponent(tx, ctx.organizationId, {
        ...input,
        code: existing.code,
        kind: existing.kind,
      });
      const updated = await updateComponent(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          name: input.name.trim(),
          calculation: input.calculation,
          defaultValue: decimal(input.defaultValue).toFixed(6),
          expenseAccountId: existing.kind === 'deduction' ? null : (input.expenseAccountId ?? null),
          liabilityAccountId:
            existing.kind === 'earning' ? null : (input.liabilityAccountId ?? null),
          isActive: input.isActive,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('pay component');
      await this.audit(tx, ctx, 'payroll.component_updated', 'payroll_component', id, origin, {
        code: updated.code,
        isActive: updated.isActive,
      });
      return this.componentView(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Employees
  // ---------------------------------------------------------------------------

  private async employeeView(tx: Transaction, organizationId: string, e: PayrollEmployee) {
    const assigned = await listEmployeeComponents(tx, organizationId, [e.id]);
    return {
      id: e.id,
      number: e.number,
      displayName: e.displayName,
      email: e.email,
      nationalId: mask(e.nationalId),
      linked: e.userId !== null,
      hireDate: e.hireDate,
      terminationDate: e.terminationDate,
      status:
        e.terminationDate !== null && e.terminationDate < this.now.toISOString().slice(0, 10)
          ? ('terminated' as const)
          : ('active' as const),
      basicSalary: decimal(e.basicSalary).toFixed(),
      bankAccountRef: e.bankAccountRef,
      components: assigned.map((a) => ({
        componentId: a.componentId,
        value: a.value === null ? null : decimal(a.value).toFixed(),
      })),
      version: e.version,
    };
  }

  listEmployees(principal: Principal, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const rows = await listEmployees(tx, ctx.organizationId);
      await this.audit(
        tx,
        ctx,
        'payroll.employees_listed',
        'payroll_employee',
        ctx.organizationId,
        origin,
        { returned: rows.length },
      );
      const assigned = await listEmployeeComponents(
        tx,
        ctx.organizationId,
        rows.map((r) => r.id),
      );
      const today = this.now.toISOString().slice(0, 10);
      return rows.map((e) => ({
        id: e.id,
        number: e.number,
        displayName: e.displayName,
        email: e.email,
        nationalId: mask(e.nationalId),
        linked: e.userId !== null,
        hireDate: e.hireDate,
        terminationDate: e.terminationDate,
        status: e.terminationDate !== null && e.terminationDate < today ? 'terminated' : 'active',
        basicSalary: decimal(e.basicSalary).toFixed(),
        bankAccountRef: e.bankAccountRef,
        components: assigned
          .filter((a) => a.employeeId === e.id)
          .map((a) => ({
            componentId: a.componentId,
            value: a.value === null ? null : decimal(a.value).toFixed(),
          })),
        version: e.version,
      }));
    });
  }

  getEmployee(principal: Principal, id: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const row = await getEmployee(tx, ctx.organizationId, id);
      if (!row) throw new NotFoundError('Employee not found.');
      await this.audit(tx, ctx, 'payroll.employee_viewed', 'payroll_employee', id, origin, {
        number: row.number,
      });
      return this.employeeView(tx, ctx.organizationId, row);
    });
  }

  private async validateEmployee(
    tx: Transaction,
    organizationId: string,
    input: EmployeeInput,
    selfId: string | null,
  ) {
    const issues: ValidationIssue[] = [];
    if (!input.displayName.trim()) issues.push({ path: 'displayName', message: 'Enter a name.' });
    if (!isValidIsoDate(input.hireDate)) {
      issues.push({ path: 'hireDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (input.terminationDate) {
      if (!isValidIsoDate(input.terminationDate)) {
        issues.push({ path: 'terminationDate', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (isValidIsoDate(input.hireDate) && input.terminationDate < input.hireDate) {
        issues.push({ path: 'terminationDate', message: 'The end date is before the hire date.' });
      }
    }
    if (!decimal(input.basicSalary).gte(0)) {
      issues.push({ path: 'basicSalary', message: 'Enter zero or more.' });
    }
    const seen = new Set<string>();
    for (const [i, assignment] of input.components.entries()) {
      if (seen.has(assignment.componentId)) {
        issues.push({ path: `components.${i}.componentId`, message: 'List each component once.' });
      }
      seen.add(assignment.componentId);
      const component = await getComponent(tx, organizationId, assignment.componentId);
      if (!component) {
        issues.push({ path: `components.${i}.componentId`, message: 'Unknown pay component.' });
      } else {
        if (!component.isActive) {
          issues.push({
            path: `components.${i}.componentId`,
            message: 'This component is inactive.',
          });
        }
        if (assignment.value !== null && assignment.value !== undefined) {
          const value = decimal(assignment.value);
          if (value.lt(0) || (component.calculation !== 'fixed' && value.gt(100))) {
            issues.push({
              path: `components.${i}.value`,
              message: 'Enter a valid amount or percentage.',
            });
          }
        }
      }
    }
    let userId: string | null = null;
    if (input.linkedMembershipId) {
      const membership = await findMembershipById(tx, organizationId, input.linkedMembershipId);
      if (!membership || membership.status !== 'active') {
        issues.push({ path: 'linkedMembershipId', message: 'Choose an active member.' });
      } else {
        userId = membership.userId;
        const other = await employeeByUser(tx, organizationId, membership.userId);
        if (other && other.id !== selfId) {
          issues.push({
            path: 'linkedMembershipId',
            message: 'This member is already linked to another employee.',
          });
        }
      }
    }
    if (issues.length) throw new ValidationError(issues);
    return userId;
  }

  createEmployee(principal: Principal, input: EmployeeInput, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.EmployeesManage, async (tx, ctx) => {
      await requireAccountingSettings(tx, ctx.organizationId);
      const userId = await this.validateEmployee(tx, ctx.organizationId, input, null);
      const now = this.now;
      const created = await insertEmployee(tx, {
        organizationId: ctx.organizationId,
        number: await takeNextPayrollNumber(tx, ctx.organizationId, 'employee'),
        displayName: input.displayName.trim(),
        email: input.email?.trim() || null,
        nationalId: input.nationalId?.trim() || null,
        userId,
        hireDate: input.hireDate,
        terminationDate: input.terminationDate || null,
        basicSalary: decimal(input.basicSalary).toFixed(4),
        bankAccountRef: input.bankAccountRef?.trim() || null,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await insertSalaryChange(tx, {
        organizationId: ctx.organizationId,
        employeeId: created.id,
        effectiveFrom: input.hireDate,
        basicSalary: decimal(input.basicSalary).toFixed(4),
        reason: 'Opening salary',
        createdByUserId: ctx.userId,
        createdAt: now,
      });
      await replaceEmployeeComponents(
        tx,
        ctx.organizationId,
        created.id,
        input.components.map((c) => ({
          componentId: c.componentId,
          value: c.value === null || c.value === undefined ? null : decimal(c.value).toFixed(6),
        })),
      );
      await this.audit(
        tx,
        ctx,
        'payroll.employee_created',
        'payroll_employee',
        created.id,
        origin,
        {
          number: created.number,
          components: input.components.length,
        },
      );
      return this.employeeView(tx, ctx.organizationId, created);
    });
  }

  updateEmployee(
    principal: Principal,
    id: string,
    input: EmployeeInput & { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.EmployeesManage, async (tx, ctx) => {
      const existing = await getEmployee(tx, ctx.organizationId, id);
      if (!existing) throw new NotFoundError('Employee not found.');
      const userId = await this.validateEmployee(tx, ctx.organizationId, input, id);
      let mirrorSalary = decimal(input.basicSalary).toFixed(4);
      if (decimal(existing.basicSalary).toFixed(4) !== mirrorSalary) {
        const history = salaryTimeline(await salaryHistoryOf(tx, ctx.organizationId, [id]));
        let effectiveFrom: string;
        if (input.salaryEffectiveFrom) {
          effectiveFrom = input.salaryEffectiveFrom;
          if (!isValidIsoDate(effectiveFrom) || effectiveFrom < input.hireDate) {
            throw new ValidationError([
              {
                path: 'salaryEffectiveFrom',
                message: 'Enter a valid date on or after the hire date.',
              },
            ]);
          }
          const closed = await latestPostedPeriodEnd(tx, ctx.organizationId);
          if (closed && effectiveFrom <= closed) {
            throw new ValidationError([
              {
                path: 'salaryEffectiveFrom',
                message: `A pay run is already posted up to ${closed}: a salary change must take effect after it.`,
              },
            ]);
          }
        } else {
          // No date: the salary entered replaces the current salary (a correction).
          effectiveFrom = history[history.length - 1]?.from ?? input.hireDate;
        }
        await insertSalaryChange(tx, {
          organizationId: ctx.organizationId,
          employeeId: id,
          effectiveFrom,
          basicSalary: mirrorSalary,
          reason: (input.salaryReason ?? '').trim().slice(0, 500),
          createdByUserId: ctx.userId,
          createdAt: this.now,
        });
        const timeline = salaryTimeline(await salaryHistoryOf(tx, ctx.organizationId, [id]));
        mirrorSalary = decimal(timeline[timeline.length - 1]!.salary).toFixed(4);
      }
      const updated = await updateEmployee(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          displayName: input.displayName.trim(),
          email: input.email?.trim() || null,
          // Omitted keeps the stored value; an empty string clears it.
          ...(input.nationalId === undefined
            ? {}
            : { nationalId: input.nationalId?.trim() || null }),
          userId,
          hireDate: input.hireDate,
          terminationDate: input.terminationDate || null,
          basicSalary: mirrorSalary,
          bankAccountRef: input.bankAccountRef?.trim() || null,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('employee');
      await replaceEmployeeComponents(
        tx,
        ctx.organizationId,
        id,
        input.components.map((c) => ({
          componentId: c.componentId,
          value: c.value === null || c.value === undefined ? null : decimal(c.value).toFixed(6),
        })),
      );
      await this.audit(tx, ctx, 'payroll.employee_updated', 'payroll_employee', id, origin, {
        number: updated.number,
        salaryChanged:
          decimal(existing.basicSalary).toFixed(4) !== decimal(updated.basicSalary).toFixed(4),
        terminated: updated.terminationDate !== null,
      });
      return this.employeeView(tx, ctx.organizationId, updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------------

  private runView(r: PayrollRun) {
    return {
      id: r.id,
      number: r.number,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      payDate: r.payDate,
      status: r.status,
      employeeCount: r.employeeCount,
      grossTotal: decimal(r.grossTotal).toFixed(),
      deductionsTotal: decimal(r.deductionsTotal).toFixed(),
      netTotal: decimal(r.netTotal).toFixed(),
      employerCostTotal: decimal(r.employerCostTotal).toFixed(),
      createdByUserId: r.createdByUserId,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      journalId: r.journalId,
      postedAt: r.postedAt?.toISOString() ?? null,
      paymentAccountId: r.paymentAccountId,
      paymentDate: r.paymentDate,
      paymentJournalId: r.paymentJournalId,
      paidAt: r.paidAt?.toISOString() ?? null,
      voidReason: r.voidReason,
      voidJournalId: r.voidJournalId,
      version: r.version,
    };
  }

  private async payslipViews(tx: Transaction, organizationId: string, runId: string) {
    const slips = await listPayslips(tx, organizationId, runId);
    const lines = await listPayslipLines(
      tx,
      organizationId,
      slips.map((s) => s.id),
    );
    return slips.map((s) => ({
      id: s.id,
      employeeId: s.employeeId,
      employeeNumber: s.employeeNumber,
      employeeName: s.employeeName,
      basicSalary: decimal(s.basicSalary).toFixed(),
      prorationFactor: decimal(s.prorationFactor).toFixed(),
      gross: decimal(s.gross).toFixed(),
      deductions: decimal(s.deductions).toFixed(),
      net: decimal(s.net).toFixed(),
      employerCost: decimal(s.employerCost).toFixed(),
      salarySegments: s.salarySegments ?? null,
      lines: lines
        .filter((l) => l.payslipId === s.id)
        .map((l) => ({
          lineNo: l.lineNo,
          kind: l.kind,
          code: l.code,
          name: l.name,
          amount: decimal(l.amount).toFixed(),
        })),
    }));
  }

  private async detail(tx: Transaction, organizationId: string, run: PayrollRun) {
    return { ...this.runView(run), payslips: await this.payslipViews(tx, organizationId, run.id) };
  }

  listRuns(principal: Principal, limit: number) {
    return this.run(
      principal,
      PayrollPermissions.View,
      async (tx, ctx) =>
        (await listRuns(tx, ctx.organizationId, limit)).map((r) => this.runView(r)),
      { readOnly: true },
    );
  }

  /** A pay run with its payslips shows every employee's pay, so opening it is audited. */
  getRun(principal: Principal, id: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, id);
      if (!run) throw new NotFoundError('Pay run not found.');
      await this.audit(tx, ctx, 'payroll.run_viewed', 'payroll_run', id, origin, {
        number: run.number,
      });
      return this.detail(tx, ctx.organizationId, run);
    });
  }

  /** Calculates every payslip of a period from the current employees and components. */
  private async calculate(
    tx: Transaction,
    organizationId: string,
    period: { start: string; end: string },
    adjustments: readonly RunAdjustment[] = [],
  ) {
    const settings = await getPayrollSettings(tx, organizationId);
    if (!settings?.basicSalaryExpenseAccountId || !settings.netPayPayableAccountId) {
      throw new ValidationError([
        {
          path: 'settings',
          message:
            'Choose the basic salary expense and net pay payable accounts in Payroll settings first.',
        },
      ]);
    }
    const accounting = await requireAccountingSettings(tx, organizationId);
    const scale = minorUnits(accounting.baseCurrency);
    const employees = (await listEmployees(tx, organizationId)).filter(
      (e) => employedDays(e, period) > 0,
    );
    if (!employees.length) {
      throw new ValidationError([
        { path: 'periodStart', message: 'No employee was employed during this period.' },
      ]);
    }
    if (employees.length > MAX_EMPLOYEES_PER_RUN) {
      throw new ValidationError([
        { path: 'periodStart', message: 'Too many employees for one run.' },
      ]);
    }
    const components = new Map<string, PayrollComponent>(
      (await listComponents(tx, organizationId)).map((c) => [c.id, c]),
    );
    const assigned = await listEmployeeComponents(
      tx,
      organizationId,
      employees.map((e) => e.id),
    );
    const history = await salaryHistoryOf(
      tx,
      organizationId,
      employees.map((e) => e.id),
    );
    const salaryOf = (employeeId: string, fallback: string) => {
      const timeline = salaryTimeline(history.filter((h) => h.employeeId === employeeId));
      if (!timeline.length) return { salary: fallback, timeline: undefined };
      // Day-proration splits a change inside the period; otherwise the salary at period end applies.
      return settings.proration === 'calendar_days'
        ? { salary: salaryOn(timeline, period.start), timeline }
        : { salary: salaryOn(timeline, period.end), timeline: undefined };
    };
    const inputs: EmployeeForPayroll[] = employees.map((e) => ({
      id: e.id,
      number: e.number,
      name: e.displayName,
      hireDate: e.hireDate,
      terminationDate: e.terminationDate,
      basicSalary: salaryOf(e.id, e.basicSalary).salary,
      salaryTimeline: salaryOf(e.id, e.basicSalary).timeline,
      components: assigned
        .filter((a) => a.employeeId === e.id)
        .flatMap((a) => {
          const c = components.get(a.componentId);
          if (!c || !c.isActive) return [];
          const definition: ComponentDefinition = {
            id: c.id,
            code: c.code,
            name: c.name,
            kind: c.kind,
            calculation: c.calculation,
            expenseAccountId: c.expenseAccountId,
            liabilityAccountId: c.liabilityAccountId,
          };
          return [{ component: definition, value: a.value ?? c.defaultValue }];
        }),
    }));
    // One-off amounts entered for this run (bonus, commission, overtime pay) become extra lines.
    for (const adjustment of adjustments) {
      const target = inputs.find((i) => i.id === adjustment.employeeId);
      const c = components.get(adjustment.componentId);
      if (!target || !c || !c.isActive) continue;
      target.components = [
        ...target.components,
        {
          component: {
            id: c.id,
            code: c.code,
            name: c.name,
            kind: c.kind,
            calculation: 'fixed',
            expenseAccountId: c.expenseAccountId,
            liabilityAccountId: c.liabilityAccountId,
          },
          value: decimal(adjustment.amount).toFixed(),
        },
      ];
    }
    // Instalments of salary advances still outstanding become 'ADV' deduction lines that credit the
    // advances account (migration 0073). The cap is the outstanding balance.
    const advances = await activeAdvancesFor(
      tx,
      organizationId,
      employees.map((e) => e.id),
      period.end,
    );
    if (advances.length) {
      if (!settings.advancesAccountId) {
        throw new ValidationError([
          {
            path: 'settings',
            message: 'Choose the employee advances account in Payroll settings first.',
          },
        ]);
      }
      const repaid = await repaidAmounts(
        tx,
        organizationId,
        advances.map((x) => x.id),
      );
      for (const advance of advances) {
        const outstanding = decimal(advance.principal).minus(repaid.get(advance.id) ?? 0);
        if (!outstanding.gt(0)) continue;
        const target = inputs.find((i) => i.id === advance.employeeId);
        if (!target) continue;
        const installment = decimal(advance.installment);
        const definition: ComponentDefinition = {
          id: advance.id,
          code: 'ADV',
          name: `Advance recovery ${advance.number}`,
          kind: 'deduction',
          calculation: 'fixed',
          expenseAccountId: null,
          liabilityAccountId: settings.advancesAccountId,
        };
        target.components = [
          ...target.components,
          {
            component: definition,
            value: (installment.lt(outstanding) ? installment : outstanding).toFixed(),
          },
        ];
      }
    }
    const issues: ValidationIssue[] = [];
    const slips: { employee: PayrollEmployee; result: PayslipResult }[] = [];
    for (const [i, input] of inputs.entries()) {
      try {
        const result = calculatePayslip(input, period, { proration: settings.proration, scale });
        if (result) slips.push({ employee: employees[i]!, result });
      } catch (error) {
        if (error instanceof NegativeNetPay) {
          issues.push({
            path: 'employees',
            message: `${input.name} (${input.number}): deductions ${error.deductions} exceed gross pay ${error.gross}.`,
          });
        } else {
          throw error;
        }
      }
    }
    if (issues.length) throw new ValidationError(issues, 'The pay run cannot be calculated.');
    return { slips, scale, settings };
  }

  private totalsOf(slips: readonly { result: PayslipResult }[], scale: number) {
    const sum = (pick: (r: PayslipResult) => string) =>
      slips.reduce((acc, s) => acc.plus(pick(s.result)), decimal(0)).toFixed(scale);
    return {
      employeeCount: slips.length,
      grossTotal: sum((r) => r.gross),
      deductionsTotal: sum((r) => r.deductions),
      netTotal: sum((r) => r.net),
      employerCostTotal: sum((r) => r.employerCost),
    };
  }

  private async storePayslips(
    tx: Transaction,
    organizationId: string,
    runId: string,
    slips: readonly { employee: PayrollEmployee; result: PayslipResult }[],
  ) {
    for (const { employee, result } of slips) {
      const payslip = await insertPayslip(tx, {
        organizationId,
        runId,
        employeeId: employee.id,
        employeeNumber: employee.number,
        employeeName: employee.displayName,
        employeeUserId: employee.userId,
        basicSalary: result.basic,
        prorationFactor: result.prorationFactor,
        gross: result.gross,
        deductions: result.deductions,
        net: result.net,
        employerCost: result.employerCost,
        salarySegments: result.salarySegments,
      });
      await insertPayslipLines(
        tx,
        result.lines.map((l, i) => ({
          organizationId,
          payslipId: payslip.id,
          lineNo: i + 1,
          componentId: l.componentId,
          code: l.code,
          name: l.name,
          kind: l.kind,
          amount: l.amount,
          expenseAccountId: l.expenseAccountId,
          liabilityAccountId: l.liabilityAccountId,
        })),
      );
    }
  }

  private validatePeriod(input: { periodStart: string; periodEnd: string; payDate: string }) {
    const issues: ValidationIssue[] = [];
    for (const key of ['periodStart', 'periodEnd', 'payDate'] as const) {
      if (!isValidIsoDate(input[key])) {
        issues.push({ path: key, message: 'Enter a valid date (YYYY-MM-DD).' });
      }
    }
    if (!issues.length) {
      if (input.periodStart > input.periodEnd) {
        issues.push({ path: 'periodStart', message: 'The start date is after the end date.' });
      }
      const days = (Date.parse(input.periodEnd) - Date.parse(input.periodStart)) / 86_400_000 + 1;
      if (days > 366)
        issues.push({ path: 'periodEnd', message: 'A pay period is at most a year.' });
      if (input.payDate < input.periodStart) {
        issues.push({ path: 'payDate', message: 'The pay date is before the period starts.' });
      }
    }
    if (issues.length) throw new ValidationError(issues);
  }

  createRun(
    principal: Principal,
    input: { periodStart: string; periodEnd: string; payDate: string },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.RunsCreate, (tx, ctx) =>
      this.idempotency.run(
        tx,
        ctx,
        { key: options.idempotencyKey, scope: 'payroll.run.create', request: input },
        async () => {
          this.validatePeriod(input);
          // Serialize run creation per organization so two racing requests see each other.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-run:${ctx.organizationId}`}, 0))`,
          );
          const period = { start: input.periodStart, end: input.periodEnd };
          const overlap = await overlappingRun(tx, ctx.organizationId, period);
          if (overlap) {
            throw new ConflictError(
              'CONFLICT',
              `Pay run ${overlap.number} already covers part of this period (${overlap.periodStart} to ${overlap.periodEnd}). Void it first.`,
            );
          }
          const { slips, scale } = await this.calculate(tx, ctx.organizationId, period);
          const now = this.now;
          const run = await insertRun(tx, {
            organizationId: ctx.organizationId,
            number: await takeNextPayrollNumber(tx, ctx.organizationId, 'run'),
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            payDate: input.payDate,
            ...this.totalsOf(slips, scale),
            createdByUserId: ctx.userId,
            createdAt: now,
            updatedAt: now,
          });
          await this.storePayslips(tx, ctx.organizationId, run.id, slips);
          await this.audit(tx, ctx, 'payroll.run_created', 'payroll_run', run.id, origin, {
            number: run.number,
            periodStart: run.periodStart,
            periodEnd: run.periodEnd,
            employees: run.employeeCount,
          });
          return this.detail(tx, ctx.organizationId, run);
        },
      ),
    );
  }

  recalculateRun(
    principal: Principal,
    id: string,
    input: { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.RunsCreate, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
      if (!run) throw new NotFoundError('Pay run not found.');
      if (run.version !== input.version) throw versionConflict('pay run');
      if (run.status !== 'DRAFT') throw invalidState('Only a draft pay run can be recalculated.');
      const updated = await this.rebuildDraft(tx, ctx, run);
      await this.audit(tx, ctx, 'payroll.run_recalculated', 'payroll_run', id, origin, {
        number: updated.number,
        employees: updated.employeeCount,
        net: updated.netTotal,
      });
      return this.detail(tx, ctx.organizationId, updated);
    });
  }

  /** Recomputes the payslips of a DRAFT run (with its adjustments) at the run's current version. */
  private async rebuildDraft(tx: Transaction, ctx: AuthorizationContext, run: PayrollRun) {
    const adjustments = await listRunAdjustments(tx, ctx.organizationId, run.id);
    const { slips, scale } = await this.calculate(
      tx,
      ctx.organizationId,
      { start: run.periodStart, end: run.periodEnd },
      adjustments,
    );
    await deleteRunPayslips(tx, ctx.organizationId, run.id);
    await this.storePayslips(tx, ctx.organizationId, run.id, slips);
    const updated = await updateRun(tx, {
      organizationId: ctx.organizationId,
      id: run.id,
      version: run.version,
      set: { ...this.totalsOf(slips, scale), updatedByUserId: ctx.userId, updatedAt: this.now },
    });
    if (!updated) throw versionConflict('pay run');
    return updated;
  }

  private async adjustmentViews(tx: Transaction, organizationId: string, runId: string) {
    const [rows, employees, components] = await Promise.all([
      listRunAdjustments(tx, organizationId, runId),
      listEmployees(tx, organizationId),
      listComponents(tx, organizationId),
    ]);
    const employeeOf = new Map(employees.map((e) => [e.id, e]));
    const componentOf = new Map(components.map((c) => [c.id, c]));
    return rows.map((a) => ({
      id: a.id,
      employeeId: a.employeeId,
      employeeNumber: employeeOf.get(a.employeeId)?.number ?? null,
      employeeName: employeeOf.get(a.employeeId)?.displayName ?? null,
      componentId: a.componentId,
      componentCode: componentOf.get(a.componentId)?.code ?? null,
      componentName: componentOf.get(a.componentId)?.name ?? null,
      kind: componentOf.get(a.componentId)?.kind ?? null,
      amount: decimal(a.amount).toFixed(),
      note: a.note,
    }));
  }

  /** One-off amounts of a run (salary data, so the read is audited). */
  listAdjustments(principal: Principal, runId: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, runId);
      if (!run) throw new NotFoundError('Pay run not found.');
      await this.audit(tx, ctx, 'payroll.adjustments_viewed', 'payroll_run', runId, origin, {
        number: run.number,
      });
      return this.adjustmentViews(tx, ctx.organizationId, runId);
    });
  }

  /**
   * Adds a one-off amount (bonus, commission, overtime pay) for one employee to a DRAFT run and
   * recalculates it. The amount is entered by payroll staff; nothing is derived or statutory.
   */
  addAdjustment(
    principal: Principal,
    runId: string,
    input: { employeeId: string; componentId: string; amount: string; note?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, PayrollPermissions.RunsCreate, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, runId, { forUpdate: true });
      if (!run) throw new NotFoundError('Pay run not found.');
      if (run.status !== 'DRAFT') {
        throw invalidState('Amounts can only be added to a draft pay run.');
      }
      const issues: ValidationIssue[] = [];
      const employee = await getEmployee(tx, ctx.organizationId, input.employeeId);
      if (
        !employee ||
        employedDays(employee, { start: run.periodStart, end: run.periodEnd }) <= 0
      ) {
        issues.push({ path: 'employeeId', message: 'Choose an employee employed in this period.' });
      }
      const component = (await listComponents(tx, ctx.organizationId)).find(
        (c) => c.id === input.componentId,
      );
      if (
        !component ||
        !component.isActive ||
        component.calculation !== 'fixed' ||
        (component.kind !== 'earning' && component.kind !== 'deduction')
      ) {
        issues.push({
          path: 'componentId',
          message: 'Choose an active fixed-amount earning or deduction component.',
        });
      }
      const amount = (() => {
        try {
          return decimal(input.amount);
        } catch {
          return null;
        }
      })();
      if (!amount || !amount.gt(0) || amount.decimalPlaces() > 4 || amount.gt('1e15')) {
        issues.push({ path: 'amount', message: 'Enter an amount above zero (up to 4 decimals).' });
      }
      if (issues.length) throw new ValidationError(issues);
      const row = await insertRunAdjustment(tx, {
        organizationId: ctx.organizationId,
        runId,
        employeeId: input.employeeId,
        componentId: input.componentId,
        amount: amount!.toFixed(4),
        note: (input.note ?? '').trim(),
        createdByUserId: ctx.userId,
        createdAt: this.now,
      });
      // A payslip that would pay less than nothing rolls the whole change back with the usual error.
      const updated = await this.rebuildDraft(tx, ctx, run);
      // Amounts are salary data: the audit names the employee number and component, not the sum.
      await this.audit(tx, ctx, 'payroll.adjustment_added', 'payroll_run', runId, origin, {
        number: updated.number,
        employeeNumber: employee!.number,
        component: component!.code,
        adjustmentId: row.id,
      });
      return this.detail(tx, ctx.organizationId, updated);
    });
  }

  removeAdjustment(principal: Principal, runId: string, adjustmentId: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.RunsCreate, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, runId, { forUpdate: true });
      if (!run) throw new NotFoundError('Pay run not found.');
      if (run.status !== 'DRAFT') {
        throw invalidState('Amounts can only be removed from a draft pay run.');
      }
      const removed = await deleteRunAdjustment(tx, ctx.organizationId, runId, adjustmentId);
      if (!removed) throw new NotFoundError('Adjustment not found.');
      const updated = await this.rebuildDraft(tx, ctx, run);
      await this.audit(tx, ctx, 'payroll.adjustment_removed', 'payroll_run', runId, origin, {
        number: updated.number,
        adjustmentId,
      });
      return this.detail(tx, ctx.organizationId, updated);
    });
  }

  approveRun(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.run(
      principal,
      PayrollPermissions.RunsApprove,
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
        if (!run) throw new NotFoundError('Pay run not found.');
        if (run.version !== input.version) throw versionConflict('pay run');
        if (run.status !== 'DRAFT') throw invalidState('Only a draft pay run can be approved.');
        const settings = await getPayrollSettings(tx, ctx.organizationId);
        if ((settings?.requireSeparateApprover ?? true) && run.createdByUserId === ctx.userId) {
          throw new AppError(
            'SELF_APPROVAL_PROHIBITED',
            403,
            'A pay run cannot be approved by the person who prepared it.',
          );
        }
        const updated = await updateRun(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'APPROVED',
            approvedByUserId: ctx.userId,
            approvedAt: this.now,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('pay run');
        await this.audit(tx, ctx, 'payroll.run_approved', 'payroll_run', id, origin, {
          number: updated.number,
          net: updated.netTotal,
        });
        return this.detail(tx, ctx.organizationId, updated);
      },
      { sensitive: true },
    );
  }

  postRun(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.run(
      principal,
      PayrollPermissions.RunsPost,
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
        if (!run) throw new NotFoundError('Pay run not found.');
        if (run.version !== input.version) throw versionConflict('pay run');
        if (run.status !== 'APPROVED')
          throw invalidState('Only an approved pay run can be posted.');
        const settings = await getPayrollSettings(tx, ctx.organizationId);
        if (!settings?.basicSalaryExpenseAccountId || !settings.netPayPayableAccountId) {
          throw new ValidationError([
            { path: 'settings', message: 'Choose the payroll accounts in Payroll settings first.' },
          ]);
        }
        await assertOpenPeriod(tx, ctx.organizationId, run.periodEnd);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const scale = minorUnits(accounting.baseCurrency);
        const slips = await this.payslipViews(tx, ctx.organizationId, id);
        const stored = await listPayslipLines(
          tx,
          ctx.organizationId,
          (await listPayslips(tx, ctx.organizationId, id)).map((s) => s.id),
        );
        const results: PayslipResult[] = slips.map((s) => ({
          employeeId: s.employeeId,
          prorationFactor: s.prorationFactor,
          basic: s.basicSalary,
          gross: s.gross,
          deductions: s.deductions,
          net: s.net,
          employerCost: s.employerCost,
          salarySegments: s.salarySegments,
          lines: stored
            .filter((l) => l.payslipId === s.id)
            .map((l) => ({
              kind: l.kind,
              componentId: l.componentId,
              code: l.code,
              name: l.name,
              amount: decimal(l.amount).toFixed(scale),
              expenseAccountId: l.expenseAccountId,
              liabilityAccountId: l.liabilityAccountId,
            })),
        }));
        const posting = buildRunPosting(
          results,
          {
            basicSalaryExpenseAccountId: settings.basicSalaryExpenseAccountId,
            netPayPayableAccountId: settings.netPayPayableAccountId,
          },
          scale,
        );
        const text = `Payroll ${run.number} — ${run.periodStart} to ${run.periodEnd}`;
        const event = await this.journals.receiveEventInTransaction(tx, {
          organizationId: ctx.organizationId,
          sourceModule: 'payroll',
          eventType: PAYROLL_RUN_EVENT,
          eventKey: `payroll_run:${id}:posted`,
          payload: {
            runId: id,
            number: run.number,
            journal: {
              entryDate: run.periodEnd,
              description: text,
              reference: run.number,
              currency: accounting.baseCurrency,
              exchangeRate: null,
              sourceRef: { module: 'payroll', type: 'run', id },
              lines: posting.map((l) => ({
                accountId: l.accountId,
                description: text,
                debit: l.debit,
                credit: l.credit,
                dimensions: [],
              })),
            },
          },
          occurredAt: this.now,
          origin,
        });
        if (!event.journalId) {
          throw new AppError('CONFLICT', 409, 'The pay run was not posted; try again.');
        }
        const updated = await updateRun(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'POSTED',
            journalId: event.journalId,
            accountingEventId: event.eventId,
            postedByUserId: ctx.userId,
            postedAt: this.now,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('pay run');
        // Recovered advance instalments (lines coded ADV carry the advance id).
        await insertRepayments(
          tx,
          stored
            .filter((l) => l.kind === 'deduction' && l.code === 'ADV' && l.componentId)
            .map((l) => ({
              organizationId: ctx.organizationId,
              advanceId: l.componentId!,
              runId: id,
              payslipId: l.payslipId,
              amount: l.amount,
              createdAt: this.now,
            })),
        );
        await this.audit(tx, ctx, 'payroll.run_posted', 'payroll_run', id, origin, {
          number: updated.number,
          journalId: event.journalId,
          gross: updated.grossTotal,
          net: updated.netTotal,
        });
        return this.detail(tx, ctx.organizationId, updated);
      },
      { sensitive: true },
    );
  }

  payRun(
    principal: Principal,
    id: string,
    input: { version: number; bankAccountId: string; paymentDate: string },
    origin: EventOrigin,
  ) {
    return this.run(
      principal,
      PayrollPermissions.RunsPay,
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
        if (!run) throw new NotFoundError('Pay run not found.');
        if (run.version !== input.version) throw versionConflict('pay run');
        if (run.status !== 'POSTED') throw invalidState('Only a posted pay run can be paid.');
        const issues: ValidationIssue[] = [];
        if (!isValidIsoDate(input.paymentDate)) {
          issues.push({ path: 'paymentDate', message: 'Enter a valid date (YYYY-MM-DD).' });
        } else if (input.paymentDate < run.periodEnd) {
          issues.push({
            path: 'paymentDate',
            message: 'The payment is dated before the period ends.',
          });
        }
        const bankIssue = await this.accountIssue(
          tx,
          ctx.organizationId,
          input.bankAccountId,
          'bank',
          'bankAccountId',
        );
        if (bankIssue) issues.push(bankIssue);
        if (!decimal(run.netTotal).gt(0)) {
          issues.push({ path: 'version', message: 'There is no net pay to pay out.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const settings = await getPayrollSettings(tx, ctx.organizationId);
        await assertOpenPeriod(tx, ctx.organizationId, input.paymentDate);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const scale = minorUnits(accounting.baseCurrency);
        const amount = decimal(run.netTotal).toFixed(scale);
        const text = `Payroll payment ${run.number}`;
        const event = await this.journals.receiveEventInTransaction(tx, {
          organizationId: ctx.organizationId,
          sourceModule: 'payroll',
          eventType: PAYROLL_PAYMENT_EVENT,
          eventKey: `payroll_run:${id}:paid`,
          payload: {
            runId: id,
            number: run.number,
            journal: {
              entryDate: input.paymentDate,
              description: text,
              reference: run.number,
              currency: accounting.baseCurrency,
              exchangeRate: null,
              sourceRef: { module: 'payroll', type: 'run', id },
              lines: [
                {
                  accountId: settings!.netPayPayableAccountId!,
                  description: text,
                  debit: amount,
                  credit: null,
                  dimensions: [],
                },
                {
                  accountId: input.bankAccountId,
                  description: text,
                  debit: null,
                  credit: amount,
                  dimensions: [],
                },
              ],
            },
          },
          occurredAt: this.now,
          origin,
        });
        if (!event.journalId) {
          throw new AppError('CONFLICT', 409, 'The payment was not posted; try again.');
        }
        const updated = await updateRun(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'PAID',
            paymentAccountId: input.bankAccountId,
            paymentDate: input.paymentDate,
            paymentJournalId: event.journalId,
            paymentEventId: event.eventId,
            paidByUserId: ctx.userId,
            paidAt: this.now,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('pay run');
        await this.audit(tx, ctx, 'payroll.run_paid', 'payroll_run', id, origin, {
          number: updated.number,
          net: updated.netTotal,
          paymentJournalId: event.journalId,
        });
        return this.detail(tx, ctx.organizationId, updated);
      },
      { sensitive: true },
    );
  }

  voidRun(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return this.run(
      principal,
      PayrollPermissions.RunsVoid,
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
        if (!run) throw new NotFoundError('Pay run not found.');
        if (run.version !== input.version) throw versionConflict('pay run');
        if (run.status === 'VOID') throw invalidState('The pay run is already void.');
        if (run.status === 'PAID') {
          throw invalidState(
            'A paid pay run is final. Correct it with a manual journal, or void future runs.',
          );
        }
        const reason = input.reason.trim();
        if (!reason) throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
        let voidJournalId: string | null = null;
        if (run.status === 'POSTED') {
          const reversal = await this.journals.reverseSubledgerJournalInTransaction(
            tx,
            ctx,
            'payroll',
            run.journalId!,
            { reason: `Pay run ${run.number} voided: ${reason}` },
            origin,
          );
          voidJournalId = reversal.id;
        }
        const updated = await updateRun(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: this.now,
            voidReason: reason,
            voidJournalId,
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('pay run');
        await this.audit(tx, ctx, 'payroll.run_voided', 'payroll_run', id, origin, {
          number: updated.number,
          reason,
          reversalJournalId: voidJournalId,
        });
        return this.detail(tx, ctx.organizationId, updated);
      },
      { sensitive: true },
    );
  }

  /** The salary decisions of one employee, newest effective date first. */
  salaryHistory(principal: Principal, employeeId: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const employee = await getEmployee(tx, ctx.organizationId, employeeId);
      if (!employee) throw new NotFoundError('Employee not found.');
      await this.audit(
        tx,
        ctx,
        'payroll.salary_history_viewed',
        'payroll_employee',
        employeeId,
        origin,
        { number: employee.number },
      );
      return (await listSalaryHistory(tx, ctx.organizationId, employeeId)).map((h) => ({
        id: h.id,
        effectiveFrom: h.effectiveFrom,
        basicSalary: decimal(h.basicSalary).toFixed(),
        reason: h.reason,
        createdAt: h.createdAt.toISOString(),
      }));
    });
  }

  /**
   * Tells employees that their payslip is available ("sign in to view it"). The message carries no
   * figures. It goes only to employees with an e-mail address AND a linked account (they can read
   * the payslip there), once per payslip. Sending the payslip itself by e-mail is not built (it
   * needs the employee's consent and secure storage, see docs/open-decisions.md).
   */
  notifyPayslips(principal: Principal, runId: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.RunsPay, async (tx, ctx) => {
      const run = await getRun(tx, ctx.organizationId, runId);
      if (!run) throw new NotFoundError('Pay run not found.');
      if (run.status !== 'POSTED' && run.status !== 'PAID') {
        throw new ConflictError(
          'INVALID_STATE_TRANSITION',
          'Payslips can be announced only once the pay run is posted.',
        );
      }
      const slips = await listPayslips(tx, ctx.organizationId, runId);
      const employees = new Map(
        (await listEmployees(tx, ctx.organizationId)).map((e) => [e.id, e]),
      );
      const result = {
        sent: 0,
        alreadySent: 0,
        skipped: [] as { employee: string; reason: string }[],
        failed: 0,
      };
      for (const slip of slips) {
        const employee = employees.get(slip.employeeId);
        if (await sentNotificationFor(tx, ctx.organizationId, slip.id)) {
          result.alreadySent += 1;
          continue;
        }
        if (!employee?.email) {
          result.skipped.push({ employee: slip.employeeName, reason: 'no e-mail address' });
          continue;
        }
        if (!employee.userId) {
          result.skipped.push({ employee: slip.employeeName, reason: 'not linked to a sign-in' });
          continue;
        }
        let error: string | null = null;
        try {
          await this.deps.emailProvider.send({
            to: employee.email,
            subject: `Your payslip for ${run.periodStart} to ${run.periodEnd} is available`,
            text: `Your payslip for ${run.periodStart} to ${run.periodEnd} is available. Sign in to view it: ${this.deps.config.webOrigin.replace(/\/$/, '')}/payroll/my-payslips`,
            template: 'payroll.payslip_available',
          });
        } catch (e) {
          error = (e instanceof Error ? e.message : 'send failed').slice(0, 300);
        }
        await insertNotification(tx, {
          organizationId: ctx.organizationId,
          payslipId: slip.id,
          employeeId: slip.employeeId,
          status: error ? 'FAILED' : 'SENT',
          error,
          sentByUserId: ctx.userId,
          createdAt: this.now,
        });
        if (error) result.failed += 1;
        else result.sent += 1;
      }
      await this.audit(tx, ctx, 'payroll.payslips_announced', 'payroll_run', runId, origin, {
        number: run.number,
        sent: result.sent,
        failed: result.failed,
        skipped: result.skipped.length,
      });
      return result;
    });
  }

  // ---------------------------------------------------------------------------
  // Payslips
  // ---------------------------------------------------------------------------

  /** The caller's own payslips from posted and paid runs; needs no payroll permission. */
  myPayslips(principal: Principal) {
    return this.run(
      principal,
      undefined,
      async (tx, ctx) => {
        const rows = await listPayslipsOfUser(tx, ctx.organizationId, ctx.userId);
        const lines = await listPayslipLines(
          tx,
          ctx.organizationId,
          rows.map((r) => r.payslip.id),
        );
        return rows.map(({ payslip: s, run }) => ({
          id: s.id,
          runNumber: run.number,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          payDate: run.payDate,
          runStatus: run.status,
          basicSalary: decimal(s.basicSalary).toFixed(),
          gross: decimal(s.gross).toFixed(),
          deductions: decimal(s.deductions).toFixed(),
          net: decimal(s.net).toFixed(),
          lines: lines
            .filter((l) => l.payslipId === s.id && l.kind !== 'employer_contribution')
            .map((l) => ({
              kind: l.kind,
              code: l.code,
              name: l.name,
              amount: decimal(l.amount).toFixed(),
            })),
        }));
      },
      { readOnly: true },
    );
  }

  /**
   * A PDF of one payslip, rendered on request from the frozen payslip rows (nothing is stored).
   * `own`: the caller's own payslip of a posted or paid run, no payroll permission needed.
   * `any`: any payslip of the organization, for people with payroll.view (a draft run is marked
   * "not final"). Every download is audited.
   */
  payslipPdf(principal: Principal, id: string, scope: 'own' | 'any', origin: EventOrigin) {
    return this.run(
      principal,
      scope === 'any' ? PayrollPermissions.View : undefined,
      async (tx, ctx) => {
        if (!this.renderer) throw new ConflictError('CONFLICT', 'PDF output is not available.');
        let slipId = id;
        if (scope === 'own') {
          const mine = await listPayslipsOfUser(tx, ctx.organizationId, ctx.userId);
          if (!mine.some((m) => m.payslip.id === id)) throw new NotFoundError('Payslip not found.');
          slipId = id;
        }
        const slip = await getPayslip(tx, ctx.organizationId, slipId);
        if (!slip) throw new NotFoundError('Payslip not found.');
        const run = await getRun(tx, ctx.organizationId, slip.runId);
        if (!run) throw new NotFoundError('Payslip not found.');
        const view = (await this.payslipViews(tx, ctx.organizationId, run.id)).find(
          (v) => v.id === slipId,
        );
        if (!view) throw new NotFoundError('Payslip not found.');
        const [organization, accounting] = await Promise.all([
          getOrganization(tx, ctx.organizationId),
          requireAccountingSettings(tx, ctx.organizationId),
        ]);
        const content = await this.renderer.render({
          documentType: 'payslip',
          organizationName: organization?.name ?? '',
          currencyCode: accounting.baseCurrency,
          employeeName: view.employeeName,
          employeeNumber: view.employeeNumber,
          runNumber: run.number,
          periodStart: run.periodStart,
          periodEnd: run.periodEnd,
          payDate: run.payDate,
          runStatus: run.status,
          basicSalary: view.basicSalary,
          gross: view.gross,
          deductions: view.deductions,
          net: view.net,
          lines: view.lines
            .filter((l) => l.kind !== 'employer_contribution')
            .map((l) => ({ kind: l.kind, name: l.name, amount: l.amount })),
        });
        await this.audit(tx, ctx, 'payroll.payslip_downloaded', 'payroll_payslip', slipId, origin, {
          runId: run.id,
          scope,
        });
        return {
          fileName: `payslip-${run.number}-${view.employeeNumber}.pdf`.replace(
            /[^A-Za-z0-9._-]/g,
            '_',
          ),
          content,
        };
      },
    );
  }

  /** One payslip, for people with payroll.view (the employee uses `myPayslips`). */
  getPayslip(principal: Principal, id: string, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      const slip = await getPayslip(tx, ctx.organizationId, id);
      if (!slip) throw new NotFoundError('Payslip not found.');
      await this.audit(tx, ctx, 'payroll.payslip_viewed', 'payroll_payslip', id, origin, {
        employeeNumber: slip.employeeNumber,
      });
      const run = await getRun(tx, ctx.organizationId, slip.runId);
      const views = await this.payslipViews(tx, ctx.organizationId, slip.runId);
      return { run: run ? this.runView(run) : null, payslip: views.find((v) => v.id === id)! };
    });
  }

  /**
   * Payroll register: for posted and paid runs whose period ends inside the range, each employee's
   * totals and the totals per pay component. Facts only; no statutory figure is derived. Salary
   * data, so the read is audited.
   */
  registerReport(principal: Principal, input: { from: string; to: string }, origin: EventOrigin) {
    return this.run(principal, PayrollPermissions.View, async (tx, ctx) => {
      if (!isValidIsoDate(input.from) || !isValidIsoDate(input.to) || input.to < input.from) {
        throw new ValidationError([
          { path: 'to', message: 'Enter a valid range (from is not after to).' },
        ]);
      }
      const runs = (await listRuns(tx, ctx.organizationId, 500))
        .filter(
          (r) =>
            (r.status === 'POSTED' || r.status === 'PAID') &&
            r.periodEnd >= input.from &&
            r.periodEnd <= input.to,
        )
        .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.id.localeCompare(b.id));
      const zero = decimal(0);
      const employees = new Map<
        string,
        {
          employeeId: string;
          employeeNumber: string;
          employeeName: string;
          gross: ReturnType<typeof decimal>;
          deductions: ReturnType<typeof decimal>;
          net: ReturnType<typeof decimal>;
          employerCost: ReturnType<typeof decimal>;
        }
      >();
      const components = new Map<
        string,
        { code: string; name: string; kind: string; amount: ReturnType<typeof decimal> }
      >();
      for (const run of runs) {
        for (const slip of await this.payslipViews(tx, ctx.organizationId, run.id)) {
          const e = employees.get(slip.employeeId) ?? {
            employeeId: slip.employeeId,
            employeeNumber: slip.employeeNumber,
            employeeName: slip.employeeName,
            gross: zero,
            deductions: zero,
            net: zero,
            employerCost: zero,
          };
          e.gross = e.gross.plus(slip.gross);
          e.deductions = e.deductions.plus(slip.deductions);
          e.net = e.net.plus(slip.net);
          e.employerCost = e.employerCost.plus(slip.employerCost);
          employees.set(slip.employeeId, e);
          for (const line of slip.lines) {
            const key = `${line.kind}|${line.code}`;
            const c = components.get(key) ?? {
              code: line.code,
              name: line.name,
              kind: line.kind,
              amount: zero,
            };
            c.amount = c.amount.plus(line.amount);
            components.set(key, c);
          }
        }
      }
      await this.audit(
        tx,
        ctx,
        'payroll.register_viewed',
        'payroll_run',
        ctx.organizationId,
        origin,
        {
          from: input.from,
          to: input.to,
          runs: runs.length,
        },
      );
      const rows = [...employees.values()].sort((a, b) =>
        a.employeeNumber.localeCompare(b.employeeNumber),
      );
      const total = (f: (r: (typeof rows)[number]) => ReturnType<typeof decimal>) =>
        rows.reduce((sum, r) => sum.plus(f(r)), zero).toFixed();
      return {
        from: input.from,
        to: input.to,
        runs: runs.map((r) => ({
          id: r.id,
          number: r.number,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
          status: r.status,
        })),
        employees: rows.map((r) => ({
          employeeId: r.employeeId,
          employeeNumber: r.employeeNumber,
          employeeName: r.employeeName,
          gross: r.gross.toFixed(),
          deductions: r.deductions.toFixed(),
          net: r.net.toFixed(),
          employerCost: r.employerCost.toFixed(),
        })),
        components: [...components.values()]
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code))
          .map((c) => ({ code: c.code, name: c.name, kind: c.kind, amount: c.amount.toFixed() })),
        totals: {
          gross: total((r) => r.gross),
          deductions: total((r) => r.deductions),
          net: total((r) => r.net),
          employerCost: total((r) => r.employerCost),
        },
      };
    });
  }
}
