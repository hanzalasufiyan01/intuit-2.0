import { randomUUID } from 'node:crypto';
import type { Decimal } from 'decimal.js';
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
import {
  assetNumberExists,
  capitalizingBills,
  categoryHasAssets,
  FixedAssetPermissions,
  findCategoryByName,
  getAsset,
  lockBillForAssets,
  getAssetSettings,
  getCategories,
  getCategory,
  getDisposal,
  getRun,
  insertAsset,
  insertCategory,
  insertDisposal,
  insertEntries,
  insertRun,
  insertTransfer,
  latestPostedRun,
  ledgerBalanceOf,
  listAssetEntries,
  listAssets,
  listCategories,
  listDisposals,
  listEntriesBySource,
  listRuns,
  listTransfers,
  lockActiveAssets,
  lockAssets,
  registerAsOf,
  runNumberExists,
  saveAssetSettings,
  takeNextAssetNumber,
  updateAsset,
  updateCategory,
  updateDisposal,
  updateRun,
  type AssetCategory,
  type AssetDisposal,
  type DepreciationMethod,
  type DepreciationRun,
  type FixedAsset,
} from '../modules/fixed-assets/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import {
  depreciationDue,
  monthEndOf,
  previousMonthEnd,
  scheduleOf,
  scheduledAccumulated,
  scheduleWarnings,
  type DepreciableAsset,
} from './fixed-asset-schedule.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { assertOpenPeriod } from './sales-documents.js';

/**
 * Fixed assets v1 (approved 2026-10-07; ADR 0008): cost model, straight-line depreciation by month,
 * the register, categories, acquisition and capitalization, accumulated depreciation, disposal
 * with gain or loss, category transfers, the schedule and the depreciation journals. No
 * revaluation, base-currency costs.
 *
 * Every posting goes asset document → accounting event → journal; this service never writes the
 * ledger. `fixed_asset_entries` is the immutable record of every change to an asset's cost and
 * accumulated depreciation, so the register can be read as of any date and reconciled to the ledger.
 */

export const ASSET_ACQUISITION_EVENT = 'fixed_assets.acquisition_posted';
export const ASSET_DEPRECIATION_EVENT = 'fixed_assets.depreciation_posted';
export const ASSET_DISPOSAL_EVENT = 'fixed_assets.disposal_posted';
export const ASSET_TRANSFER_EVENT = 'fixed_assets.transfer_posted';
const ASSET_RESOURCE = 'fixed_asset';
const CATEGORY_RESOURCE = 'fixed_asset_category';
const RUN_RESOURCE = 'fixed_asset_run';
const DISPOSAL_RESOURCE = 'fixed_asset_disposal';
const SETTINGS_RESOURCE = 'fixed_asset_settings';

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun: string) =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

export interface CategoryInput {
  name: string;
  costAccountId: string;
  accumulatedAccountId: string;
  expenseAccountId: string;
  defaultLifeMonths: number;
}

export interface AssetInput {
  name: string;
  description?: string | undefined;
  categoryId: string;
  acquisitionDate: string;
  inServiceDate?: string | undefined;
  cost: string;
  salvageValue?: string | undefined;
  lifeMonths?: number | undefined;
  /** R-11 (ADR 0008 FA-12): straight line unless chosen; fixed once capitalized. */
  depreciationMethod?: DepreciationMethod | undefined;
  /** Annual percentage, only for declining balance: greater than 0, at most 100, 4 decimals. */
  decliningRate?: string | undefined;
  /** The account the cost is credited to (a bank, cash, payable or clearing account). */
  creditAccountId?: string | undefined;
  /** The cost is already in the ledger (for example from a bill): register only, post nothing. */
  alreadyInLedger?: boolean | undefined;
  /** The posted bill that capitalized the cost (needs `alreadyInLedger`): a hard link, checked. */
  sourceBillId?: string | undefined;
  /** Confirms that a likely matching bill is not this asset (audited); needs a reason. */
  duplicateOverrideReason?: string | undefined;
  location?: string | undefined;
  custodian?: string | undefined;
  serialNumber?: string | undefined;
}

export interface SchedulePreviewInput {
  categoryId: string;
  acquisitionDate: string;
  inServiceDate?: string | undefined;
  cost: string;
  salvageValue?: string | undefined;
  lifeMonths?: number | undefined;
  depreciationMethod?: DepreciationMethod | undefined;
  decliningRate?: string | undefined;
}

/**
 * The dates and amounts of a new asset, checked the same way for registration and for the
 * schedule preview: valid dates, in service no earlier than acquired, amounts within the base
 * currency's decimals, a positive cost and a salvage value of at most the cost.
 */
function validateScheduleTerms(
  input: {
    acquisitionDate: string;
    inServiceDate?: string | undefined;
    cost: string;
    salvageValue?: string | undefined;
  },
  scale: number,
  issues: ValidationIssue[],
) {
  if (!isValidIsoDate(input.acquisitionDate)) {
    issues.push({ path: 'acquisitionDate', message: 'Enter a valid date (YYYY-MM-DD).' });
  }
  const inServiceDate = input.inServiceDate ?? input.acquisitionDate;
  if (!isValidIsoDate(inServiceDate)) {
    issues.push({ path: 'inServiceDate', message: 'Enter a valid date (YYYY-MM-DD).' });
  } else if (input.acquisitionDate > inServiceDate) {
    issues.push({
      path: 'inServiceDate',
      message: 'The asset cannot go into service before it is acquired.',
    });
  }
  const cost = decimal(input.cost);
  const salvage = decimal(input.salvageValue ?? '0');
  if (cost.decimalPlaces() > scale || salvage.decimalPlaces() > scale) {
    issues.push({ path: 'cost', message: `Amounts allow at most ${scale} decimals.` });
  }
  if (!cost.gt(0)) issues.push({ path: 'cost', message: 'The cost must be greater than zero.' });
  if (salvage.gt(cost)) {
    issues.push({ path: 'salvageValue', message: 'The salvage value cannot exceed the cost.' });
  }
  return { inServiceDate, cost, salvage };
}

/**
 * The depreciation method and rate of a new asset (R-11): straight line by default; a rate only
 * for ordinary declining balance, greater than 0 and at most 100 percent, with up to 4 decimals.
 */
function validateMethod(
  input: {
    depreciationMethod?: DepreciationMethod | undefined;
    decliningRate?: string | undefined;
  },
  issues: ValidationIssue[],
): { depreciationMethod: DepreciationMethod; decliningRate: string | null } {
  const depreciationMethod = input.depreciationMethod ?? 'straight_line';
  if (depreciationMethod !== 'declining_balance') {
    if (input.decliningRate !== undefined) {
      issues.push({
        path: 'decliningRate',
        message: 'Only the declining-balance method takes a rate.',
      });
    }
    return { depreciationMethod, decliningRate: null };
  }
  if (input.decliningRate === undefined) {
    issues.push({ path: 'decliningRate', message: 'Enter the annual declining-balance rate.' });
    return { depreciationMethod, decliningRate: null };
  }
  const rate = decimal(input.decliningRate);
  if (!rate.gt(0) || rate.gt(100) || rate.decimalPlaces() > 4) {
    issues.push({
      path: 'decliningRate',
      message: 'Enter a rate greater than 0 and at most 100 percent, with up to 4 decimals.',
    });
  }
  return { depreciationMethod, decliningRate: rate.toFixed(4) };
}

interface JournalLineInput {
  accountId: string;
  description: string;
  debit: string | null;
  credit: string | null;
  dimensions: never[];
}

