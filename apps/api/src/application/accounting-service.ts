import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
import { isSupportedCurrency, parseRate } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  archiveAccount,
  createAccount,
  createFiscalYear,
  currentPeriod,
  deleteAccount,
  descendantAccountIds,
  findAccountByCode,
  generateMonthlyPeriods,
  getAccount,
  getAccountingSettings,
  getFiscalYear,
  getPeriod,
  hasChildAccounts,
  hasPostedJournals,
  isAccountReferencedOutsideDrafts,
  isValidIsoDate,
  addDays,
  listAccounts,
  listCoaTemplates,
  listExchangeRates,
  listFiscalYears,
  listJournals,
  listPeriods,
  closePeriod,
  countJournals,
  queryLedger,
  recordExchangeRate,
  reopenPeriod,
  setUpAccounting,
  updateAccount,
  updateBaseCurrency,
  validatePeriodLayout,
  wouldCreateCycle,
  type Account,
  type AccountType,
  type AccountWithFacts,
  type AccountingSettings,
  type FiscalYear,
  type Period,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import type { ApprovalService } from './approval-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

export const PERIOD_REOPEN_ACTION = 'accounting.period.reopen';

export class AccountingNotSetUpError extends AppError {
  constructor() {
    super(
      'ACCOUNTING_NOT_SET_UP',
      409,
      'Accounting has not been set up for this organization yet.',
    );
  }
}

