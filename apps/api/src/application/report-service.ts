import {
  AppError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import type { Decimal } from 'decimal.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  addDays,
  addMonths,
  findPeriodForDate,
  getDesignatedAccountId,
  getDimensionValuesByIds,
  getDimensionType,
  getFiscalYear,
  getPeriod,
  isValidIsoDate,
  listDimensionTypes,
  listDimensionValues,
  listFiscalYears,
  queryAccountBalances,
  type FiscalYear,
  type ReportAccount,
} from '../modules/accounting/index.js';
import { listCategories } from '../modules/fixed-assets/index.js';
import {
  buildBalanceSheet,
  buildCashFlow,
  buildEquity,
  buildProfitAndLoss,
  buildTrialBalance,
  type CurrencyView,
  type Integrity,
} from '../modules/reports/index.js';
import { decimal, minorUnits } from '../domain/money.js';
import { requireAccountingSettings } from './accounting-service.js';
import {
  hasPermission,
  requirePermission,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { withOrganization } from './organization-service.js';

/**
 * Financial statements (Decision 4; S3-01..S3-24). Reads only the posted ledger through the
 * accounting module's aggregation contract and composes statements with the pure reports module.
 * Each request runs in one REPEATABLE READ, READ ONLY snapshot. Nothing is cached (R29).
 */

export type CompareMode = 'previous_period' | 'previous_year' | 'custom';

interface CommonInput {
  includeZero: boolean;
  currencyView: CurrencyView;
  dimensionValueIds?: string[] | undefined;
}

export interface RangeInput extends CommonInput {
  from?: string | undefined;
  to?: string | undefined;
  periodId?: string | undefined;
  fiscalYearId?: string | undefined;
}

export interface ProfitAndLossInput extends RangeInput {
  compare?: CompareMode | undefined;
  compareFrom?: string | undefined;
  compareTo?: string | undefined;
}

export interface BalanceSheetInput extends CommonInput {
  asOf?: string | undefined;
  periodId?: string | undefined;
  fiscalYearId?: string | undefined;
  compare?: CompareMode | undefined;
  compareAsOf?: string | undefined;
}

const invalid = (path: string, message: string) => new ValidationError([{ path, message }]);

const MAX_TREND_MONTHS = 24;
/** The profit and loss sections that hold expense accounts. */
const EXPENSE_SECTIONS = new Set([
  'cost_of_goods_sold',
  'operating_expenses',
  'other_expenses',
  'unclassified_expenses',
]);

/** Validates an expense-trend range and returns its months. */
function expenseTrendMonths(input: { from: string; to: string }) {
  if (!isValidIsoDate(input.from)) throw invalid('from', 'A valid date (YYYY-MM-DD) is required.');
  if (!isValidIsoDate(input.to)) throw invalid('to', 'A valid date (YYYY-MM-DD) is required.');
  if (input.from > input.to) throw invalid('to', 'The end date must not be before the start.');
  const months = monthBuckets(input.from, input.to);
  if (months.length > MAX_TREND_MONTHS) {
    throw invalid('to', `At most ${MAX_TREND_MONTHS} months can be shown in one report.`);
  }
  return months;
}

/** Calendar months from `from` to `to`, the first and last clipped to the range. */
function monthBuckets(from: string, to: string) {
  const out: { label: string; from: string; to: string }[] = [];
  let cursor = from;
  while (cursor <= to && out.length <= MAX_TREND_MONTHS) {
    const year = Number(cursor.slice(0, 4));
    const month = Number(cursor.slice(5, 7));
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${cursor.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    out.push({ label: cursor.slice(0, 7), from: cursor, to: monthEnd < to ? monthEnd : to });
    cursor = addDays(monthEnd, 1);
  }
  return out;
}

function fiscalYearNotFound(date: string, what: string) {
  return new AppError(
    'FISCAL_YEAR_NOT_FOUND',
    409,
    `No fiscal year covers ${date} (${what}). Create the fiscal year first.`,
  );
}

function fiscalYearView(fy: FiscalYear) {
  return { id: fy.id, name: fy.name, startDate: fy.startDate, endDate: fy.endDate };
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export class ReportService {
  constructor(private readonly deps: AppDependencies) {}

  private today(): string {
    return this.deps.clock.now().toISOString().slice(0, 10);
  }

  private run<T>(
    principal: Principal,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.ReportsView, readOnlySnapshot: true },
      work,
    );
  }

  /**
   * Common setup: accounting set up, dimension filter authorized (S3-03, checked before any
   * lookup so nothing is revealed) and validated (S3-16), fiscal years loaded.
   */
  private async prepare(tx: Transaction, ctx: AuthorizationContext, input: CommonInput) {
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const ids = [...new Set(input.dimensionValueIds ?? [])];
    if (ids.length > 0 && !hasPermission(ctx, AccountingPermissions.DimensionsView)) {
      throw new PermissionDeniedError(
        'You need permission to view dimensions to filter reports by dimension.',
      );
    }
    const values = await getDimensionValuesByIds(tx, ctx.organizationId, ids);
    const types = new Map((await listDimensionTypes(tx, ctx.organizationId)).map((t) => [t.id, t]));
    const seenTypes = new Set<string>();
    const dimensionFilter = ids.map((id) => {
      const value = values.get(id);
      if (!value) throw invalid('dimensionValueIds', 'Unknown dimension value.');
      if (seenTypes.has(value.dimensionTypeId)) {
        throw invalid('dimensionValueIds', 'Filter on at most one value per dimension type.');
      }
      seenTypes.add(value.dimensionTypeId);
      const type = types.get(value.dimensionTypeId)!;
      return {
        dimensionTypeId: type.id,
        typeName: type.name,
        dimensionValueId: value.id,
        valueName: value.name,
      };
    });
    const fiscalYears = await listFiscalYears(tx, ctx.organizationId);
    const fiscalYearOf = (date: string) =>
      fiscalYears.find((fy) => fy.startDate <= date && date <= fy.endDate);
    return { settings, dimensionFilter, dimensionValueIds: ids, fiscalYearOf };
  }

  /** from/to, or a period, or a fiscal year; default: current fiscal year to today (S3-23). */
  private async resolveRange(
    tx: Transaction,
    organizationId: string,
    input: RangeInput,
    fiscalYearOf: (date: string) => FiscalYear | undefined,
  ): Promise<{ from: string; to: string }> {
    const modes = [
      input.from !== undefined || input.to !== undefined,
      input.periodId !== undefined,
      input.fiscalYearId !== undefined,
    ].filter(Boolean).length;
    if (modes > 1) throw invalid('from', 'Use either from/to, periodId or fiscalYearId.');
    if (input.periodId) {
      const period = await getPeriod(tx, organizationId, input.periodId);
      if (!period) throw invalid('periodId', 'Unknown accounting period.');
      return { from: period.startDate, to: period.endDate };
    }
    if (input.fiscalYearId) {
      const fy = await getFiscalYear(tx, organizationId, input.fiscalYearId);
      if (!fy) throw invalid('fiscalYearId', 'Unknown fiscal year.');
      return { from: fy.startDate, to: fy.endDate };
    }
    if (input.from !== undefined || input.to !== undefined) {
      const issues: ValidationIssue[] = [];
      for (const key of ['from', 'to'] as const) {
        const value = input[key];
        if (value === undefined)
          issues.push({ path: key, message: 'Both from and to are required.' });
        else if (!isValidIsoDate(value))
          issues.push({ path: key, message: 'Enter a valid date (YYYY-MM-DD).' });
      }
      if (issues.length) throw new ValidationError(issues);
      if (input.from! > input.to!)
        throw invalid('to', 'The end date must not be before the start date.');
      return { from: input.from!, to: input.to! };
    }
    const today = this.today();
    const fy = fiscalYearOf(today);
    if (!fy) throw fiscalYearNotFound(today, 'default reporting date');
    return { from: fy.startDate, to: today };
  }

  /** The designated Retained Earnings account, if valid: an active equity leaf (Decision 79). */
  private async retainedEarnings(
    tx: Transaction,
    organizationId: string,
    accounts: readonly ReportAccount[],
  ) {
    const id = await getDesignatedAccountId(tx, organizationId, 'RETAINED_EARNINGS');
    const account = id ? accounts.find((a) => a.id === id) : undefined;
    return account &&
      account.accountType === 'EQUITY' &&
      account.isLeaf &&
      account.status === 'ACTIVE'
      ? account.id
      : null;
  }

  private logIntegrity(ctx: AuthorizationContext, report: string, integrity: Integrity) {
    if (integrity.status === 'OUT_OF_BALANCE') {
      // S3-17: shown to the user and logged; never hidden or auto-corrected.
      this.deps.logger.error(
        { organizationId: ctx.organizationId, report, checks: integrity.checks },
        'Financial report integrity check failed',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Trial Balance (S3-08, S3-09)
  // ---------------------------------------------------------------------------

  trialBalance(principal: Principal, input: RangeInput) {
    return this.run(principal, (tx, ctx) => this.trialBalanceInTransaction(tx, ctx, input));
  }

  /** S6 (L-7): the same statement inside the caller's (read-only snapshot) transaction. */
  async trialBalanceInTransaction(tx: Transaction, ctx: AuthorizationContext, input: RangeInput) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const env = await this.prepare(tx, ctx, input);
    const range = await this.resolveRange(tx, ctx.organizationId, input, env.fiscalYearOf);
    const fy = env.fiscalYearOf(range.from);
    if (!fy) throw fiscalYearNotFound(range.from, 'Trial Balance start');
    if (!env.fiscalYearOf(range.to)) throw fiscalYearNotFound(range.to, 'Trial Balance end');
    if (range.to > fy.endDate) {
      // S3-07: a range that does not fall inside one defined fiscal year is a 409.
      throw new AppError(
        'FISCAL_YEAR_NOT_FOUND',
        409,
        `The Trial Balance range ${range.from} to ${range.to} spans more than one fiscal year; choose a range inside ${fy.name} (${fy.startDate} to ${fy.endDate}).`,
      );
    }
    const accounts = await queryAccountBalances(tx, {
      organizationId: ctx.organizationId,
      fiscalYearStart: fy.startDate,
      from: range.from,
      to: range.to,
      dimensionValueIds: env.dimensionValueIds,
    });
    const result = buildTrialBalance({
      ...range,
      fiscalYearStart: fy.startDate,
      accounts,
      retainedEarningsAccountId: await this.retainedEarnings(tx, ctx.organizationId, accounts),
      baseCurrency: env.settings.baseCurrency,
      includeZero: input.includeZero,
      currencyView: input.currencyView,
      tagged: env.dimensionFilter.length > 0,
    });
    this.logIntegrity(ctx, 'trial_balance', result.integrity);
    return {
      report: 'trial_balance' as const,
      baseCurrency: env.settings.baseCurrency,
      from: range.from,
      to: range.to,
      fiscalYear: fiscalYearView(fy),
      currencyView: input.currencyView,
      includeZero: input.includeZero,
      dimensionFilter: env.dimensionFilter,
      taggedActivityOnly: env.dimensionFilter.length > 0,
      ...result,
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Profit & Loss (S3-11, S3-18)
  // ---------------------------------------------------------------------------

  /**
   * Profit and loss side by side for each value of ONE dimension type (for example every branch or
   * department), plus what is not tagged with any value of that type. Derived from the ledger by
   * running the ordinary statement once per value, so each column agrees with the statement
   * filtered on that value; "unassigned" is the whole statement minus the values (a line carries at
   * most one value per type). Needs `accounting.reports.view` and `accounting.dimensions.view`.
   */
  profitAndLossByDimension(principal: Principal, input: RangeInput & { dimensionTypeId: string }) {
    return this.run(principal, async (tx, ctx) => {
      if (!hasPermission(ctx, AccountingPermissions.DimensionsView)) {
        throw new PermissionDeniedError('You need permission to view dimensions for this report.');
      }
      const type = await getDimensionType(tx, ctx.organizationId, input.dimensionTypeId);
      if (!type) throw invalid('dimensionTypeId', 'Unknown dimension type.');
      const values = (await listDimensionValues(tx, ctx.organizationId)).filter(
        (v) => v.dimensionTypeId === type.id,
      );
      if (values.length > 100) {
        throw invalid('dimensionTypeId', 'At most 100 values can be compared in one report.');
      }
      const base = { includeZero: false, currencyView: input.currencyView } as const;
      const range = {
        from: input.from,
        to: input.to,
        periodId: input.periodId,
        fiscalYearId: input.fiscalYearId,
      };
      const whole = await this.profitAndLossInTransaction(tx, ctx, { ...base, ...range });
      const pick = (r: typeof whole) => {
        const section = (key: string) =>
          decimal(r.sections.find((s) => s.key === key)?.total[0] ?? '0');
        return {
          revenue: section('revenue'),
          costOfGoodsSold: section('cost_of_goods_sold'),
          operatingExpenses: section('operating_expenses'),
          grossProfit: decimal(r.summary.grossProfit[0] ?? '0'),
          netProfit: decimal(r.summary.netProfit[0] ?? '0'),
        };
      };
      const show = (m: ReturnType<typeof pick>) => ({
        revenue: m.revenue.toFixed(),
        costOfGoodsSold: m.costOfGoodsSold.toFixed(),
        operatingExpenses: m.operatingExpenses.toFixed(),
        grossProfit: m.grossProfit.toFixed(),
        netProfit: m.netProfit.toFixed(),
      });
      const total = pick(whole);
      const rows = [];
      const sum = { ...total };
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] = decimal(0);
      for (const v of values) {
        const r = await this.profitAndLossInTransaction(tx, ctx, {
          ...base,
          ...range,
          dimensionValueIds: [v.id],
        });
        const m = pick(r);
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] = sum[k].plus(m[k]);
        if (v.status === 'ARCHIVED' && Object.values(m).every((x) => x.isZero())) continue;
        rows.push({
          dimensionValueId: v.id,
          code: v.code,
          name: v.name,
          status: v.status,
          ...show(m),
        });
      }
      const unassigned = { ...total };
      for (const k of Object.keys(unassigned) as (keyof typeof unassigned)[]) {
        unassigned[k] = total[k].minus(sum[k]);
      }
      return {
        report: 'profit_and_loss_by_dimension' as const,
        dimensionType: { id: type.id, code: type.code, name: type.name },
        baseCurrency: whole.baseCurrency,
        from: whole.columns[0]?.from ?? null,
        to: whole.columns[0]?.to ?? null,
        values: rows,
        unassigned: show(unassigned),
        total: show(total),
        note: 'Each column is the ordinary profit and loss filtered on that value. Unassigned is the statement minus the listed values.',
        generatedAt: this.deps.clock.now().toISOString(),
      };
    });
  }

  profitAndLoss(principal: Principal, input: ProfitAndLossInput) {
    return this.run(principal, (tx, ctx) => this.profitAndLossInTransaction(tx, ctx, input));
  }

  /**
   * Expense trend (master specification section 16; R-02): the expense accounts of the profit and
   * loss, month by month, for a date range. Every month is the ordinary profit and loss for that
   * month (the same engine and the same sections), so the figures agree with the statement to the
   * cent. Only posted ledger activity is counted; nothing is derived from documents. A range that
   * does not start or end on a month boundary gets a shorter first or last month. At most 24
   * months are shown. Needs `accounting.reports.view`.
   */
  expenseTrend(principal: Principal, input: { from: string; to: string }) {
    expenseTrendMonths(input);
    return this.run(principal, (tx, ctx) => this.expenseTrendInTransaction(tx, ctx, input));
  }

  /** The same report inside the caller's (read-only snapshot) transaction, for its export. */
  async expenseTrendInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: { from: string; to: string },
  ) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const months = expenseTrendMonths(input);
    {
      const rows = new Map<
        string,
        {
          accountId: string;
          code: string | null;
          name: string;
          section: string;
          amounts: Decimal[];
        }
      >();
      const totals = months.map(() => decimal(0));
      let baseCurrency = '';
      for (const [i, month] of months.entries()) {
        const statement = await this.profitAndLossInTransaction(tx, ctx, {
          from: month.from,
          to: month.to,
          includeZero: false,
          currencyView: 'base',
        });
        baseCurrency = statement.baseCurrency;
        for (const section of statement.sections) {
          if (!EXPENSE_SECTIONS.has(section.key)) continue;
          totals[i] = totals[i]!.plus(decimal(section.total[0] ?? '0'));
          for (const row of section.rows) {
            if (row.rowType !== 'account' || !row.isLeaf || !row.accountId) continue;
            const entry = rows.get(row.accountId) ?? {
              accountId: row.accountId,
              code: row.code,
              name: row.name,
              section: section.key,
              amounts: months.map(() => decimal(0)),
            };
            rows.set(row.accountId, entry);
            entry.amounts[i] = entry.amounts[i]!.plus(decimal(row.amounts[0] ?? '0'));
          }
        }
      }
      const digits = minorUnits(baseCurrency);
      const show = (v: Decimal) => v.toFixed(digits);
      const accounts = [...rows.values()]
        .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''))
        .map((r) => ({
          accountId: r.accountId,
          code: r.code,
          name: r.name,
          section: r.section,
          amounts: r.amounts.map(show),
          total: show(r.amounts.reduce((sum, v) => sum.plus(v), decimal(0))),
        }));
      return {
        report: 'expense_trend' as const,
        baseCurrency,
        from: input.from,
        to: input.to,
        months: months.map((m) => ({ label: m.label, from: m.from, to: m.to })),
        accounts,
        totals: totals.map(show),
        total: show(totals.reduce((sum, v) => sum.plus(v), decimal(0))),
        note: 'Each month is the ordinary profit and loss for that month, expense sections only, from posted ledger activity.',
        generatedAt: this.deps.clock.now().toISOString(),
      };
    }
  }

  /** S6 (L-7): the same statement inside the caller's (read-only snapshot) transaction. */
  async profitAndLossInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ProfitAndLossInput,
  ) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const env = await this.prepare(tx, ctx, input);
    const range = await this.resolveRange(tx, ctx.organizationId, input, env.fiscalYearOf);
    const ranges: { key: 'current' | 'comparison'; from: string; to: string }[] = [
      { key: 'current', ...range },
    ];
    const comparison = this.profitAndLossComparison(range, input);
    if (comparison) ranges.push({ key: 'comparison', ...comparison });
    const columns = [];
    for (const r of ranges) {
      columns.push({
        key: r.key,
        label: `${r.from} – ${r.to}`,
        from: r.from,
        to: r.to,
        accounts: await queryAccountBalances(tx, {
          organizationId: ctx.organizationId,
          fiscalYearStart: r.from,
          from: r.from,
          to: r.to,
          dimensionValueIds: env.dimensionValueIds,
        }),
      });
    }
    const result = buildProfitAndLoss({
      columns,
      baseCurrency: env.settings.baseCurrency,
      includeZero: input.includeZero,
      currencyView: input.currencyView,
      tagged: env.dimensionFilter.length > 0,
    });
    this.logIntegrity(ctx, 'profit_and_loss', result.integrity);
    return {
      report: 'profit_and_loss' as const,
      baseCurrency: env.settings.baseCurrency,
      columns: columns.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.to })),
      compare: input.compare ?? null,
      currencyView: input.currencyView,
      includeZero: input.includeZero,
      dimensionFilter: env.dimensionFilter,
      taggedActivityOnly: env.dimensionFilter.length > 0,
      ...result,
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  private profitAndLossComparison(
    range: { from: string; to: string },
    input: ProfitAndLossInput,
  ): { from: string; to: string } | null {
    if (!input.compare) {
      if (input.compareFrom !== undefined || input.compareTo !== undefined) {
        throw invalid('compare', 'Set compare=custom to use compareFrom and compareTo.');
      }
      return null;
    }
    if (input.compare === 'previous_period') {
      // The range of equal length immediately before.
      const to = addDays(range.from, -1);
      return { from: addDays(to, -daysBetween(range.from, range.to)), to };
    }
    if (input.compare === 'previous_year') {
      return { from: addMonths(range.from, -12), to: addMonths(range.to, -12) };
    }
    const issues: ValidationIssue[] = [];
    for (const key of ['compareFrom', 'compareTo'] as const) {
      const value = input[key];
      if (value === undefined || !isValidIsoDate(value)) {
        issues.push({
          path: key,
          message: 'A valid date (YYYY-MM-DD) is required for a custom comparison.',
        });
      }
    }
    if (issues.length) throw new ValidationError(issues);
    if (input.compareFrom! > input.compareTo!) {
      throw invalid('compareTo', 'The comparison end date must not be before its start date.');
    }
    return { from: input.compareFrom!, to: input.compareTo! };
  }

  // ---------------------------------------------------------------------------
  // Cash flows and changes in equity (master context section 16, ADR 0012)
  // ---------------------------------------------------------------------------

  cashFlow(principal: Principal, input: ProfitAndLossInput) {
    return this.run(principal, (tx, ctx) => this.cashFlowInTransaction(tx, ctx, input));
  }

  async cashFlowInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: ProfitAndLossInput,
  ) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const env = await this.prepare(tx, ctx, input);
    const range = await this.resolveRange(tx, ctx.organizationId, input, env.fiscalYearOf);
    const ranges: { key: 'current' | 'comparison'; from: string; to: string }[] = [
      { key: 'current', ...range },
    ];
    const comparison = this.profitAndLossComparison(range, input);
    if (comparison) ranges.push({ key: 'comparison', ...comparison });
    const depreciationAccountIds = new Set(
      (await listCategories(tx, ctx.organizationId)).map((c) => c.accumulatedAccountId),
    );
    const columns = [];
    for (const r of ranges) {
      const accounts = await queryAccountBalances(tx, {
        organizationId: ctx.organizationId,
        fiscalYearStart: r.from,
        from: r.from,
        to: r.to,
        dimensionValueIds: env.dimensionValueIds,
      });
      const statement = buildCashFlow({
        accounts,
        depreciationAccountIds,
        baseCurrency: env.settings.baseCurrency,
        includeZero: input.includeZero,
        tagged: env.dimensionFilter.length > 0,
      });
      this.logIntegrity(ctx, 'cash_flow', statement.integrity);
      columns.push({
        key: r.key,
        label: `${r.from} – ${r.to}`,
        from: r.from,
        to: r.to,
        ...statement,
      });
    }
    return {
      report: 'cash_flow' as const,
      method: 'indirect' as const,
      baseCurrency: env.settings.baseCurrency,
      compare: input.compare ?? null,
      dimensionFilter: env.dimensionFilter,
      taggedActivityOnly: env.dimensionFilter.length > 0,
      columns,
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  changesInEquity(principal: Principal, input: RangeInput) {
    return this.run(principal, (tx, ctx) => this.changesInEquityInTransaction(tx, ctx, input));
  }

  async changesInEquityInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: RangeInput,
  ) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const env = await this.prepare(tx, ctx, input);
    const range = await this.resolveRange(tx, ctx.organizationId, input, env.fiscalYearOf);
    const accounts = await queryAccountBalances(tx, {
      organizationId: ctx.organizationId,
      fiscalYearStart: range.from,
      from: range.from,
      to: range.to,
      dimensionValueIds: env.dimensionValueIds,
    });
    const statement = buildEquity({
      accounts,
      baseCurrency: env.settings.baseCurrency,
      includeZero: input.includeZero,
      tagged: env.dimensionFilter.length > 0,
    });
    this.logIntegrity(ctx, 'changes_in_equity', statement.integrity);
    return {
      report: 'changes_in_equity' as const,
      baseCurrency: env.settings.baseCurrency,
      from: range.from,
      to: range.to,
      dimensionFilter: env.dimensionFilter,
      taggedActivityOnly: env.dimensionFilter.length > 0,
      ...statement,
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Balance Sheet (S3-06, S3-07, S3-12, S3-13, S3-18)
  // ---------------------------------------------------------------------------

  balanceSheet(principal: Principal, input: BalanceSheetInput) {
    return this.run(principal, (tx, ctx) => this.balanceSheetInTransaction(tx, ctx, input));
  }

  /** S6 (L-7): the same statement inside the caller's (read-only snapshot) transaction. */
  async balanceSheetInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: BalanceSheetInput,
  ) {
    requirePermission(ctx, AccountingPermissions.ReportsView);
    const env = await this.prepare(tx, ctx, input);
    const asOf = await this.resolveAsOf(tx, ctx.organizationId, input);
    const dates: { key: 'current' | 'comparison'; asOf: string }[] = [{ key: 'current', asOf }];
    const compareAsOf = await this.balanceSheetComparison(tx, ctx.organizationId, asOf, input);
    if (compareAsOf) dates.push({ key: 'comparison', asOf: compareAsOf });

    const columns = [];
    for (const date of dates) {
      const fy = env.fiscalYearOf(date.asOf);
      if (!fy) {
        throw fiscalYearNotFound(
          date.asOf,
          date.key === 'current' ? 'Balance Sheet date' : 'comparison date',
        );
      }
      columns.push({
        key: date.key,
        label: `As of ${date.asOf}`,
        asOf: date.asOf,
        fiscalYearStart: fy.startDate,
        fiscalYear: fiscalYearView(fy),
        accounts: await queryAccountBalances(tx, {
          organizationId: ctx.organizationId,
          fiscalYearStart: fy.startDate,
          from: fy.startDate,
          to: date.asOf,
          dimensionValueIds: env.dimensionValueIds,
        }),
      });
    }
    const reId = await this.retainedEarnings(tx, ctx.organizationId, columns[0]!.accounts);
    if (!reId) {
      throw new AppError(
        'DESIGNATION_REQUIRED',
        409,
        'Designate a Retained Earnings account (an active equity account) before viewing the Balance Sheet.',
      );
    }
    const result = buildBalanceSheet({
      columns,
      retainedEarningsAccountId: reId,
      baseCurrency: env.settings.baseCurrency,
      includeZero: input.includeZero,
      currencyView: input.currencyView,
      tagged: env.dimensionFilter.length > 0,
    });
    this.logIntegrity(ctx, 'balance_sheet', result.integrity);
    return {
      report: 'balance_sheet' as const,
      baseCurrency: env.settings.baseCurrency,
      columns: columns.map((c) => ({
        key: c.key,
        label: c.label,
        asOf: c.asOf,
        fiscalYear: c.fiscalYear,
      })),
      compare: input.compare ?? null,
      currencyView: input.currencyView,
      includeZero: input.includeZero,
      dimensionFilter: env.dimensionFilter,
      taggedActivityOnly: env.dimensionFilter.length > 0,
      ...result,
      generatedAt: this.deps.clock.now().toISOString(),
    };
  }

  private async resolveAsOf(
    tx: Transaction,
    organizationId: string,
    input: BalanceSheetInput,
  ): Promise<string> {
    const modes = [input.asOf, input.periodId, input.fiscalYearId].filter((v) => v !== undefined);
    if (modes.length > 1) throw invalid('asOf', 'Use either asOf, periodId or fiscalYearId.');
    if (input.periodId) {
      const period = await getPeriod(tx, organizationId, input.periodId);
      if (!period) throw invalid('periodId', 'Unknown accounting period.');
      return period.endDate;
    }
    if (input.fiscalYearId) {
      const fy = await getFiscalYear(tx, organizationId, input.fiscalYearId);
      if (!fy) throw invalid('fiscalYearId', 'Unknown fiscal year.');
      return fy.endDate;
    }
    if (input.asOf !== undefined) {
      if (!isValidIsoDate(input.asOf)) throw invalid('asOf', 'Enter a valid date (YYYY-MM-DD).');
      return input.asOf;
    }
    return this.today();
  }

  private async balanceSheetComparison(
    tx: Transaction,
    organizationId: string,
    asOf: string,
    input: BalanceSheetInput,
  ): Promise<string | null> {
    if (!input.compare) {
      if (input.compareAsOf !== undefined) {
        throw invalid('compare', 'Set compare=custom to use compareAsOf.');
      }
      return null;
    }
    if (input.compare === 'previous_period') {
      // The end of the accounting period before the one containing the as-of date.
      const period = await findPeriodForDate(tx, organizationId, asOf);
      if (!period) {
        throw new AppError(
          'PERIOD_NOT_FOUND',
          409,
          `No accounting period covers ${asOf}, so there is no previous period to compare.`,
        );
      }
      return addDays(period.startDate, -1);
    }
    if (input.compare === 'previous_year') return addMonths(asOf, -12);
    if (input.compareAsOf === undefined || !isValidIsoDate(input.compareAsOf)) {
      throw invalid(
        'compareAsOf',
        'A valid date (YYYY-MM-DD) is required for a custom comparison.',
      );
    }
    return input.compareAsOf;
  }
}