/** Lines per account and side, so a journal carries one line for each. */
class LineBuilder {
  private readonly totals = new Map<
    string,
    { accountId: string; debit: Decimal; credit: Decimal }
  >();

  constructor(private readonly description: string) {}

  debit(accountId: string, amount: Decimal) {
    this.add(accountId, amount, 'debit');
  }

  credit(accountId: string, amount: Decimal) {
    this.add(accountId, amount, 'credit');
  }

  private add(accountId: string, amount: Decimal, side: 'debit' | 'credit') {
    if (amount.isZero()) return;
    const entry = this.totals.get(accountId) ?? {
      accountId,
      debit: decimal(0),
      credit: decimal(0),
    };
    entry[side] = entry[side].plus(amount);
    this.totals.set(accountId, entry);
  }

  lines(): JournalLineInput[] {
    const out: JournalLineInput[] = [];
    for (const { accountId, debit, credit } of this.totals.values()) {
      const net = debit.minus(credit);
      if (net.isZero()) continue;
      out.push({
        accountId,
        description: this.description,
        debit: net.gt(0) ? net.toFixed(4) : null,
        credit: net.lt(0) ? net.abs().toFixed(4) : null,
        dimensions: [],
      });
    }
    return out;
  }
}

/** A posting account: active, leaf, not a control or designated account. */
function postingAccountProblem(
  account: AccountWithFacts | undefined,
  designated: boolean,
): string | null {
  if (!account) return 'Account not found.';
  if (account.status !== 'ACTIVE') return 'Choose an active account.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) return 'A control account is maintained through its subledger.';
  if (designated) return 'A designated system account cannot be used here.';
  return null;
}

