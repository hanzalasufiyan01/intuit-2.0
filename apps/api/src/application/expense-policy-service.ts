import { Decimal } from 'decimal.js';
import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import type { Transaction } from '../database/client.js';
import { getAccount } from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  getExpensePolicy,
  insertExpensePolicy,
  listExpensePolicies,
  updateExpensePolicy,
  type PolicyAction,
  type PolicyRuleType,
} from '../modules/expense-policies/index.js';
import { ExpensePermissions, PurchasesPermissions } from '../modules/purchases/index.js';
import { hasPermission } from './authorization.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Expense policies (migration 0092): organization-defined rules checked when an expense is posted
 * (see ExpenseService). Managing them needs `purchases.settings.manage`; anyone who can view
 * expenses can read them. Rules are archived, never deleted, and their type and account are fixed.
 */

const AMOUNT = /^(0|[1-9]\d{0,21})(\.\d{1,4})?$/;
const view = (p: {
  id: string;
  name: string;
  ruleType: string;
  amount: string;
  accountId: string | null;
  action: string;
  status: string;
  version: number;
}) => ({ ...p, amount: new Decimal(p.amount).toFixed() });

export class ExpensePolicyService {
  constructor(private readonly deps: AppDependencies) {}

  private audit(
    tx: Transaction,
    ctx: AuthorizationContext,
    action: string,
    id: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    return recordAuditEvent(tx, {
      occurredAt: this.deps.clock.now(),
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: 'expense_policy',
      resourceId: id,
      metadata,
      origin,
    });
  }

  list(principal: Principal) {
    return withOrganization(this.deps, principal, { readOnlySnapshot: true }, async (tx, ctx) => {
      if (
        !hasPermission(ctx, ExpensePermissions.View) &&
        !hasPermission(ctx, PurchasesPermissions.SettingsManage)
      ) {
        throw new PermissionDeniedError();
      }
      return (await listExpensePolicies(tx, ctx.organizationId)).map(view);
    });
  }

  create(
    principal: Principal,
    input: {
      name: string;
      ruleType: PolicyRuleType;
      amount: string;
      accountId?: string | null | undefined;
      action: PolicyAction;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.SettingsManage },
      async (tx, ctx) => {
        if (!AMOUNT.test(input.amount) || !new Decimal(input.amount).gt(0)) {
          throw new ValidationError([{ path: 'amount', message: 'Enter an amount above zero.' }]);
        }
        const accountId = input.accountId ?? null;
        if (accountId) {
          if (input.ruleType !== 'max_amount') {
            throw new ValidationError([
              { path: 'accountId', message: 'Only a limit rule can apply to one account.' },
            ]);
          }
          const account = await getAccount(tx, ctx.organizationId, accountId);
          if (!account || account.accountType !== 'EXPENSE' || account.status !== 'ACTIVE') {
            throw new ValidationError([
              { path: 'accountId', message: 'Choose an active expense account.' },
            ]);
          }
        }
        const row = await insertExpensePolicy(tx, {
          organizationId: ctx.organizationId,
          name: input.name.trim(),
          ruleType: input.ruleType,
          amount: new Decimal(input.amount).toFixed(4),
          accountId,
          action: input.action,
          userId: ctx.userId,
          at: this.deps.clock.now(),
        });
        if (!row) throw new ConflictError('CONFLICT', 'A policy with this name already exists.');
        await this.audit(tx, ctx, 'expense_policy.created', row.id, origin, {
          ruleType: row.ruleType,
          action: row.action,
        });
        return view(row);
      },
    );
  }

  update(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      amount?: string | undefined;
      action?: PolicyAction | undefined;
      status?: 'ACTIVE' | 'ARCHIVED' | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: PurchasesPermissions.SettingsManage },
      async (tx, ctx) => {
        const row = await getExpensePolicy(tx, ctx.organizationId, id);
        if (!row) throw new NotFoundError('The expense policy was not found.');
        if (
          input.amount !== undefined &&
          (!AMOUNT.test(input.amount) || !new Decimal(input.amount).gt(0))
        ) {
          throw new ValidationError([{ path: 'amount', message: 'Enter an amount above zero.' }]);
        }
        const set: {
          name?: string;
          amount?: string;
          action?: PolicyAction;
          status?: 'ACTIVE' | 'ARCHIVED';
        } = {};
        if (input.name !== undefined && input.name.trim() !== row.name)
          set.name = input.name.trim();
        if (input.amount !== undefined && !new Decimal(input.amount).eq(row.amount)) {
          set.amount = new Decimal(input.amount).toFixed(4);
        }
        if (input.action !== undefined && input.action !== row.action) set.action = input.action;
        if (input.status !== undefined && input.status !== row.status) set.status = input.status;
        if (!Object.keys(set).length) return view(row);
        let updated;
        try {
          updated = await updateExpensePolicy(tx, {
            organizationId: ctx.organizationId,
            id,
            version: input.version,
            set,
            userId: ctx.userId,
            at: this.deps.clock.now(),
          });
        } catch {
          throw new ConflictError('CONFLICT', 'A policy with this name already exists.');
        }
        if (!updated) {
          throw new ConflictError('VERSION_CONFLICT', 'The policy was changed by someone else.');
        }
        await this.audit(tx, ctx, 'expense_policy.updated', id, origin, {
          changed: Object.keys(set),
        });
        return view(updated);
      },
    );
  }
}