/** Loads the organization's accounting settings or fails if setup has not happened. */
export async function requireAccountingSettings(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<AccountingSettings> {
  const settings = await getAccountingSettings(tx, organizationId, options);
  if (!settings) throw new AccountingNotSetUpError();
  return settings;
}

export function accountView(account: AccountWithFacts | Account) {
  return {
    id: account.id,
    code: account.code,
    name: account.name,
    description: account.description,
    type: account.accountType,
    parentId: account.parentId,
    status: account.status,
    isSystem: account.isSystem,
    ...('isLeaf' in account
      ? { isLeaf: account.isLeaf, usedInPostedJournals: account.usedInPostedJournals }
      : {}),
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
    archivedAt: account.archivedAt?.toISOString() ?? null,
  };
}

function periodView(period: Period) {
  return {
    id: period.id,
    fiscalYearId: period.fiscalYearId,
    number: period.periodNumber,
    name: period.name,
    startDate: period.startDate,
    endDate: period.endDate,
    status: period.status,
    closedAt: period.closedAt?.toISOString() ?? null,
    reopenedAt: period.reopenedAt?.toISOString() ?? null,
    reopenReason: period.reopenReason,
  };
}

function fiscalYearView(year: FiscalYear, periods?: Period[]) {
  return {
    id: year.id,
    name: year.name,
    startDate: year.startDate,
    endDate: year.endDate,
    createdAt: year.createdAt.toISOString(),
    ...(periods ? { periods: periods.map(periodView) } : {}),
  };
}

const issue = (path: string, message: string) => new ValidationError([{ path, message }]);

export class AccountingService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
  ) {
    approvals.register({
      actionKey: PERIOD_REOPEN_ACTION,
      label: 'Reopen a closed accounting period',
      subjectType: 'accounting_period',
      approverPermission: AccountingPermissions.PeriodsReopen,
      decisionRequiresReauth: true,
      onApproved: async (tx, { request, authz, now, origin }) => {
        const period = await reopenPeriod(tx, {
          organizationId: authz.organizationId,
          periodId: request.subjectId,
          userId: request.requestedByUserId,
          reason: request.reason ?? '',
          now,
        });
        if (!period)
          throw new ConflictError('INVALID_STATE_TRANSITION', 'The period is no longer closed.');
        await this.auditPeriodReopened(tx, authz, period, request.reason ?? '', origin, now, {
          requestedByUserId: request.requestedByUserId,
          approvalRequestId: request.id,
          finalApproverUserId: authz.userId,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: authz.organizationId,
          actorUserId: authz.userId,
          action: 'period.reopen_rejected',
          resourceType: 'accounting_period',
          resourceId: request.subjectId,
          metadata: { approvalRequestId: request.id, comment },
          origin,
        });
      },
    });
  }

  private get now() {
    return this.deps.clock.now();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  getSetup(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      if (
        !hasPermission(ctx, AccountingPermissions.Setup) &&
        !hasPermission(ctx, AccountingPermissions.AccountsView)
      ) {
        throw new PermissionDeniedError();
      }
      const settings = await getAccountingSettings(tx, ctx.organizationId);
      return {
        isSetUp: settings !== undefined,
        settings: settings
          ? {
              baseCurrency: settings.baseCurrency,
              coaTemplateKey: settings.coaTemplateKey,
              setupAt: settings.setupAt.toISOString(),
              baseCurrencyLocked: await hasPostedJournals(tx, ctx.organizationId),
            }
          : null,
        templates: await listCoaTemplates(tx),
      };
    });
  }

  setUp(
    principal: Principal,
    input: { baseCurrency: string; templateKey: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup, sensitive: true },
      async (tx, ctx) => {
        if (!isSupportedCurrency(input.baseCurrency))
          throw issue('baseCurrency', 'Unsupported currency.');
        const now = this.now;
        const result = await setUpAccounting(tx, {
          organizationId: ctx.organizationId,
          baseCurrency: input.baseCurrency,
          templateKey: input.templateKey,
          userId: ctx.userId,
          now,
        });
        if (result === 'unknown_template')
          throw issue('templateKey', 'Unknown chart-of-accounts template.');
        if (result === 'already_set_up') {
          throw new ConflictError('ACCOUNTING_ALREADY_SET_UP', 'Accounting is already set up.');
        }
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'accounting.setup_completed',
          resourceType: 'accounting_settings',
          resourceId: ctx.organizationId,
          metadata: {
            baseCurrency: input.baseCurrency,
            templateKey: input.templateKey,
            accountsCreated: result.accountsCreated,
          },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'accounting.setup_completed',
            aggregateType: 'organization',
            aggregateId: ctx.organizationId,
            organizationId: ctx.organizationId,
            payload: { baseCurrency: input.baseCurrency, templateKey: input.templateKey },
          },
          now,
        );
        return {
          baseCurrency: input.baseCurrency,
          templateKey: input.templateKey,
          accountsCreated: result.accountsCreated,
        };
      },
    );
  }

  /** The base currency is fixed once anything has been posted (decision A2). */
  updateSettings(principal: Principal, input: { baseCurrency: string }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup, sensitive: true },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId, {
          forUpdate: true,
        });
        if (!isSupportedCurrency(input.baseCurrency))
          throw issue('baseCurrency', 'Unsupported currency.');
        if (await hasPostedJournals(tx, ctx.organizationId)) {
          throw new ConflictError(
            'CONFLICT',
            'The base currency cannot change after journals have been posted.',
          );
        }
        await updateBaseCurrency(tx, ctx.organizationId, input.baseCurrency);
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'accounting.base_currency_changed',
          resourceType: 'accounting_settings',
          resourceId: ctx.organizationId,
          metadata: { from: settings.baseCurrency, to: input.baseCurrency },
          origin,
        });
        return { baseCurrency: input.baseCurrency };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Chart of accounts
  // ---------------------------------------------------------------------------

  listAccounts(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        return (await listAccounts(tx, ctx.organizationId)).map(accountView);
      },
    );
  }

  getAccount(principal: Principal, accountId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const account = await getAccount(tx, ctx.organizationId, accountId);
        if (!account) throw new NotFoundError('Account not found.');
        return accountView(account);
      },
    );
  }

  /** A parent must exist, share the type, and must not already carry non-draft postings. */
  private async assertValidParent(
    tx: Transaction,
    organizationId: string,
    parentId: string,
    accountType: AccountType,
    accountId?: string,
  ) {
    const parent = await getAccount(tx, organizationId, parentId);
    if (!parent) throw issue('parentId', 'The parent account does not exist.');
    if (parent.accountType !== accountType) {
      throw issue('parentId', 'A parent account must have the same account type.');
    }
    if (accountId && (await wouldCreateCycle(tx, organizationId, accountId, parentId))) {
      throw issue('parentId', 'An account cannot be placed under itself or its descendants.');
    }
    if (await isAccountReferencedOutsideDrafts(tx, organizationId, parentId)) {
      throw new ConflictError(
        'ACCOUNT_IN_USE',
        'This account has journal lines, so it cannot become a parent (parents are grouping nodes).',
      );
    }
  }

  createAccount(
    principal: Principal,
    input: {
      code: string;
      name: string;
      description: string;
      type: AccountType;
      parentId: string | null;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsCreate },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        if (input.parentId) {
          await this.assertValidParent(tx, ctx.organizationId, input.parentId, input.type);
        }
        const account = await createAccount(tx, {
          organizationId: ctx.organizationId,
          code: input.code,
          name: input.name,
          description: input.description,
          accountType: input.type,
          parentId: input.parentId,
          userId: ctx.userId,
        });
        if (!account)
          throw new ConflictError('CONFLICT', 'An account with this code already exists.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'account.created',
          resourceType: 'accounting_account',
          resourceId: account.id,
          metadata: {
            code: account.code,
            name: account.name,
            type: account.accountType,
            parentId: account.parentId,
          },
          origin,
        });
        return accountView(account);
      },
    );
  }

  updateAccount(
    principal: Principal,
    accountId: string,
    input: {
      code?: string | undefined;
      name?: string | undefined;
      description?: string | undefined;
      type?: AccountType | undefined;
      parentId?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsUpdate },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const account = await getAccount(tx, ctx.organizationId, accountId, { forUpdate: true });
        if (!account) throw new NotFoundError('Account not found.');
        const type = input.type ?? account.accountType;
        const parentId = input.parentId === undefined ? account.parentId : input.parentId;

        if (type !== account.accountType) {
          if (await isAccountReferencedOutsideDrafts(tx, ctx.organizationId, accountId)) {
            throw new ConflictError(
              'ACCOUNT_IN_USE',
              'The type of an account with journal lines cannot change.',
            );
          }
          if (await hasChildAccounts(tx, ctx.organizationId, accountId)) {
            throw new ConflictError('CONFLICT', 'Change the type of child accounts first.');
          }
        }
        if (parentId && (parentId !== account.parentId || type !== account.accountType)) {
          await this.assertValidParent(tx, ctx.organizationId, parentId, type, accountId);
        }
        if (input.code && input.code !== account.code) {
          const clash = await findAccountByCode(tx, ctx.organizationId, input.code);
          if (clash)
            throw new ConflictError('CONFLICT', 'An account with this code already exists.');
        }

        const changes: Partial<
          Pick<Account, 'code' | 'name' | 'description' | 'accountType' | 'parentId'>
        > = {};
        if (input.code !== undefined && input.code !== account.code) changes.code = input.code;
        if (input.name !== undefined && input.name.trim() !== account.name)
          changes.name = input.name.trim();
        if (input.description !== undefined && input.description.trim() !== account.description) {
          changes.description = input.description.trim();
        }
        if (type !== account.accountType) changes.accountType = type;
        if (parentId !== account.parentId) changes.parentId = parentId;
        if (Object.keys(changes).length === 0) return accountView(account);

        const updated = await updateAccount(tx, {
          organizationId: ctx.organizationId,
          accountId,
          changes,
          userId: ctx.userId,
        });
        if (!updated) throw new NotFoundError('Account not found.');
        const before = Object.fromEntries(
          Object.keys(changes).map((key) => [key, account[key as keyof typeof changes]]),
        );
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'account.updated',
          resourceType: 'accounting_account',
          resourceId: accountId,
          metadata: { code: updated.code, before, after: changes },
          origin,
        });
        return accountView((await getAccount(tx, ctx.organizationId, accountId))!);
      },
    );
  }

  archiveAccount(principal: Principal, accountId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsArchive },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const account = await getAccount(tx, ctx.organizationId, accountId, { forUpdate: true });
        if (!account) throw new NotFoundError('Account not found.');
        if (account.status === 'ARCHIVED') {
          throw new ConflictError('INVALID_STATE_TRANSITION', 'The account is already archived.');
        }
        const archived = await archiveAccount(tx, {
          organizationId: ctx.organizationId,
          accountId,
          userId: ctx.userId,
          now: this.now,
        });
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'account.archived',
          resourceType: 'accounting_account',
          resourceId: accountId,
          metadata: {
            code: account.code,
            name: account.name,
            usedInPostedJournals: account.usedInPostedJournals,
          },
          origin,
        });
        return accountView(archived!);
      },
    );
  }

  /**
   * Deletes an unused account. Accounts referenced by posted (or pending) journals cannot
   * be deleted and must be archived instead; draft-only references do not block deletion.
   */
  deleteAccount(principal: Principal, accountId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.AccountsDelete, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const account = await getAccount(tx, ctx.organizationId, accountId, { forUpdate: true });
        if (!account) throw new NotFoundError('Account not found.');
        if (await isAccountReferencedOutsideDrafts(tx, ctx.organizationId, accountId)) {
          throw new ConflictError(
            'ACCOUNT_IN_USE',
            'This account is used by posted or pending journals. Archive it instead.',
          );
        }
        if (await hasChildAccounts(tx, ctx.organizationId, accountId)) {
          throw new ConflictError('CONFLICT', 'Delete or move the child accounts first.');
        }
        const result = await deleteAccount(tx, ctx.organizationId, accountId);
        if (!result.deleted) throw new NotFoundError('Account not found.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'account.deleted',
          resourceType: 'accounting_account',
          resourceId: accountId,
          metadata: {
            code: account.code,
            name: account.name,
            draftLinesCleared: result.draftLinesCleared,
          },
          origin,
        });
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Exchange rates
  // ---------------------------------------------------------------------------

  listExchangeRates(principal: Principal, filter: { fromCurrency?: string | undefined }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const rates = await listExchangeRates(tx, ctx.organizationId, { ...filter, limit: 500 });
        return rates.map((r) => ({
          id: r.id,
          fromCurrency: r.fromCurrency,
          toCurrency: r.toCurrency,
          rateDate: r.rateDate,
          rate: r.rate,
          createdAt: r.createdAt.toISOString(),
        }));
      },
    );
  }

  recordExchangeRate(
    principal: Principal,
    input: { fromCurrency: string; rateDate: string; rate: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        if (!isSupportedCurrency(input.fromCurrency))
          throw issue('fromCurrency', 'Unsupported currency.');
        if (input.fromCurrency === settings.baseCurrency) {
          throw issue(
            'fromCurrency',
            'Rates are recorded for foreign currencies against the base currency.',
          );
        }
        if (!isValidIsoDate(input.rateDate))
          throw issue('rateDate', 'Enter a valid date (YYYY-MM-DD).');
        const parsed = parseRate(input.rate);
        if (!parsed.ok)
          throw issue('rate', 'Rates are positive decimal strings with at most 10 decimals.');
        const rate = await recordExchangeRate(tx, {
          organizationId: ctx.organizationId,
          fromCurrency: input.fromCurrency,
          toCurrency: settings.baseCurrency,
          rateDate: input.rateDate,
          rate: parsed.value.toFixed(10),
          userId: ctx.userId,
        });
        if (!rate)
          throw new ConflictError('CONFLICT', 'A rate for this currency and date already exists.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'exchange_rate.recorded',
          resourceType: 'accounting_exchange_rate',
          resourceId: rate.id,
          metadata: {
            from: rate.fromCurrency,
            to: rate.toCurrency,
            date: rate.rateDate,
            rate: rate.rate,
          },
          origin,
        });
        return {
          id: rate.id,
          fromCurrency: rate.fromCurrency,
          toCurrency: rate.toCurrency,
          rateDate: rate.rateDate,
          rate: rate.rate,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Fiscal years and periods
  // ---------------------------------------------------------------------------

  listFiscalYears(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.PeriodsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const years = await listFiscalYears(tx, ctx.organizationId);
        const periods = await listPeriods(tx, ctx.organizationId);
        return years.map((y) =>
          fiscalYearView(
            y,
            periods.filter((p) => p.fiscalYearId === y.id),
          ),
        );
      },
    );
  }

  getFiscalYear(principal: Principal, fiscalYearId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.PeriodsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const year = await getFiscalYear(tx, ctx.organizationId, fiscalYearId);
        if (!year) throw new NotFoundError('Fiscal year not found.');
        return fiscalYearView(year, await listPeriods(tx, ctx.organizationId, { fiscalYearId }));
      },
    );
  }

  /**
   * Creates a fiscal year with monthly periods by default, or the supplied custom periods.
   * Fiscal years are contiguous and non-overlapping (decision C13).
   */
  createFiscalYear(
    principal: Principal,
    input: {
      name: string;
      startDate: string;
      endDate: string;
      periods?: { name?: string | undefined; startDate: string; endDate: string }[] | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        // Lock serializes fiscal-year creation per organization (contiguity check).
        await requireAccountingSettings(tx, ctx.organizationId, { forUpdate: true });
        if (!isValidIsoDate(input.startDate))
          throw issue('startDate', 'Enter a valid date (YYYY-MM-DD).');
        if (!isValidIsoDate(input.endDate))
          throw issue('endDate', 'Enter a valid date (YYYY-MM-DD).');
        if (input.endDate < input.startDate)
          throw issue('endDate', 'The end date must not precede the start date.');

        const existing = await listFiscalYears(tx, ctx.organizationId);
        if (existing.length > 0) {
          const first = existing[0]!;
          const last = existing.at(-1)!;
          const followsLast = input.startDate === addDays(last.endDate, 1);
          const precedesFirst = input.endDate === addDays(first.startDate, -1);
          if (!followsLast && !precedesFirst) {
            throw issue(
              'startDate',
              `Fiscal years must be contiguous: start on ${addDays(last.endDate, 1)} or end on ${addDays(first.startDate, -1)}.`,
            );
          }
        }

        const ranges = input.periods?.length
          ? input.periods.map((p) => ({ startDate: p.startDate, endDate: p.endDate }))
          : generateMonthlyPeriods(input.startDate, input.endDate);
        const layoutIssues = validatePeriodLayout(
          { startDate: input.startDate, endDate: input.endDate },
          ranges,
        );
        if (layoutIssues.length) throw new ValidationError(layoutIssues);
        const periods = ranges.map((r, i) => ({
          ...r,
          name:
            input.periods?.[i]?.name?.trim() ||
            `P${String(i + 1).padStart(2, '0')} ${r.startDate.slice(0, 7)}`,
        }));

        const created = await createFiscalYear(tx, {
          organizationId: ctx.organizationId,
          name: input.name,
          startDate: input.startDate,
          endDate: input.endDate,
          periods,
          userId: ctx.userId,
        });
        if (created === 'name_taken')
          throw new ConflictError('CONFLICT', 'A fiscal year with this name exists.');
        await recordAuditEvent(tx, {
          occurredAt: this.now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'fiscal_year.created',
          resourceType: 'accounting_fiscal_year',
          resourceId: created.fiscalYear.id,
          metadata: {
            name: created.fiscalYear.name,
            startDate: created.fiscalYear.startDate,
            endDate: created.fiscalYear.endDate,
            periods: created.periods.length,
            customPeriods: Boolean(input.periods?.length),
          },
          origin,
        });
        return fiscalYearView(created.fiscalYear, created.periods);
      },
    );
  }

  listPeriods(principal: Principal, filter: { fiscalYearId?: string | undefined }) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.PeriodsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        return (await listPeriods(tx, ctx.organizationId, filter)).map(periodView);
      },
    );
  }

  closePeriod(principal: Principal, periodId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.PeriodsClose, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        // FOR UPDATE waits for in-flight postings (which hold FOR SHARE on the period).
        const period = await getPeriod(tx, ctx.organizationId, periodId, 'update');
        if (!period) throw new NotFoundError('Period not found.');
        if (period.status === 'CLOSED') {
          throw new ConflictError('INVALID_STATE_TRANSITION', 'The period is already closed.');
        }
        const now = this.now;
        const closed = await closePeriod(tx, {
          organizationId: ctx.organizationId,
          periodId,
          userId: ctx.userId,
          now,
        });
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'period.closed',
          resourceType: 'accounting_period',
          resourceId: periodId,
          metadata: { name: period.name, startDate: period.startDate, endDate: period.endDate },
          origin,
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'accounting.period_closed',
            aggregateType: 'accounting_period',
            aggregateId: periodId,
            organizationId: ctx.organizationId,
            payload: { periodId },
          },
          now,
        );
        return periodView(closed!);
      },
    );
  }

  /**
   * Reopening a closed period: permission + re-authentication + mandatory reason + audit.
   * If the organization has an approval policy for reopening, an approval request is opened
   * and the period reopens when it is fully approved.
   */
  reopenPeriod(principal: Principal, periodId: string, reason: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.PeriodsReopen, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const period = await getPeriod(tx, ctx.organizationId, periodId, 'update');
        if (!period) throw new NotFoundError('Period not found.');
        if (period.status !== 'CLOSED') {
          throw new ConflictError(
            'INVALID_STATE_TRANSITION',
            'Only closed periods can be reopened.',
          );
        }
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: PERIOD_REOPEN_ACTION,
          subjectId: periodId,
          excludedUserIds: [ctx.userId],
          reason: reason.trim(),
          now,
        });
        if (request) {
          await recordAuditEvent(tx, {
            occurredAt: now,
            organizationId: ctx.organizationId,
            actorUserId: ctx.userId,
            action: 'period.reopen_requested',
            resourceType: 'accounting_period',
            resourceId: periodId,
            metadata: { reason: reason.trim(), approvalRequestId: request.id },
            origin,
          });
          return {
            status: 'PENDING_APPROVAL' as const,
            approvalRequestId: request.id,
            period: periodView(period),
          };
        }
        const reopened = await reopenPeriod(tx, {
          organizationId: ctx.organizationId,
          periodId,
          userId: ctx.userId,
          reason: reason.trim(),
          now,
        });
        await this.auditPeriodReopened(tx, ctx, reopened!, reason.trim(), origin, now, {
          requestedByUserId: ctx.userId,
          approvalRequestId: null,
          finalApproverUserId: null,
        });
        return {
          status: 'REOPENED' as const,
          approvalRequestId: null,
          period: periodView(reopened!),
        };
      },
    );
  }

  private async auditPeriodReopened(
    tx: Transaction,
    ctx: AuthorizationContext,
    period: Period,
    reason: string,
    origin: EventOrigin,
    now: Date,
    approval: {
      requestedByUserId: string;
      approvalRequestId: string | null;
      finalApproverUserId: string | null;
    },
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action: 'period.reopened',
      resourceType: 'accounting_period',
      resourceId: period.id,
      metadata: { name: period.name, reason, ...approval },
      origin,
    });
    await enqueueOutboxEvent(
      tx,
      {
        eventType: 'accounting.period_reopened',
        aggregateType: 'accounting_period',
        aggregateId: period.id,
        organizationId: ctx.organizationId,
        payload: { periodId: period.id },
      },
      now,
    );
  }

  // ---------------------------------------------------------------------------
  // General ledger and dashboard
  // ---------------------------------------------------------------------------

  ledger(
    principal: Principal,
    input: {
      accountId?: string | undefined;
      fromDate?: string | undefined;
      toDate?: string | undefined;
      limit: number;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.LedgerView },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        for (const [key, value] of [
          ['fromDate', input.fromDate],
          ['toDate', input.toDate],
        ] as const) {
          if (value && !isValidIsoDate(value)) throw issue(key, 'Enter a valid date (YYYY-MM-DD).');
        }
        let accountIds: string[] | null = null;
        let account: AccountWithFacts | undefined;
        if (input.accountId) {
          account = await getAccount(tx, ctx.organizationId, input.accountId);
          if (!account) throw new NotFoundError('Account not found.');
          // Parent accounts are reporting nodes: their ledger aggregates all descendants.
          accountIds = await descendantAccountIds(tx, ctx.organizationId, account.id);
        }
        const result = await queryLedger(tx, {
          organizationId: ctx.organizationId,
          accountIds,
          fromDate: input.fromDate ?? null,
          toDate: input.toDate ?? null,
          limit: input.limit,
        });
        return {
          baseCurrency: settings.baseCurrency,
          account: account ? accountView(account) : null,
          fromDate: input.fromDate ?? null,
          toDate: input.toDate ?? null,
          ...result,
        };
      },
    );
  }

  dashboard(principal: Principal) {
    return withOrganization(this.deps, principal, {}, async (tx, ctx) => {
      const canPeriods = hasPermission(ctx, AccountingPermissions.PeriodsView);
      const canJournals = hasPermission(ctx, AccountingPermissions.JournalsView);
      if (!canPeriods && !canJournals) throw new PermissionDeniedError();
      const settings = await getAccountingSettings(tx, ctx.organizationId);
      if (!settings) return { isSetUp: false as const };
      const today = this.now.toISOString().slice(0, 10);
      let fiscal = null;
      if (canPeriods) {
        const period = await currentPeriod(tx, ctx.organizationId, today);
        const year = period
          ? await getFiscalYear(tx, ctx.organizationId, period.fiscalYearId)
          : undefined;
        fiscal = {
          fiscalYear: year ? fiscalYearView(year) : null,
          period: period ? periodView(period) : null,
        };
      }
      let journals = null;
      if (canJournals) {
        const summary = (
          statuses: ('DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REVERSED')[],
          limit: number,
        ) => listJournals(tx, ctx.organizationId, { statuses, limit });
        const view = (j: Awaited<ReturnType<typeof listJournals>>[number]) => ({
          id: j.id,
          number: j.journalNumber,
          status: j.status,
          entryDate: j.entryDate,
          description: j.description,
          currency: j.currency,
          totalDebit: j.totalDebit,
          postedAt: j.postedAt?.toISOString() ?? null,
          createdAt: j.createdAt.toISOString(),
        });
        const recent = await summary([], 5);
        const drafts = await summary(['DRAFT'], 5);
        const pending = await summary(['PENDING_APPROVAL'], 5);
        const posted = await summary(['POSTED', 'REVERSED'], 5);
        journals = {
          recent: recent.map(view),
          draftCount: await countJournals(tx, ctx.organizationId, ['DRAFT']),
          drafts: drafts.map(view),
          pendingApprovalCount: await countJournals(tx, ctx.organizationId, ['PENDING_APPROVAL']),
          pendingApprovals: pending.map(view),
          recentPosted: posted.map(view),
        };
      }
      return { isSetUp: true as const, baseCurrency: settings.baseCurrency, ...fiscal, journals };
    });
  }
}