export class FixedAssetService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    for (const event of [
      ASSET_ACQUISITION_EVENT,
      ASSET_DEPRECIATION_EVENT,
      ASSET_DISPOSAL_EVENT,
      ASSET_TRANSFER_EVENT,
    ]) {
      // Fixed assets post under their own permissions; the journal is complete (Decision 13).
      journals.registerEventHandler(event, (e) => e.payload.journal as never, {
        domainApproval: true,
      });
    }
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
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

  private async designated(tx: Transaction, organizationId: string, accountId: string) {
    return (await designationsOfAccount(tx, organizationId, accountId)).length > 0;
  }

  private async scale(tx: Transaction, organizationId: string) {
    return minorUnits((await requireAccountingSettings(tx, organizationId)).baseCurrency);
  }

  /** Posts a journal through an accounting event and returns its ids. */
  private async post(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      eventType: string;
      eventKey: string;
      payload: Record<string, unknown>;
      date: string;
      description: string;
      reference: string;
      sourceType: string;
      sourceId: string;
      lines: JournalLineInput[];
    },
    origin: EventOrigin,
  ) {
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'fixed_assets',
      eventType: input.eventType,
      eventKey: input.eventKey,
      payload: {
        ...input.payload,
        journal: {
          entryDate: input.date,
          description: input.description.slice(0, 500),
          reference: input.reference,
          currency: accounting.baseCurrency,
          exchangeRate: null,
          sourceRef: { module: 'fixed_assets', type: input.sourceType, id: input.sourceId },
          lines: input.lines,
        },
      },
      occurredAt: this.now,
      origin,
    });
    if (!event.journalId) {
      throw new AppError('CONFLICT', 409, 'The entry was not posted; try again.');
    }
    return { journalId: event.journalId, eventId: event.eventId };
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const settings = await getAssetSettings(tx, ctx.organizationId);
        return {
          gainLossAccountId: settings?.gainLossAccountId ?? null,
          version: settings?.version ?? 0,
        };
      },
    );
  }

  updateSettings(
    principal: Principal,
    input: { version: number; gainLossAccountId: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage, sensitive: true },
      async (tx, ctx) => {
        if (input.gainLossAccountId) {
          const account = await getAccount(tx, ctx.organizationId, input.gainLossAccountId);
          const problem =
            postingAccountProblem(
              account,
              await this.designated(tx, ctx.organizationId, input.gainLossAccountId),
            ) ??
            (account && account.accountType !== 'REVENUE' && account.accountType !== 'EXPENSE'
              ? 'Choose a revenue or expense account for gains and losses.'
              : null);
          if (problem) throw new ValidationError([{ path: 'gainLossAccountId', message: problem }]);
        }
        const saved = await saveAssetSettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          gainLossAccountId: input.gainLossAccountId,
          userId: ctx.userId,
          at: this.now,
        });
        if (!saved) throw versionConflict('setting');
        await this.audit(
          tx,
          ctx,
          'fixed_asset.settings_updated',
          SETTINGS_RESOURCE,
          ctx.organizationId,
          origin,
          {
            gainLossAccountId: saved.gainLossAccountId,
          },
        );
        return { gainLossAccountId: saved.gainLossAccountId, version: saved.version };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------

  private categoryView(c: AssetCategory) {
    return {
      id: c.id,
      name: c.name,
      costAccountId: c.costAccountId,
      accumulatedAccountId: c.accumulatedAccountId,
      expenseAccountId: c.expenseAccountId,
      defaultLifeMonths: c.defaultLifeMonths,
      status: c.status,
      version: c.version,
    };
  }

  listCategories(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listCategories(tx, ctx.organizationId)).map((c) => this.categoryView(c)),
      }),
    );
  }

  private async categoryIssues(
    tx: Transaction,
    organizationId: string,
    input: CategoryInput,
    exceptId?: string,
  ): Promise<ValidationIssue[]> {
    const issues: ValidationIssue[] = [];
    const check = async (
      path: 'costAccountId' | 'accumulatedAccountId' | 'expenseAccountId',
      type: 'ASSET' | 'EXPENSE',
    ) => {
      const id = input[path];
      const account = await getAccount(tx, organizationId, id);
      const problem =
        postingAccountProblem(account, await this.designated(tx, organizationId, id)) ??
        (account && account.accountType !== type
          ? type === 'ASSET'
            ? 'Choose an asset account.'
            : 'Choose an expense account.'
          : null);
      if (problem) issues.push({ path, message: problem });
    };
    await check('costAccountId', 'ASSET');
    await check('accumulatedAccountId', 'ASSET');
    await check('expenseAccountId', 'EXPENSE');
    if (
      input.costAccountId === input.accumulatedAccountId ||
      input.costAccountId === input.expenseAccountId ||
      input.accumulatedAccountId === input.expenseAccountId
    ) {
      issues.push({ path: 'costAccountId', message: 'Use three different accounts.' });
    }
    if (await findCategoryByName(tx, organizationId, input.name.trim(), exceptId)) {
      issues.push({ path: 'name', message: 'Another category has this name.' });
    }
    return issues;
  }

  createCategory(principal: Principal, input: CategoryInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      async (tx, ctx) => {
        const issues = await this.categoryIssues(tx, ctx.organizationId, input);
        if (issues.length) throw new ValidationError(issues);
        const now = this.now;
        const category = await insertCategory(tx, {
          organizationId: ctx.organizationId,
          name: input.name.trim(),
          costAccountId: input.costAccountId,
          accumulatedAccountId: input.accumulatedAccountId,
          expenseAccountId: input.expenseAccountId,
          defaultLifeMonths: input.defaultLifeMonths,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit(
          tx,
          ctx,
          'fixed_asset_category.created',
          CATEGORY_RESOURCE,
          category.id,
          origin,
          {
            name: category.name,
          },
        );
        return this.categoryView(category);
      },
    );
  }

  updateCategory(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      costAccountId?: string | undefined;
      accumulatedAccountId?: string | undefined;
      expenseAccountId?: string | undefined;
      defaultLifeMonths?: number | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      async (tx, ctx) => {
        const current = await getCategory(tx, ctx.organizationId, id);
        if (!current) throw new NotFoundError('Category not found.');
        if (current.version !== input.version) throw versionConflict('category');
        const next: CategoryInput = {
          name: input.name ?? current.name,
          costAccountId: input.costAccountId ?? current.costAccountId,
          accumulatedAccountId: input.accumulatedAccountId ?? current.accumulatedAccountId,
          expenseAccountId: input.expenseAccountId ?? current.expenseAccountId,
          defaultLifeMonths: input.defaultLifeMonths ?? current.defaultLifeMonths,
        };
        const accountsChanged =
          next.costAccountId !== current.costAccountId ||
          next.accumulatedAccountId !== current.accumulatedAccountId ||
          next.expenseAccountId !== current.expenseAccountId;
        if (accountsChanged && (await categoryHasAssets(tx, ctx.organizationId, id))) {
          throw invalidState('The category has assets; its accounts cannot change.');
        }
        const issues = await this.categoryIssues(tx, ctx.organizationId, next, id);
        if (issues.length) throw new ValidationError(issues);
        const updated = await updateCategory(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            ...next,
            name: next.name.trim(),
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('category');
        await this.audit(tx, ctx, 'fixed_asset_category.updated', CATEGORY_RESOURCE, id, origin, {
          name: updated.name,
        });
        return this.categoryView(updated);
      },
    );
  }

  setCategoryStatus(
    principal: Principal,
    id: string,
    status: 'ACTIVE' | 'ARCHIVED',
    input: { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      async (tx, ctx) => {
        const current = await getCategory(tx, ctx.organizationId, id);
        if (!current) throw new NotFoundError('Category not found.');
        if (current.version !== input.version) throw versionConflict('category');
        if (current.status === status)
          throw invalidState(`The category is already ${status.toLowerCase()}.`);
        const updated = await updateCategory(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status, updatedByUserId: ctx.userId, updatedAt: this.now },
        });
        if (!updated) throw versionConflict('category');
        await this.audit(
          tx,
          ctx,
          status === 'ARCHIVED' ? 'fixed_asset_category.archived' : 'fixed_asset_category.restored',
          CATEGORY_RESOURCE,
          id,
          origin,
          {},
        );
        return this.categoryView(updated);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Assets: the register
  // ---------------------------------------------------------------------------

  private async assetView(tx: Transaction, organizationId: string, a: FixedAsset, scale: number) {
    const category = await getCategory(tx, organizationId, a.categoryId);
    const accumulated = decimal(a.accumulatedDepreciation);
    return {
      id: a.id,
      number: a.number,
      name: a.name,
      description: a.description,
      categoryId: a.categoryId,
      categoryName: category?.name ?? null,
      acquisitionDate: a.acquisitionDate,
      inServiceDate: a.inServiceDate,
      cost: decimal(a.cost).toFixed(scale),
      salvageValue: decimal(a.salvageValue).toFixed(scale),
      lifeMonths: a.lifeMonths,
      depreciationMethod: a.depreciationMethod,
      decliningRate: a.decliningRate === null ? null : decimal(a.decliningRate).toFixed(4),
      // Double-declining derives its annual rate from the life (display only, never stored).
      doubleDecliningRate:
        a.depreciationMethod === 'double_declining_balance'
          ? decimal(2400).div(a.lifeMonths).toFixed(4)
          : null,
      accumulatedDepreciation: accumulated.toFixed(scale),
      bookValue: decimal(a.cost).minus(accumulated).toFixed(scale),
      status: a.status,
      location: a.location,
      custodian: a.custodian,
      serialNumber: a.serialNumber,
      inLedger: a.inLedger,
      sourceBillId: a.sourceBillId,
      acquisitionJournalId: a.acquisitionJournalId,
      version: a.version,
    };
  }

  listAssets(
    principal: Principal,
    query: {
      status?: 'ACTIVE' | 'DISPOSED' | undefined;
      categoryId?: string | undefined;
      search?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        let after: { name: string; id: string } | undefined;
        if (query.after) {
          try {
            const parsed = JSON.parse(Buffer.from(query.after, 'base64url').toString('utf8')) as {
              n: string;
              i: string;
            };
            if (typeof parsed.n !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.i))
              throw new Error('bad');
            after = { name: parsed.n, id: parsed.i };
          } catch {
            throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
          }
        }
        const scale = await this.scale(tx, ctx.organizationId);
        const page = await listAssets(tx, {
          organizationId: ctx.organizationId,
          status: query.status,
          categoryId: query.categoryId,
          search: query.search?.trim() || undefined,
          limit: query.limit,
          after,
        });
        const items = [];
        for (const asset of page.items)
          items.push(await this.assetView(tx, ctx.organizationId, asset, scale));
        const last = page.items.at(-1);
        return {
          items,
          nextCursor:
            page.hasMore && last
              ? Buffer.from(JSON.stringify({ n: last.name.toLowerCase(), i: last.id })).toString(
                  'base64url',
                )
              : null,
        };
      },
    );
  }

  /**
   * The schedule an asset would get, before it is registered (R-11): nothing is saved. The
   * warnings are informational and never block registration: the declining methods can come out
   * identical to straight line, and an asset whose cost equals its salvage has nothing to
   * depreciate.
   */
  previewSchedule(principal: Principal, input: SchedulePreviewInput) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage, readOnlySnapshot: true },
      async (tx, ctx) => {
        const issues: ValidationIssue[] = [];
        const scale = await this.scale(tx, ctx.organizationId);
        const { inServiceDate, cost, salvage } = validateScheduleTerms(input, scale, issues);
        const method = validateMethod(input, issues);
        const category = await getCategory(tx, ctx.organizationId, input.categoryId);
        if (!category || category.status !== 'ACTIVE') {
          issues.push({ path: 'categoryId', message: 'Choose an active category.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const asset: DepreciableAsset = {
          cost: cost.toFixed(4),
          salvageValue: salvage.toFixed(4),
          lifeMonths: input.lifeMonths ?? category!.defaultLifeMonths,
          inServiceDate,
          depreciationMethod: method.depreciationMethod,
          decliningRate: method.decliningRate,
        };
        return {
          depreciationMethod: method.depreciationMethod,
          lifeMonths: asset.lifeMonths,
          warnings: scheduleWarnings(asset, scale),
          schedule: scheduleOf(asset, scale),
        };
      },
    );
  }

  getAsset(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const asset = await getAsset(tx, ctx.organizationId, id);
        if (!asset) throw new NotFoundError('Fixed asset not found.');
        const scale = await this.scale(tx, ctx.organizationId);
        const accumulated = decimal(asset.accumulatedDepreciation);
        const schedule = scheduleOf(
          {
            cost: asset.cost,
            salvageValue: asset.salvageValue,
            lifeMonths: asset.lifeMonths,
            inServiceDate: asset.inServiceDate,
            depreciationMethod: asset.depreciationMethod,
            decliningRate: asset.decliningRate,
          },
          scale,
        ).map((row) => ({ ...row, booked: decimal(row.accumulated).lte(accumulated) }));
        const entries = await listAssetEntries(tx, ctx.organizationId, id);
        const transfers = await listTransfers(tx, ctx.organizationId, id);
        const disposals = await listDisposals(tx, ctx.organizationId, id, 20);
        return {
          ...(await this.assetView(tx, ctx.organizationId, asset, scale)),
          schedule,
          entries: entries.map((e) => ({
            id: e.id,
            date: e.entryDate,
            kind: e.kind,
            costChange: e.costChange,
            accumulatedChange: e.accumulatedChange,
            sourceType: e.sourceType,
            sourceId: e.sourceId,
            journalId: e.journalId,
          })),
          transfers: transfers.map((t) => ({
            id: t.id,
            date: t.transferDate,
            fromCategoryId: t.fromCategoryId,
            toCategoryId: t.toCategoryId,
            fromLocation: t.fromLocation,
            toLocation: t.toLocation,
            journalId: t.journalId,
          })),
          disposals: disposals.map((d) => this.disposalView(d)),
        };
      },
    );
  }

  createAsset(
    principal: Principal,
    input: AssetInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'fixed_assets.asset.create', request: input },
          () => this.createInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async createInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: AssetInput,
    origin: EventOrigin,
  ) {
    const issues: ValidationIssue[] = [];
    const scale = await this.scale(tx, ctx.organizationId);
    const { inServiceDate, cost, salvage } = validateScheduleTerms(input, scale, issues);
    const method = validateMethod(input, issues);
    const category = await getCategory(tx, ctx.organizationId, input.categoryId);
    if (!category || category.status !== 'ACTIVE') {
      issues.push({ path: 'categoryId', message: 'Choose an active category.' });
    }
    if (!input.alreadyInLedger) {
      if (!input.creditAccountId) {
        issues.push({
          path: 'creditAccountId',
          message: 'Choose the account the cost is paid from, or mark it as already in the ledger.',
        });
      } else {
        const account = await getAccount(tx, ctx.organizationId, input.creditAccountId);
        const problem = postingAccountProblem(
          account,
          await this.designated(tx, ctx.organizationId, input.creditAccountId),
        );
        if (problem) issues.push({ path: 'creditAccountId', message: problem });
        else if (category && input.creditAccountId === category.costAccountId) {
          issues.push({
            path: 'creditAccountId',
            message: 'Choose an account other than the asset account.',
          });
        }
      }
    }
    if (input.sourceBillId && !input.alreadyInLedger) {
      issues.push({
        path: 'sourceBillId',
        message:
          'An asset bought on a bill is already in the ledger; mark it as already in the ledger instead of posting it again.',
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const overrideReason = await this.guardDuplicateCapitalization(tx, ctx, input, category!, cost);
    if (!input.alreadyInLedger)
      await assertOpenPeriod(tx, ctx.organizationId, input.acquisitionDate);
    const now = this.now;
    const id = randomUUID();
    const number = await this.nextNumber(tx, ctx.organizationId, 'asset');
    let journalId: string | null = null;
    if (!input.alreadyInLedger) {
      const builder = new LineBuilder(`Asset ${number} — ${input.name.trim()}`);
      builder.debit(category!.costAccountId, cost);
      builder.credit(input.creditAccountId!, cost);
      const posted = await this.post(
        tx,
        ctx,
        {
          eventType: ASSET_ACQUISITION_EVENT,
          eventKey: `fixed_asset:${id}:acquired`,
          payload: { assetId: id, number },
          date: input.acquisitionDate,
          description: `Fixed asset ${number} — ${input.name.trim()}`,
          reference: number,
          sourceType: 'asset',
          sourceId: id,
          lines: builder.lines(),
        },
        origin,
      );
      journalId = posted.journalId;
    }
    const asset = await insertAsset(tx, {
      id,
      organizationId: ctx.organizationId,
      number,
      name: input.name.trim(),
      description: input.description?.trim() ?? '',
      categoryId: input.categoryId,
      acquisitionDate: input.acquisitionDate,
      inServiceDate,
      cost: cost.toFixed(4),
      salvageValue: salvage.toFixed(4),
      lifeMonths: input.lifeMonths ?? category!.defaultLifeMonths,
      depreciationMethod: method.depreciationMethod,
      decliningRate: method.decliningRate,
      location: input.location?.trim() ?? '',
      custodian: input.custodian?.trim() ?? '',
      serialNumber: input.serialNumber?.trim() ?? '',
      acquisitionJournalId: journalId,
      inLedger: Boolean(input.alreadyInLedger),
      sourceBillId: input.sourceBillId ?? null,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    await insertEntries(tx, [
      {
        organizationId: ctx.organizationId,
        assetId: id,
        entryDate: input.acquisitionDate,
        kind: 'acquisition',
        costChange: cost.toFixed(4),
        accumulatedChange: '0',
        sourceType: 'asset',
        sourceId: id,
        journalId,
        createdByUserId: ctx.userId,
        createdAt: now,
      },
    ]);
    await this.audit(tx, ctx, 'fixed_asset.registered', ASSET_RESOURCE, id, origin, {
      number,
      cost: asset.cost,
      categoryId: asset.categoryId,
      lifeMonths: asset.lifeMonths,
      depreciationMethod: asset.depreciationMethod,
      decliningRate: asset.decliningRate,
      journalId,
      alreadyInLedger: asset.inLedger,
      sourceBillId: asset.sourceBillId,
    });
    if (overrideReason) {
      await this.audit(
        tx,
        ctx,
        'fixed_asset.duplicate_capitalization_confirmed',
        ASSET_RESOURCE,
        id,
        origin,
        {
          number,
          reason: overrideReason,
        },
      );
    }
    return this.assetView(tx, ctx.organizationId, asset, scale);
  }

  /**
   * Double-capitalization guard. A bill that debited the category cost account has already
   * capitalized the purchase:
   * - with `sourceBillId` the bill must be posted, have debited that account, and still have at
   *   least the asset cost unlinked (checked under a lock on the bill);
   * - without a link and without `alreadyInLedger`, a posted bill dated within 31 days that
   *   debited the same account and has at least the cost unlinked blocks the registration unless
   *   a reason confirms it is a different purchase.
   * Returns the confirmation reason, if one was needed.
   */
  private async guardDuplicateCapitalization(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: AssetInput,
    category: { costAccountId: string },
    cost: Decimal,
  ): Promise<string | null> {
    if (input.sourceBillId) {
      await lockBillForAssets(tx, ctx.organizationId, input.sourceBillId);
      const [bill] = await capitalizingBills(tx, {
        organizationId: ctx.organizationId,
        costAccountId: category.costAccountId,
        billId: input.sourceBillId,
      });
      if (!bill) {
        throw new ValidationError([
          {
            path: 'sourceBillId',
            message:
              'Choose a posted bill that debited this category asset account (it was not found).',
          },
        ]);
      }
      const left = decimal(bill.capitalized).minus(bill.linked);
      if (cost.gt(left)) {
        throw new ConflictError(
          'DUPLICATE_CAPITALIZATION',
          `Bill ${bill.number ?? ''} capitalized ${decimal(bill.capitalized).toFixed(2)}, of which ${decimal(bill.linked).toFixed(2)} is already registered; only ${left.toFixed(2)} is left to link.`,
        );
      }
      return null;
    }
    if (input.alreadyInLedger) return null;
    const near = await capitalizingBills(tx, {
      organizationId: ctx.organizationId,
      costAccountId: category.costAccountId,
      near: { date: input.acquisitionDate, days: 31 },
    });
    const matches = near.filter((b) => decimal(b.capitalized).minus(b.linked).gte(cost));
    if (matches.length === 0) return null;
    const reason = input.duplicateOverrideReason?.trim() ?? '';
    if (reason.length >= 3) return reason;
    throw new ConflictError(
      'DUPLICATE_CAPITALIZATION',
      `Bill ${matches.map((b) => b.number ?? b.id).join(', ')} already debited this asset account for at least ${cost.toFixed(2)}. Register the asset as already in the ledger and link the bill, or confirm it is a different purchase with a reason.`,
    );
  }

  private async nextNumber(tx: Transaction, organizationId: string, type: 'asset' | 'run') {
    const exists = type === 'asset' ? assetNumberExists : runNumberExists;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextAssetNumber(tx, organizationId, type);
      if (!(await exists(tx, organizationId, number))) return number;
    }
    throw new AppError('CONFLICT', 409, 'Could not find a free number; check the numbering.');
  }

  updateAsset(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      description?: string | undefined;
      location?: string | undefined;
      custodian?: string | undefined;
      serialNumber?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      async (tx, ctx) => {
        const asset = await getAsset(tx, ctx.organizationId, id, { forUpdate: true });
        if (!asset) throw new NotFoundError('Fixed asset not found.');
        if (asset.version !== input.version) throw versionConflict('asset');
        const updated = await updateAsset(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.description !== undefined ? { description: input.description.trim() } : {}),
            ...(input.location !== undefined ? { location: input.location.trim() } : {}),
            ...(input.custodian !== undefined ? { custodian: input.custodian.trim() } : {}),
            ...(input.serialNumber !== undefined
              ? { serialNumber: input.serialNumber.trim() }
              : {}),
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('asset');
        await this.audit(tx, ctx, 'fixed_asset.updated', ASSET_RESOURCE, id, origin, {
          name: updated.name,
          location: updated.location,
          custodian: updated.custodian,
        });
        return this.assetView(
          tx,
          ctx.organizationId,
          updated,
          await this.scale(tx, ctx.organizationId),
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Transfers (to another category and/or location)
  // ---------------------------------------------------------------------------

  transferAsset(
    principal: Principal,
    id: string,
    input: {
      version: number;
      transferDate: string;
      toCategoryId?: string | undefined;
      toLocation?: string | undefined;
      memo?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Manage },
      async (tx, ctx) => {
        const asset = await getAsset(tx, ctx.organizationId, id, { forUpdate: true });
        if (!asset) throw new NotFoundError('Fixed asset not found.');
        if (asset.version !== input.version) throw versionConflict('asset');
        if (asset.status !== 'ACTIVE')
          throw invalidState('A disposed asset cannot be transferred.');
        const issues: ValidationIssue[] = [];
        if (!isValidIsoDate(input.transferDate)) {
          issues.push({ path: 'transferDate', message: 'Enter a valid date (YYYY-MM-DD).' });
        }
        const toCategoryId = input.toCategoryId ?? asset.categoryId;
        const to = await getCategory(tx, ctx.organizationId, toCategoryId);
        if (!to || (toCategoryId !== asset.categoryId && to.status !== 'ACTIVE')) {
          issues.push({ path: 'toCategoryId', message: 'Choose an active category.' });
        }
        const toLocation = input.toLocation?.trim() ?? asset.location;
        if (toCategoryId === asset.categoryId && toLocation === asset.location) {
          issues.push({ path: 'toCategoryId', message: 'Change the category or the location.' });
        }
        if (issues.length) throw new ValidationError(issues);
        const from = (await getCategory(tx, ctx.organizationId, asset.categoryId))!;
        const now = this.now;
        const cost = decimal(asset.cost);
        const accumulated = decimal(asset.accumulatedDepreciation);
        // The books move only when the accounts differ.
        const builder = new LineBuilder(`Transfer of asset ${asset.number}`);
        builder.debit(to!.costAccountId, cost);
        builder.credit(from.costAccountId, cost);
        builder.debit(from.accumulatedAccountId, accumulated);
        builder.credit(to!.accumulatedAccountId, accumulated);
        const lines = builder.lines();
        const transferId = randomUUID();
        let posted: { journalId: string; eventId: string } | null = null;
        if (lines.length) {
          await assertOpenPeriod(tx, ctx.organizationId, input.transferDate);
          posted = await this.post(
            tx,
            ctx,
            {
              eventType: ASSET_TRANSFER_EVENT,
              eventKey: `fixed_asset_transfer:${transferId}:posted`,
              payload: { transferId, assetId: id },
              date: input.transferDate,
              description: `Transfer of fixed asset ${asset.number} from ${from.name} to ${to!.name}`,
              reference: asset.number,
              sourceType: 'transfer',
              sourceId: transferId,
              lines,
            },
            origin,
          );
        }
        await insertTransfer(tx, {
          id: transferId,
          organizationId: ctx.organizationId,
          assetId: id,
          transferDate: input.transferDate,
          fromCategoryId: asset.categoryId,
          toCategoryId,
          fromLocation: asset.location,
          toLocation,
          cost: cost.toFixed(4),
          accumulatedDepreciation: accumulated.toFixed(4),
          memo: input.memo?.trim() ?? '',
          journalId: posted?.journalId ?? null,
          accountingEventId: posted?.eventId ?? null,
          createdByUserId: ctx.userId,
          createdAt: now,
        });
        const updated = await updateAsset(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            categoryId: toCategoryId,
            location: toLocation,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict('asset');
        await this.audit(tx, ctx, 'fixed_asset.transferred', ASSET_RESOURCE, id, origin, {
          fromCategoryId: asset.categoryId,
          toCategoryId,
          toLocation,
          journalId: posted?.journalId ?? null,
        });
        return this.assetView(
          tx,
          ctx.organizationId,
          updated,
          await this.scale(tx, ctx.organizationId),
        );
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Depreciation
  // ---------------------------------------------------------------------------

  private validateMonthEnd(monthEnd: string) {
    if (!isValidIsoDate(monthEnd) || monthEnd !== monthEndOf(monthEnd)) {
      throw new ValidationError([{ path: 'monthEnd', message: 'Choose the last day of a month.' }]);
    }
    if (monthEnd > monthEndOf(this.now.toISOString().slice(0, 10))) {
      throw new ValidationError([
        { path: 'monthEnd', message: 'Depreciation cannot run for a future month.' },
      ]);
    }
  }

  private async dueLines(
    tx: Transaction,
    organizationId: string,
    assets: readonly FixedAsset[],
    monthEnd: string,
    scale: number,
  ) {
    const categories = await getCategories(
      tx,
      organizationId,
      assets.map((a) => a.categoryId),
    );
    const lines = [];
    for (const asset of assets) {
      const due = depreciationDue(
        {
          cost: asset.cost,
          salvageValue: asset.salvageValue,
          lifeMonths: asset.lifeMonths,
          inServiceDate: asset.inServiceDate,
          depreciationMethod: asset.depreciationMethod,
          decliningRate: asset.decliningRate,
          accumulatedDepreciation: asset.accumulatedDepreciation,
        },
        monthEnd,
        scale,
      );
      if (!due.gt(0)) continue;
      const category = categories.get(asset.categoryId)!;
      const after = decimal(asset.accumulatedDepreciation).plus(due);
      lines.push({ asset, category, amount: due, accumulatedAfter: after });
    }
    return lines;
  }

  previewDepreciation(principal: Principal, monthEnd: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        this.validateMonthEnd(monthEnd);
        const scale = await this.scale(tx, ctx.organizationId);
        const assets = await lockActiveAssetsReadOnly(tx, ctx.organizationId);
        const lines = await this.dueLines(tx, ctx.organizationId, assets, monthEnd, scale);
        const latest = await latestPostedRun(tx, ctx.organizationId);
        return {
          monthEnd,
          latestRunMonthEnd: latest?.monthEnd ?? null,
          canRun: !latest || monthEnd > latest.monthEnd,
          total: lines.reduce((s, l) => s.plus(l.amount), decimal(0)).toFixed(scale),
          lines: lines.map((l) => ({
            assetId: l.asset.id,
            number: l.asset.number,
            name: l.asset.name,
            categoryName: l.category.name,
            amount: l.amount.toFixed(scale),
            accumulatedAfter: l.accumulatedAfter.toFixed(scale),
            bookValueAfter: decimal(l.asset.cost).minus(l.accumulatedAfter).toFixed(scale),
          })),
        };
      },
    );
  }

  runDepreciation(
    principal: Principal,
    input: { monthEnd: string },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Depreciate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'fixed_assets.depreciation.run', request: input },
          () => this.runInTransaction(tx, ctx, input.monthEnd, origin),
        ),
    );
  }

  private async runInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    monthEnd: string,
    origin: EventOrigin,
  ) {
    this.validateMonthEnd(monthEnd);
    const latest = await latestPostedRun(tx, ctx.organizationId, { forUpdate: true });
    if (latest && monthEnd <= latest.monthEnd) {
      throw invalidState(
        `Depreciation has run through ${latest.monthEnd}; run a later month, or void the later runs first.`,
      );
    }
    await assertOpenPeriod(tx, ctx.organizationId, monthEnd);
    const scale = await this.scale(tx, ctx.organizationId);
    const assets = await lockActiveAssets(tx, ctx.organizationId);
    const lines = await this.dueLines(tx, ctx.organizationId, assets, monthEnd, scale);
    if (!lines.length) throw invalidState('There is no depreciation to book for this month.');
    const now = this.now;
    const runId = randomUUID();
    const number = await this.nextNumber(tx, ctx.organizationId, 'run');
    const builder = new LineBuilder(`Depreciation ${number} — ${monthEnd.slice(0, 7)}`);
    for (const line of lines) {
      builder.debit(line.category.expenseAccountId, line.amount);
      builder.credit(line.category.accumulatedAccountId, line.amount);
    }
    const total = lines.reduce((sum, l) => sum.plus(l.amount), decimal(0));
    const posted = await this.post(
      tx,
      ctx,
      {
        eventType: ASSET_DEPRECIATION_EVENT,
        eventKey: `fixed_asset_run:${runId}:posted`,
        payload: { runId, number, monthEnd },
        date: monthEnd,
        description: `Depreciation ${number} — ${monthEnd.slice(0, 7)}`,
        reference: number,
        sourceType: 'depreciation_run',
        sourceId: runId,
        lines: builder.lines(),
      },
      origin,
    );
    const run = await insertRun(tx, {
      id: runId,
      organizationId: ctx.organizationId,
      number,
      monthEnd,
      totalAmount: total.toFixed(4),
      assetCount: lines.length,
      journalId: posted.journalId,
      accountingEventId: posted.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    await insertEntries(
      tx,
      lines.map((l) => ({
        organizationId: ctx.organizationId,
        assetId: l.asset.id,
        entryDate: monthEnd,
        kind: 'depreciation' as const,
        costChange: '0',
        accumulatedChange: l.amount.toFixed(4),
        sourceType: 'depreciation_run',
        sourceId: runId,
        journalId: posted.journalId,
        createdByUserId: ctx.userId,
        createdAt: now,
      })),
    );
    for (const line of lines) {
      await updateAsset(tx, {
        organizationId: ctx.organizationId,
        id: line.asset.id,
        set: {
          accumulatedDepreciation: line.accumulatedAfter.toFixed(4),
          updatedByUserId: ctx.userId,
          updatedAt: now,
        },
      });
    }
    await this.audit(tx, ctx, 'fixed_asset_run.posted', RUN_RESOURCE, runId, origin, {
      number,
      monthEnd,
      total: run.totalAmount,
      assets: lines.length,
      journalId: posted.journalId,
    });
    return this.runDetail(tx, ctx.organizationId, run);
  }

  private async runDetail(tx: Transaction, organizationId: string, run: DepreciationRun) {
    const scale = await this.scale(tx, organizationId);
    const entries = await listEntriesBySource(
      tx,
      organizationId,
      'depreciation_run',
      run.id,
      'depreciation',
    );
    const assets = await lockAssetsReadOnly(
      tx,
      organizationId,
      entries.map((e) => e.assetId),
    );
    return {
      id: run.id,
      number: run.number,
      monthEnd: run.monthEnd,
      status: run.status,
      total: decimal(run.totalAmount).toFixed(scale),
      assetCount: run.assetCount,
      journalId: run.journalId,
      voidJournalId: run.voidJournalId,
      voidedAt: run.voidedAt?.toISOString() ?? null,
      voidReason: run.voidReason,
      version: run.version,
      lines: entries.map((e) => ({
        assetId: e.assetId,
        number: assets.get(e.assetId)?.number ?? null,
        name: assets.get(e.assetId)?.name ?? null,
        amount: decimal(e.accumulatedChange).toFixed(scale),
      })),
    };
  }

  listRuns(principal: Principal, limit: number) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const scale = await this.scale(tx, ctx.organizationId);
        return {
          items: (await listRuns(tx, ctx.organizationId, limit)).map((r) => ({
            id: r.id,
            number: r.number,
            monthEnd: r.monthEnd,
            status: r.status,
            total: decimal(r.totalAmount).toFixed(scale),
            assetCount: r.assetCount,
            journalId: r.journalId,
            version: r.version,
          })),
        };
      },
    );
  }

  getRun(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id);
        if (!run) throw new NotFoundError('Depreciation run not found.');
        return this.runDetail(tx, ctx.organizationId, run);
      },
    );
  }

  voidRun(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const run = await getRun(tx, ctx.organizationId, id, { forUpdate: true });
        if (!run) throw new NotFoundError('Depreciation run not found.');
        if (run.version !== input.version) throw versionConflict('depreciation run');
        if (run.status !== 'POSTED') throw invalidState('The depreciation run is already void.');
        const latest = await latestPostedRun(tx, ctx.organizationId, { forUpdate: true });
        if (latest?.id !== run.id) {
          throw invalidState(
            'Only the latest depreciation run can be voided; void the later runs first.',
          );
        }
        const entries = await listEntriesBySource(
          tx,
          ctx.organizationId,
          'depreciation_run',
          id,
          'depreciation',
        );
        const assets = await lockAssets(
          tx,
          ctx.organizationId,
          entries.map((e) => e.assetId),
        );
        for (const entry of entries) {
          if (assets.get(entry.assetId)?.status !== 'ACTIVE') {
            throw invalidState(
              'An asset of this run has been disposed of; void its disposal first.',
            );
          }
        }
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'fixed_assets',
          run.journalId!,
          { reason: `Depreciation ${run.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        await insertEntries(
          tx,
          entries.map((e) => ({
            organizationId: ctx.organizationId,
            assetId: e.assetId,
            entryDate: e.entryDate,
            kind: 'depreciation_void' as const,
            costChange: '0',
            accumulatedChange: decimal(e.accumulatedChange).negated().toFixed(4),
            sourceType: 'depreciation_run',
            sourceId: id,
            journalId: reversal.id,
            createdByUserId: ctx.userId,
            createdAt: now,
          })),
        );
        for (const entry of entries) {
          const asset = assets.get(entry.assetId)!;
          await updateAsset(tx, {
            organizationId: ctx.organizationId,
            id: asset.id,
            set: {
              accumulatedDepreciation: decimal(asset.accumulatedDepreciation)
                .minus(entry.accumulatedChange)
                .toFixed(4),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          });
        }
        const voided = await updateRun(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict('depreciation run');
        await this.audit(tx, ctx, 'fixed_asset_run.voided', RUN_RESOURCE, id, origin, {
          number: run.number,
          reason,
          reversalJournalId: reversal.id,
        });
        return this.runDetail(tx, ctx.organizationId, voided);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  private disposalView(d: AssetDisposal) {
    return {
      id: d.id,
      assetId: d.assetId,
      date: d.disposalDate,
      proceeds: d.proceeds,
      proceedsAccountId: d.proceedsAccountId,
      catchupDepreciation: d.catchupDepreciation,
      cost: d.cost,
      accumulatedDepreciation: d.accumulatedDepreciation,
      gainLoss: d.gainLoss,
      memo: d.memo,
      status: d.status,
      journalId: d.journalId,
      voidJournalId: d.voidJournalId,
      voidReason: d.voidReason,
      version: d.version,
    };
  }

  disposeAsset(
    principal: Principal,
    id: string,
    input: {
      version: number;
      disposalDate: string;
      proceeds?: string | undefined;
      proceedsAccountId?: string | undefined;
      memo?: string | undefined;
    },
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Dispose },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'fixed_assets.asset.dispose',
            request: { id, ...input },
          },
          () => this.disposeInTransaction(tx, ctx, id, input, origin),
        ),
    );
  }

  private async disposeInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    input: {
      version: number;
      disposalDate: string;
      proceeds?: string | undefined;
      proceedsAccountId?: string | undefined;
      memo?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    const asset = await getAsset(tx, ctx.organizationId, id, { forUpdate: true });
    if (!asset) throw new NotFoundError('Fixed asset not found.');
    if (asset.version !== input.version) throw versionConflict('asset');
    if (asset.status !== 'ACTIVE') throw invalidState('The asset has already been disposed of.');
    const scale = await this.scale(tx, ctx.organizationId);
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.disposalDate)) {
      issues.push({ path: 'disposalDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    } else if (input.disposalDate < asset.acquisitionDate) {
      issues.push({
        path: 'disposalDate',
        message: 'The asset cannot be disposed of before it was acquired.',
      });
    }
    const proceeds = decimal(input.proceeds ?? '0');
    if (proceeds.lt(0) || proceeds.decimalPlaces() > scale) {
      issues.push({
        path: 'proceeds',
        message: `Enter the proceeds with at most ${scale} decimals.`,
      });
    }
    if (proceeds.gt(0)) {
      if (!input.proceedsAccountId) {
        issues.push({
          path: 'proceedsAccountId',
          message: 'Choose the account the proceeds go to.',
        });
      } else {
        const problem = postingAccountProblem(
          await getAccount(tx, ctx.organizationId, input.proceedsAccountId),
          await this.designated(tx, ctx.organizationId, input.proceedsAccountId),
        );
        if (problem) issues.push({ path: 'proceedsAccountId', message: problem });
      }
    }
    const settings = await getAssetSettings(tx, ctx.organizationId);
    if (!settings?.gainLossAccountId) {
      issues.push({
        path: 'gainLossAccountId',
        message:
          'Choose the gain/loss account in the fixed asset settings before disposing of assets.',
      });
    }
    if (issues.length) throw new ValidationError(issues);

    // Depreciation is caught up to the end of the month before the disposal.
    const through = previousMonthEnd(input.disposalDate);
    const expected = scheduledAccumulated(asset, through, scale);
    const booked = decimal(asset.accumulatedDepreciation);
    if (booked.gt(expected)) {
      throw invalidState(
        'Depreciation has been booked beyond the disposal month; void the later depreciation runs first.',
      );
    }
    const catchup = expected.minus(booked);
    const category = (await getCategory(tx, ctx.organizationId, asset.categoryId))!;
    const cost = decimal(asset.cost);
    const accumulatedAfter = booked.plus(catchup);
    const bookValue = cost.minus(accumulatedAfter);
    const gainLoss = proceeds.minus(bookValue);
    await assertOpenPeriod(tx, ctx.organizationId, input.disposalDate);
    const now = this.now;
    const disposalId = randomUUID();
    const builder = new LineBuilder(`Disposal of asset ${asset.number} — ${asset.name}`);
    builder.debit(category.expenseAccountId, catchup);
    builder.debit(category.accumulatedAccountId, booked);
    builder.credit(category.costAccountId, cost);
    if (proceeds.gt(0)) builder.debit(input.proceedsAccountId!, proceeds);
    if (gainLoss.gt(0)) builder.credit(settings!.gainLossAccountId!, gainLoss);
    else if (gainLoss.lt(0)) builder.debit(settings!.gainLossAccountId!, gainLoss.abs());
    const posted = await this.post(
      tx,
      ctx,
      {
        eventType: ASSET_DISPOSAL_EVENT,
        eventKey: `fixed_asset_disposal:${disposalId}:posted`,
        payload: { disposalId, assetId: id },
        date: input.disposalDate,
        description: `Disposal of fixed asset ${asset.number} — ${asset.name}`,
        reference: asset.number,
        sourceType: 'disposal',
        sourceId: disposalId,
        lines: builder.lines(),
      },
      origin,
    );
    const disposal = await insertDisposal(tx, {
      id: disposalId,
      organizationId: ctx.organizationId,
      assetId: id,
      disposalDate: input.disposalDate,
      proceeds: proceeds.toFixed(4),
      proceedsAccountId: proceeds.gt(0) ? input.proceedsAccountId! : null,
      catchupDepreciation: catchup.toFixed(4),
      cost: cost.toFixed(4),
      accumulatedDepreciation: accumulatedAfter.toFixed(4),
      gainLoss: gainLoss.toFixed(4),
      memo: input.memo?.trim() ?? '',
      journalId: posted.journalId,
      accountingEventId: posted.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    const entries: Parameters<typeof insertEntries>[1] = [];
    if (catchup.gt(0)) {
      entries.push({
        organizationId: ctx.organizationId,
        assetId: id,
        entryDate: input.disposalDate,
        kind: 'depreciation' as const,
        costChange: '0',
        accumulatedChange: catchup.toFixed(4),
        sourceType: 'disposal',
        sourceId: disposalId,
        journalId: posted.journalId,
        createdByUserId: ctx.userId,
        createdAt: now,
      });
    }
    entries.push({
      organizationId: ctx.organizationId,
      assetId: id,
      entryDate: input.disposalDate,
      kind: 'disposal' as const,
      costChange: cost.negated().toFixed(4),
      accumulatedChange: accumulatedAfter.negated().toFixed(4),
      sourceType: 'disposal',
      sourceId: disposalId,
      journalId: posted.journalId,
      createdByUserId: ctx.userId,
      createdAt: now,
    });
    await insertEntries(tx, entries);
    const updated = await updateAsset(tx, {
      organizationId: ctx.organizationId,
      id,
      version: input.version,
      set: {
        status: 'DISPOSED',
        accumulatedDepreciation: accumulatedAfter.toFixed(4),
        updatedByUserId: ctx.userId,
        updatedAt: now,
      },
    });
    if (!updated) throw versionConflict('asset');
    await this.audit(tx, ctx, 'fixed_asset.disposed', DISPOSAL_RESOURCE, disposalId, origin, {
      assetId: id,
      number: asset.number,
      proceeds: disposal.proceeds,
      gainLoss: disposal.gainLoss,
      catchupDepreciation: disposal.catchupDepreciation,
      journalId: posted.journalId,
    });
    return this.disposalView(disposal);
  }

  listDisposals(principal: Principal, assetId: string | null) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listDisposals(tx, ctx.organizationId, assetId, 200)).map((d) =>
          this.disposalView(d),
        ),
      }),
    );
  }

  voidDisposal(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const disposal = await getDisposal(tx, ctx.organizationId, id, { forUpdate: true });
        if (!disposal) throw new NotFoundError('Disposal not found.');
        if (disposal.version !== input.version) throw versionConflict('disposal');
        if (disposal.status !== 'POSTED') throw invalidState('The disposal is already void.');
        const asset = (await getAsset(tx, ctx.organizationId, disposal.assetId, {
          forUpdate: true,
        }))!;
        const reason = input.reason.trim();
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'fixed_assets',
          disposal.journalId!,
          { reason: `Disposal of ${asset.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        const catchup = decimal(disposal.catchupDepreciation);
        const entries: Parameters<typeof insertEntries>[1] = [
          {
            organizationId: ctx.organizationId,
            assetId: asset.id,
            entryDate: disposal.disposalDate,
            kind: 'disposal_void' as const,
            costChange: decimal(disposal.cost).toFixed(4),
            accumulatedChange: decimal(disposal.accumulatedDepreciation).toFixed(4),
            sourceType: 'disposal',
            sourceId: id,
            journalId: reversal.id,
            createdByUserId: ctx.userId,
            createdAt: now,
          },
        ];
        if (catchup.gt(0)) {
          entries.push({
            organizationId: ctx.organizationId,
            assetId: asset.id,
            entryDate: disposal.disposalDate,
            kind: 'depreciation_void' as const,
            costChange: '0',
            accumulatedChange: catchup.negated().toFixed(4),
            sourceType: 'disposal',
            sourceId: id,
            journalId: reversal.id,
            createdByUserId: ctx.userId,
            createdAt: now,
          });
        }
        await insertEntries(tx, entries);
        const restored = await updateAsset(tx, {
          organizationId: ctx.organizationId,
          id: asset.id,
          set: {
            status: 'ACTIVE',
            accumulatedDepreciation: decimal(disposal.accumulatedDepreciation)
              .minus(catchup)
              .toFixed(4),
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!restored) throw versionConflict('asset');
        const voided = await updateDisposal(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: reason,
            voidJournalId: reversal.id,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict('disposal');
        await this.audit(tx, ctx, 'fixed_asset.disposal_voided', DISPOSAL_RESOURCE, id, origin, {
          assetId: asset.id,
          reason,
          reversalJournalId: reversal.id,
        });
        return this.disposalView(voided);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  /** The register as of a date, from the entries: cost, accumulated depreciation and book value. */
  register(principal: Principal, asOf: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!isValidIsoDate(asOf)) {
          throw new ValidationError([
            { path: 'asOf', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const scale = await this.scale(tx, ctx.organizationId);
        const balances = await registerAsOf(tx, ctx.organizationId, asOf);
        const page = await listAssets(tx, { organizationId: ctx.organizationId, limit: 5000 });
        const categories = await getCategories(
          tx,
          ctx.organizationId,
          page.items.map((a) => a.categoryId),
        );
        const rows = page.items
          .map((asset) => {
            const balance = balances.get(asset.id);
            const cost = decimal(balance?.cost ?? '0');
            if (cost.isZero()) return null;
            const accumulated = decimal(balance?.accumulated ?? '0');
            return {
              assetId: asset.id,
              number: asset.number,
              name: asset.name,
              categoryName: categories.get(asset.categoryId)?.name ?? null,
              cost,
              accumulated,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        const totalCost = rows.reduce((s, r) => s.plus(r.cost), decimal(0));
        const totalAccumulated = rows.reduce((s, r) => s.plus(r.accumulated), decimal(0));
        return {
          asOf,
          items: rows.map((r) => ({
            assetId: r.assetId,
            number: r.number,
            name: r.name,
            categoryName: r.categoryName,
            cost: r.cost.toFixed(scale),
            accumulatedDepreciation: r.accumulated.toFixed(scale),
            bookValue: r.cost.minus(r.accumulated).toFixed(scale),
          })),
          totals: {
            cost: totalCost.toFixed(scale),
            accumulatedDepreciation: totalAccumulated.toFixed(scale),
            bookValue: totalCost.minus(totalAccumulated).toFixed(scale),
          },
        };
      },
    );
  }

  /** The register against the ledger, by asset account and accumulated depreciation account. */
  reconciliation(principal: Principal, asOf: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: FixedAssetPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        if (!isValidIsoDate(asOf)) {
          throw new ValidationError([
            { path: 'asOf', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const scale = await this.scale(tx, ctx.organizationId);
        const balances = await registerAsOf(tx, ctx.organizationId, asOf);
        const page = await listAssets(tx, { organizationId: ctx.organizationId, limit: 5000 });
        const categories = await getCategories(
          tx,
          ctx.organizationId,
          page.items.map((a) => a.categoryId),
        );
        // Group by the account of the category the asset belonged to at that time (its entries'
        // category is not tracked; the register uses the current category).
        const cost = new Map<string, Decimal>();
        const accumulated = new Map<string, Decimal>();
        for (const asset of page.items) {
          const balance = balances.get(asset.id);
          if (!balance) continue;
          const category = categories.get(asset.categoryId)!;
          cost.set(
            category.costAccountId,
            (cost.get(category.costAccountId) ?? decimal(0)).plus(balance.cost),
          );
          accumulated.set(
            category.accumulatedAccountId,
            (accumulated.get(category.accumulatedAccountId) ?? decimal(0)).plus(
              balance.accumulated,
            ),
          );
        }
        const rows = [];
        for (const [accountId, register] of cost) {
          const ledger = decimal(await ledgerBalanceOf(tx, ctx.organizationId, accountId, asOf));
          rows.push({
            kind: 'cost' as const,
            accountId,
            register: register.toFixed(scale),
            ledger: ledger.toFixed(scale),
            difference: ledger.minus(register).toFixed(scale),
          });
        }
        for (const [accountId, register] of accumulated) {
          // Accumulated depreciation is a credit balance in the ledger.
          const ledger = decimal(
            await ledgerBalanceOf(tx, ctx.organizationId, accountId, asOf),
          ).negated();
          rows.push({
            kind: 'accumulated_depreciation' as const,
            accountId,
            register: register.toFixed(scale),
            ledger: ledger.toFixed(scale),
            difference: ledger.minus(register).toFixed(scale),
          });
        }
        return { asOf, accounts: rows };
      },
    );
  }
}

/** Read-only variants used by previews (no row locks inside a read-only snapshot). */
async function lockActiveAssetsReadOnly(
  tx: Transaction,
  organizationId: string,
): Promise<FixedAsset[]> {
  const page = await listAssets(tx, { organizationId, status: 'ACTIVE', limit: 5000 });
  return page.items;
}

async function lockAssetsReadOnly(
  tx: Transaction,
  organizationId: string,
  ids: readonly string[],
): Promise<Map<string, FixedAsset>> {
  const result = new Map<string, FixedAsset>();
  for (const id of new Set(ids)) {
    const asset = await getAsset(tx, organizationId, id);
    if (asset) result.set(id, asset);
  }
  return result;
}
