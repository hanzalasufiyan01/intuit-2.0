import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, parseAmount } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  convertJournalToBase,
  deleteDraftOpeningBatch,
  findApplicableRate,
  findOpenOpeningBatch,
  findPeriodForDate,
  getAccountFacts,
  getDesignatedAccountId,
  getOpeningBatch,
  insertOpeningBatch,
  isValidIsoDate,
  listAccounts,
  listDimensionTypes,
  listFiscalYears,
  listOpeningBatches,
  listOpeningJournals,
  listOpeningLines,
  missingRequiredDimensions,
  openingDateFor,
  openingLineIssues,
  openingTotals,
  OPENING_SOURCE,
  planOpeningJournals,
  replaceOpeningLines,
  setConversionDate,
  updateOpeningBatch,
  type OpeningAccount,
  type OpeningBatch,
  type OpeningLine,
  type OpeningLineInput,
  type RuleIssue,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { listLinkedFiles } from '../modules/files/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { FileService } from './file-service.js';
import { MAX_JOURNAL_LINES, type JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';

/** S8-11: approvable action for posting an opening batch. */
export const OPENING_BALANCE_POST_ACTION = 'accounting.opening_balance.post';
/** S10-03: the one transaction type of opening-balance posting. */
export const OPENING_BALANCE_TYPE = 'opening_balance';

/**
 * S10-03 (final amendment): the canonical base amount of an opening batch, the amount S8 posting
 * records. For each per-currency opening journal it is the journal's balanced base total (base
 * debits = base credits), computed exactly as the posting path computes it: base-currency journals
 * at rate 1, explicit carrying values from their base amounts, table-rate journals through the
 * engine's own conversion at the plan's rate. The Opening Balance Equity line only balances the
 * smaller side, so it is never counted twice: each currency contributes the larger of its entered
 * base debits and base credits. The batch amount is the sum over its currencies.
 */
export function openingApprovalAmount(
  journals: readonly OpeningEvaluation['journals'][number][],
  baseCurrency: string,
): string {
  let total = decimal(0);
  for (const journal of journals) {
    if (journal.rateSource === 'explicit') {
      total = total.plus(decimal(journal.totals.baseDebit!));
      continue;
    }
    const conversion = convertJournalToBase(
      journal.lines.map((l, i) => {
        const side: 'debit' | 'credit' = l.debit !== null ? 'debit' : 'credit';
        const parsed = parseAmount((l.debit ?? l.credit)!, journal.currency);
        if (!parsed.ok) throw new Error('Invalid planned opening amount.');
        return { lineNumber: i + 1, accountId: l.accountId, side, amount: parsed.value };
      }),
      decimal(journal.rate),
      baseCurrency,
    );
    total = total.plus(
      conversion.lines
        .filter((l) => l.side === 'debit')
        .reduce((sum, l) => sum.plus(l.baseAmount), decimal(0)),
    );
  }
  return total.toFixed();
}

const RESOURCE = 'accounting_opening_balance_batch';
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);

type Settings = Awaited<ReturnType<typeof requireAccountingSettings>>;

export interface OpeningEvaluation {
  errors: RuleIssue[];
  warnings: RuleIssue[];
  journals: ReturnType<typeof planOpeningJournals>['journals'];
}

/**
 * Opening balances / conversion balances (S8-01 to S8-22), owned by accounting. A batch of
 * balances is validated, optionally approved, and posted with re-authentication as one system
 * journal per currency through `postSystemJournal` (never a direct ledger write), balanced
 * against the designated Opening Balance Equity account. Posted batches are immutable and are
 * corrected only by reversing the whole batch.
 *
 * States (S8-03): DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED. There is no READY state:
 * whether a batch may be posted is derived from its approval request.
 */
export class OpeningBalanceService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly journals: JournalService,
    private readonly files: FileService,
  ) {
    approvals.register({
      actionKey: OPENING_BALANCE_POST_ACTION,
      label: 'Approve opening balances before posting',
      subjectType: RESOURCE,
      approverPermission: AccountingPermissions.JournalsApprove,
      decisionRequiresReauth: false,
      // S10-03: the canonical S8 base amount of the batch, and its transaction type.
      conditions: { amount: true, transactionTypes: [OPENING_BALANCE_TYPE] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        await this.audit(tx, authz, 'opening_balance.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        const batch = await updateOpeningBatch(tx, {
          organizationId: authz.organizationId,
          batchId: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: authz.userId,
            updatedAt: now,
          },
        });
        if (!batch) throw invalidState('The opening batch is no longer pending approval.');
        await this.audit(tx, authz, 'opening_balance.rejected', batch.id, now, origin, {
          approvalRequestId: request.id,
          comment,
        });
      },
    });
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    batchId: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType: RESOURCE,
      resourceId: batchId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Conversion date (S8-04, S8-13)
  // ---------------------------------------------------------------------------

  getConversionDate(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        return conversionView(settings.conversionDate);
      },
    );
  }

  setConversionDate(
    principal: Principal,
    input: { conversionDate: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup, sensitive: true },
      async (tx, ctx) => {
        if (input.conversionDate !== null && !isValidIsoDate(input.conversionDate)) {
          throw new ValidationError([
            { path: 'conversionDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const settings = await requireAccountingSettings(tx, ctx.organizationId, {
          forUpdate: true,
        });
        const open = await findOpenOpeningBatch(tx, ctx.organizationId, { forUpdate: true });
        if (open && open.status !== 'DRAFT') {
          throw invalidState(
            open.status === 'POSTED'
              ? 'Opening balances are posted for the current conversion date. Reverse the opening batch before changing it.'
              : 'An opening batch is awaiting approval. Withdraw it before changing the conversion date.',
          );
        }
        const now = this.now;
        if (open) {
          if (input.conversionDate === null) {
            throw invalidState(
              'A draft opening batch uses the conversion date. Delete the draft before clearing it.',
            );
          }
          const updated = await updateOpeningBatch(tx, {
            organizationId: ctx.organizationId,
            batchId: open.id,
            from: 'DRAFT',
            set: {
              conversionDate: input.conversionDate,
              openingDate: openingDateFor(input.conversionDate),
              updatedByUserId: ctx.userId,
              updatedAt: now,
            },
          });
          if (!updated) throw invalidState('The draft opening batch changed; try again.');
        }
        await setConversionDate(tx, ctx.organizationId, input.conversionDate);
        await recordAuditEvent(tx, {
          occurredAt: now,
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          action: 'accounting.conversion_date_changed',
          resourceType: 'accounting_settings',
          resourceId: ctx.organizationId,
          metadata: {
            from: settings.conversionDate,
            to: input.conversionDate,
            draftBatchId: open?.id ?? null,
          },
          origin,
        });
        return conversionView(input.conversionDate);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  list(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const batches = await listOpeningBatches(tx, ctx.organizationId);
        return {
          ...conversionView(settings.conversionDate),
          batches: batches.map(batchSummary),
        };
      },
    );
  }

  get(principal: Principal, batchId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      (tx, ctx) => this.detail(tx, ctx, batchId),
    );
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, batchId: string) {
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const batch = await getOpeningBatch(tx, ctx.organizationId, batchId);
    if (!batch) throw new NotFoundError('Opening batch not found.');
    const lines = await listOpeningLines(tx, ctx.organizationId, batch.id);
    const accounts = await this.accounts(tx, ctx.organizationId);
    const journals = await listOpeningJournals(tx, ctx.organizationId, batch.id);
    const approval = await this.approvalState(
      tx,
      ctx.organizationId,
      batch,
      batch.status === 'DRAFT' || batch.status === 'PENDING_APPROVAL'
        ? this.approvalFacts(settings, await this.evaluate(tx, ctx, settings, batch, lines))
        : null,
    );
    return {
      ...batchSummary(batch),
      baseCurrency: settings.baseCurrency,
      lines: lines.map((l) => lineView(l, accounts, settings.baseCurrency)),
      totals: openingTotals(lines, accounts, settings.baseCurrency),
      approval,
      journals: journals.map((j) => ({
        id: j.id,
        journalNumber: j.journalNumber,
        currency: j.currency,
        status: j.status,
        entryDate: j.entryDate,
        totalDebit: j.totalDebit,
        totalBaseDebit: j.totalBaseDebit,
        exchangeRate: j.exchangeRate,
        exchangeRateSource: j.exchangeRateSource,
      })),
    };
  }

  /** S10-03: the batch's approval facts, from the S8 evaluation (the amount S8 posting records). */
  private approvalFacts(settings: Settings, evaluation: OpeningEvaluation): ApprovalFacts {
    return {
      transactionType: OPENING_BALANCE_TYPE,
      // Unknown until the batch validates: amount conditions then fail closed (S10-05).
      baseAmount:
        evaluation.errors.length === 0 && evaluation.journals.length > 0
          ? openingApprovalAmount(evaluation.journals, settings.baseCurrency)
          : null,
      baseCurrency: settings.baseCurrency,
    };
  }

  /**
   * Approval state; readiness to post is derived from it (no READY status, S8-03). Whether
   * approval is required depends on the batch's facts (S10-06): no matching step means direct
   * posting (Decision 77).
   */
  private async approvalState(
    tx: Transaction,
    organizationId: string,
    batch: OpeningBatch,
    facts: ApprovalFacts | null,
  ) {
    const requirement = facts
      ? await this.approvals.requirementFor(tx, organizationId, OPENING_BALANCE_POST_ACTION, facts)
      : { required: false, steps: [] };
    const request = batch.approvalRequestId
      ? await getApprovalRequest(tx, organizationId, batch.approvalRequestId)
      : undefined;
    const progress = request ? await this.approvals.progress(tx, organizationId, request) : null;
    const approved = request?.status === 'approved';
    return {
      required: request ? true : requirement.required,
      requestId: request?.id ?? null,
      requestStatus: request?.status ?? null,
      steps: progress?.progress.steps ?? [],
      facts: request?.policySnapshot.facts ?? facts,
      appliedSteps: (request ? request.policySnapshot.steps : requirement.steps).map((step) => ({
        order: step.order,
        name: step.name,
        requiredApprovals: step.requiredApprovals,
        conditions: step.conditions ?? null,
      })),
      readyToPost:
        (batch.status === 'DRAFT' && !requirement.required) ||
        (batch.status === 'PENDING_APPROVAL' && approved),
    };
  }

  private async accounts(tx: Transaction, organizationId: string) {
    const list = await listAccounts(tx, organizationId);
    return new Map<string, OpeningAccount>(
      list.map((a) => [
        a.id,
        {
          id: a.id,
          code: a.code,
          name: a.name,
          status: a.status,
          isLeaf: a.isLeaf,
          currencyCode: a.currencyCode,
          isMonetary: a.isMonetary,
          isControlAccount: a.isControlAccount,
          accountType: a.accountType,
          subtype: a.subtype ?? null,
        },
      ]),
    );
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  /**
   * Line-level checks used when saving a draft (and by the import): accounts, amounts, base
   * amounts, the receivable/control/OBE/P&L rules and dimension assignments. Plan-level checks
   * (rates, line cap, required dimensions, period) run at preview, submit and post.
   */
  async lineIssues(
    tx: Transaction,
    ctx: AuthorizationContext,
    settings: Settings,
    conversionDate: string,
    lines: readonly OpeningLineInput[],
  ): Promise<RuleIssue[]> {
    const accounts = await this.accounts(tx, ctx.organizationId);
    const obeAccountId = await getDesignatedAccountId(
      tx,
      ctx.organizationId,
      'OPENING_BALANCE_EQUITY',
    );
    const pnl = await this.profitAndLossRule(
      tx,
      ctx.organizationId,
      openingDateFor(conversionDate),
    );
    const issues: RuleIssue[] = [];
    lines.forEach((line, i) => {
      issues.push(
        ...openingLineIssues({ ...line, lineNumber: i + 1 }, `lines.${i}`, {
          account: accounts.get(line.accountId),
          baseCurrency: settings.baseCurrency,
          obeAccountId,
          profitAndLossAllowed: pnl.allowed,
          profitAndLossReason: pnl.reason,
        }),
      );
    });
    if (lines.some((l) => l.dimensions.length > 0)) {
      // Decision 91: assigning dimension values needs the dimension view permission.
      if (!hasPermission(ctx, AccountingPermissions.DimensionsView)) {
        issues.push({
          path: 'lines',
          message: 'You need permission to view dimensions to assign dimension values.',
        });
      } else {
        issues.push(
          ...(await this.journals.dimensionAssignmentIssues(tx, ctx.organizationId, lines)),
        );
      }
    }
    return issues;
  }

  /**
   * Import validation (S8-16): the line rules plus required applicable dimensions (S8-09), for
   * rows that are about to replace the draft's lines.
   */
  async importIssues(
    tx: Transaction,
    ctx: AuthorizationContext,
    settings: Settings,
    conversionDate: string,
    lines: readonly OpeningLineInput[],
  ): Promise<RuleIssue[]> {
    const issues = await this.lineIssues(tx, ctx, settings, conversionDate, lines);
    issues.push(...(await this.requiredDimensionIssues(tx, ctx.organizationId, lines)));
    return issues;
  }

  /** S8-09: a required dimension that applies to the account blocks; nothing is assigned. */
  private async requiredDimensionIssues(
    tx: Transaction,
    organizationId: string,
    lines: readonly OpeningLineInput[],
  ): Promise<RuleIssue[]> {
    const accounts = await this.accounts(tx, organizationId);
    const types = await listDimensionTypes(tx, organizationId);
    return missingRequiredDimensions(
      lines.map((l, index) => ({
        index,
        accountId: l.accountId,
        dimensionTypeIds: new Set(l.dimensions.map((d) => d.dimensionTypeId)),
      })),
      new Map(
        [...accounts].map(([id, a]) => [
          id,
          { accountType: a.accountType!, subtype: a.subtype ?? null },
        ]),
      ),
      types,
    );
  }

  /** S8-08: P&L balances only for a mid-year conversion. */
  private async profitAndLossRule(tx: Transaction, organizationId: string, openingDate: string) {
    const years = await listFiscalYears(tx, organizationId);
    const year = years.find((y) => y.startDate <= openingDate && y.endDate >= openingDate);
    if (year && year.endDate === openingDate) {
      return {
        allowed: false,
        reason:
          `The opening date ${openingDate} is the last day of fiscal year ${year.name}, so income ` +
          'and expense balances from before the conversion belong in Retained Earnings, not in ' +
          'opening balances.',
      };
    }
    return { allowed: true, reason: '' };
  }

  /**
   * Full evaluation (preview, submit, post): line rules, dimensions (required applicable ones
   * block, S8-09), designation, fiscal year and open period, rates, the line cap and the
   * per-currency journal plan.
   */
  async evaluate(
    tx: Transaction,
    ctx: AuthorizationContext,
    settings: Settings,
    batch: OpeningBatch,
    lines: readonly OpeningLine[],
  ): Promise<OpeningEvaluation> {
    const errors: RuleIssue[] = [];
    const warnings: RuleIssue[] = [];
    const inputs = lines.map(toInput);
    if (settings.conversionDate !== batch.conversionDate) {
      errors.push({
        path: 'conversionDate',
        message: 'The conversion date changed since this batch was prepared.',
      });
    }
    const obeAccountId = await getDesignatedAccountId(
      tx,
      ctx.organizationId,
      'OPENING_BALANCE_EQUITY',
    );
    if (!obeAccountId) {
      errors.push({
        path: 'designations.OPENING_BALANCE_EQUITY',
        message:
          'Designate an Opening Balance Equity account under Accounting > Designations first.',
      });
    } else {
      const [obe] = (await getAccountFacts(tx, ctx.organizationId, [obeAccountId])).values();
      if (!obe || obe.status !== 'ACTIVE' || !obe.isLeaf) {
        errors.push({
          path: 'designations.OPENING_BALANCE_EQUITY',
          message: 'The designated Opening Balance Equity account must be an active leaf account.',
        });
      }
    }
    const years = await listFiscalYears(tx, ctx.organizationId);
    if (!years.some((y) => y.startDate <= batch.openingDate && y.endDate >= batch.openingDate)) {
      errors.push({
        path: 'openingDate',
        message:
          `No fiscal year covers the opening date ${batch.openingDate} (the day before the ` +
          `conversion date). Create the fiscal year that includes ${batch.openingDate} under ` +
          'Accounting > Fiscal years; periods are never created automatically.',
      });
    } else {
      const period = await findPeriodForDate(tx, ctx.organizationId, batch.openingDate);
      if (!period) {
        errors.push({
          path: 'openingDate',
          message: `No accounting period covers the opening date ${batch.openingDate}.`,
        });
      } else if (period.status !== 'OPEN') {
        errors.push({
          path: 'openingDate',
          message: `The period ${period.name} containing the opening date is closed. Reopen it to post opening balances.`,
        });
      }
    }
    errors.push(...(await this.lineIssues(tx, ctx, settings, batch.conversionDate, inputs)));

    errors.push(...(await this.requiredDimensionIssues(tx, ctx.organizationId, inputs)));
    const accounts = await this.accounts(tx, ctx.organizationId);

    const tableRates = new Map<string, string | null>();
    for (const line of inputs) {
      const currency = accounts.get(line.accountId)?.currencyCode ?? settings.baseCurrency;
      if (currency === settings.baseCurrency || tableRates.has(currency)) continue;
      const rate = await findApplicableRate(tx, {
        organizationId: ctx.organizationId,
        fromCurrency: currency,
        toCurrency: settings.baseCurrency,
        onDate: batch.openingDate,
      });
      tableRates.set(currency, rate ? decimal(rate.rate).toFixed() : null);
    }
    const plan = planOpeningJournals({
      baseCurrency: settings.baseCurrency,
      lines: inputs.map((l, i) => ({ ...l, lineNumber: i + 1 })),
      accounts,
      obeAccountId: obeAccountId ?? '00000000-0000-0000-0000-000000000000',
      tableRates,
      openingDate: batch.openingDate,
      maxLines: MAX_JOURNAL_LINES,
    });
    errors.push(...plan.issues);
    if (plan.journals.length > 0) {
      warnings.push({
        path: 'posting',
        message:
          'Posting fixes the base currency and the currency of every account used here; they ' +
          'cannot be changed afterwards.',
      });
    }
    return { errors, warnings, journals: errors.length ? [] : plan.journals };
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  create(principal: Principal, input: { notes: string }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const batch = await this.createDraft(tx, ctx, input.notes, origin);
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  private async createDraft(
    tx: Transaction,
    ctx: AuthorizationContext,
    notes: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ): Promise<OpeningBatch> {
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    if (!settings.conversionDate) {
      throw invalidState('Set the conversion date before entering opening balances.');
    }
    const now = this.now;
    const batch = await insertOpeningBatch(tx, {
      organizationId: ctx.organizationId,
      conversionDate: settings.conversionDate,
      notes,
      userId: ctx.userId,
      now,
    });
    if (!batch) {
      throw new ConflictError(
        'CONFLICT',
        'An opening batch is already open. Continue it, or reverse the posted batch first.',
      );
    }
    await this.audit(tx, ctx, 'opening_balance.created', batch.id, now, origin, {
      conversionDate: batch.conversionDate,
      openingDate: batch.openingDate,
      ...metadata,
    });
    return batch;
  }

  replaceLines(
    principal: Principal,
    batchId: string,
    input: { version: number; lines: OpeningLineInput[] },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const batch = await getOpeningBatch(tx, ctx.organizationId, batchId, { forUpdate: true });
        if (!batch) throw new NotFoundError('Opening batch not found.');
        await this.saveLines(tx, ctx, batch, input.lines, origin, { version: input.version });
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  /**
   * Import commit (S8-16): the rows become the lines of the organization's draft batch (created
   * when there is none). Never posts anything.
   */
  async replaceLinesFromImportInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    lines: OpeningLineInput[],
    origin: EventOrigin,
    importBatchId: string,
  ): Promise<OpeningLine[]> {
    let batch = await findOpenOpeningBatch(tx, ctx.organizationId, { forUpdate: true });
    if (batch && batch.status !== 'DRAFT') {
      throw invalidState(
        batch.status === 'POSTED'
          ? 'Opening balances are already posted. Reverse the opening batch before importing new balances.'
          : 'The opening batch is awaiting approval. Withdraw it before importing new balances.',
      );
    }
    batch ??= await this.createDraft(tx, ctx, '', origin, { importBatchId });
    return this.saveLines(tx, ctx, batch, lines, origin, { importBatchId });
  }

  private async saveLines(
    tx: Transaction,
    ctx: AuthorizationContext,
    batch: OpeningBatch,
    lines: OpeningLineInput[],
    origin: EventOrigin,
    options: { version?: number; importBatchId?: string },
  ): Promise<OpeningLine[]> {
    if (batch.status !== 'DRAFT') throw invalidState('Only a draft opening batch can be edited.');
    if (options.version !== undefined && batch.version !== options.version) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'The opening batch was changed by someone else. Reload and try again.',
      );
    }
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const issues = await this.lineIssues(tx, ctx, settings, batch.conversionDate, lines);
    if (issues.length) throw new ValidationError(issues, 'Some opening balances need attention.');
    const now = this.now;
    const updated = await updateOpeningBatch(tx, {
      organizationId: ctx.organizationId,
      batchId: batch.id,
      from: 'DRAFT',
      version: batch.version,
      set: { updatedByUserId: ctx.userId, updatedAt: now },
    });
    if (!updated) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'The opening batch changed; reload and try again.',
      );
    }
    const saved = await replaceOpeningLines(tx, {
      organizationId: ctx.organizationId,
      batchId: batch.id,
      lines,
    });
    const accounts = await this.accounts(tx, ctx.organizationId);
    await this.audit(tx, ctx, 'opening_balance.lines_updated', batch.id, now, origin, {
      lines: saved.length,
      totals: openingTotals(saved, accounts, settings.baseCurrency),
      ...(options.importBatchId ? { importBatchId: options.importBatchId } : {}),
    });
    return saved;
  }

  preview(principal: Principal, batchId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const batch = await getOpeningBatch(tx, ctx.organizationId, batchId);
        if (!batch) throw new NotFoundError('Opening batch not found.');
        const lines = await listOpeningLines(tx, ctx.organizationId, batch.id);
        const evaluation = await this.evaluate(tx, ctx, settings, batch, lines);
        const accounts = await this.accounts(tx, ctx.organizationId);
        return {
          batchId: batch.id,
          version: batch.version,
          openingDate: batch.openingDate,
          baseCurrency: settings.baseCurrency,
          errors: evaluation.errors,
          warnings: evaluation.warnings,
          approval: await this.approvalState(
            tx,
            ctx.organizationId,
            batch,
            this.approvalFacts(settings, evaluation),
          ),
          journals: evaluation.journals.map((j) => ({
            currency: j.currency,
            rate: j.rate,
            rateSource: j.rateSource,
            accountLines: j.accountLines,
            totals: j.totals,
            openingBalanceEquity: j.obe,
            lines: j.lines.map((l) => ({
              accountId: l.accountId,
              accountCode: accounts.get(l.accountId)?.code ?? null,
              accountName: accounts.get(l.accountId)?.name ?? null,
              description: l.description,
              debit: l.debit,
              credit: l.credit,
              baseDebit: l.baseDebit,
              baseCredit: l.baseCredit,
            })),
          })),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Workflow
  // ---------------------------------------------------------------------------

  submit(principal: Principal, batchId: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const batch = await this.lockBatch(tx, ctx, batchId, input.version);
        if (batch.status !== 'DRAFT')
          throw invalidState('Only a draft opening batch can be submitted.');
        const lines = await listOpeningLines(tx, ctx.organizationId, batch.id);
        const evaluation = await this.evaluate(tx, ctx, settings, batch, lines);
        if (evaluation.errors.length) {
          throw new ValidationError(evaluation.errors, 'The opening balances are not ready.');
        }
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: OPENING_BALANCE_POST_ACTION,
          subjectId: batch.id,
          // No self-approval: neither the preparer nor the submitter may approve.
          excludedUserIds: [...new Set([ctx.userId, batch.createdByUserId])],
          reason: null,
          facts: this.approvalFacts(settings, evaluation),
          now,
        });
        if (!request) {
          throw invalidState(
            'No approval step applies to these opening balances; post them directly.',
          );
        }
        const updated = await updateOpeningBatch(tx, {
          organizationId: ctx.organizationId,
          batchId: batch.id,
          from: 'DRAFT',
          version: batch.version,
          set: {
            status: 'PENDING_APPROVAL',
            approvalRequestId: request.id,
            submittedByUserId: ctx.userId,
            submittedAt: now,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw invalidState('The opening batch changed; reload and try again.');
        await this.audit(tx, ctx, 'opening_balance.submitted', batch.id, now, origin, {
          approvalRequestId: request.id,
          journals: evaluation.journals.map((j) => ({
            currency: j.currency,
            total: j.totals.debit,
          })),
        });
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  withdraw(principal: Principal, batchId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const batch = await this.lockBatch(tx, ctx, batchId);
        if (batch.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only an opening batch awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = batch.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, batch.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateOpeningBatch(tx, {
          organizationId: ctx.organizationId,
          batchId: batch.id,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw invalidState('The opening batch changed; reload and try again.');
        await this.audit(tx, ctx, 'opening_balance.withdrawn', batch.id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  /**
   * Posting (S8-10), one transaction: lock, version, status, approval, full re-validation
   * (including the OBE designation and the open period), one journal per currency through
   * `postSystemJournal` (base currency first), POSTED, audit. Any failure rolls back everything.
   */
  post(principal: Principal, batchId: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup, sensitive: true },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        // 1-2. Lock and version.
        const batch = await this.lockBatch(tx, ctx, batchId, input.version);
        // 3. Status.
        if (batch.status !== 'DRAFT' && batch.status !== 'PENDING_APPROVAL') {
          throw invalidState(`A ${batch.status} opening batch cannot be posted.`);
        }
        // 4. Approval, re-checked here against the batch's facts (S10-06). The facts come from
        // the same evaluation that step 5 uses; its errors are reported after this check.
        const lines = await listOpeningLines(tx, ctx.organizationId, batch.id);
        const evaluation = await this.evaluate(tx, ctx, settings, batch, lines);
        const approval = await this.approvalState(
          tx,
          ctx.organizationId,
          batch,
          this.approvalFacts(settings, evaluation),
        );
        if (!approval.readyToPost) {
          throw new AppError(
            'APPROVAL_REQUIRED',
            409,
            batch.status === 'DRAFT'
              ? 'Opening balances need approval: submit the batch for approval first.'
              : 'The opening batch has not received all required approvals.',
          );
        }
        // 5-7. Re-validate everything, including the OBE designation and the open period.
        if (evaluation.errors.length) {
          throw new ValidationError(evaluation.errors, 'The opening balances cannot be posted.');
        }
        // 8-9. One system journal per currency, base currency first.
        const now = this.now;
        const posted = [];
        for (const journal of evaluation.journals) {
          const entry = await this.journals.postSystemJournal(
            tx,
            {
              organizationId: ctx.organizationId,
              userId: ctx.userId,
              source: { ...OPENING_SOURCE, id: batch.id },
              entryDate: batch.openingDate,
              description: `Opening balances (${journal.currency}) at ${batch.openingDate}`,
              reference: `Opening ${batch.conversionDate}`,
              currency: journal.currency,
              // Table rates are looked up by the engine (recorded as 'table'); explicit carrying
              // values post their own base amounts, with the implied rate for reference.
              exchangeRate: journal.rateSource === 'explicit' ? journal.rate : null,
              lines: journal.lines,
            },
            origin,
          );
          posted.push({ journal, entry });
        }
        // 10. POSTED.
        const updated = await updateOpeningBatch(tx, {
          organizationId: ctx.organizationId,
          batchId: batch.id,
          from: batch.status,
          version: batch.version,
          set: {
            status: 'POSTED',
            postedByUserId: ctx.userId,
            postedAt: now,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw invalidState('The opening batch changed while posting; try again.');
        // 11. Audit.
        await this.audit(tx, ctx, 'opening_balance.posted', batch.id, now, origin, {
          openingDate: batch.openingDate,
          approvalRequestId: batch.approvalRequestId,
          journals: posted.map(({ journal, entry }) => ({
            currency: journal.currency,
            journalId: entry.id,
            journalNumber: entry.journalNumber,
            total: journal.totals.debit,
            totalBase: entry.totalBaseDebit,
            rateSource: journal.rateSource,
            openingBalanceEquity: journal.obe,
          })),
        });
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  /**
   * Batch-level reversal (S8-14), one transaction: every opening journal of the batch is reversed
   * through the reversal engine (dated the opening date, which must be in an open period), then
   * the batch becomes REVERSED. A new batch can then be entered and posted.
   */
  reverse(principal: Principal, batchId: string, input: { reason: string }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const batch = await this.lockBatch(tx, ctx, batchId);
        if (batch.status !== 'POSTED')
          throw invalidState('Only a posted opening batch can be reversed.');
        const journals = (await listOpeningJournals(tx, ctx.organizationId, batch.id)).filter(
          (j) => j.status === 'POSTED',
        );
        const reason = input.reason.trim();
        const reversals = [];
        for (const journal of journals) {
          const result = await this.journals.reverseJournalInTransaction(
            tx,
            ctx,
            journal.id,
            { reason: `Opening balances reversed: ${reason}` },
            origin,
            { openingBatch: true },
          );
          reversals.push({
            journalId: journal.id,
            reversalJournalId: result.reversal.id,
            reversalNumber: result.reversal.number,
          });
        }
        const now = this.now;
        const updated = await updateOpeningBatch(tx, {
          organizationId: ctx.organizationId,
          batchId: batch.id,
          from: 'POSTED',
          set: {
            status: 'REVERSED',
            reversedByUserId: ctx.userId,
            reversedAt: now,
            reversalReason: reason,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw invalidState('The opening batch changed while reversing; try again.');
        await this.audit(tx, ctx, 'opening_balance.reversed', batch.id, now, origin, {
          reason,
          reversals,
        });
        return this.detail(tx, ctx, batch.id);
      },
    );
  }

  /** S8-18: drafts may be deleted (attachments are soft-deleted with them); nothing else. */
  delete(principal: Principal, batchId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.Setup },
      async (tx, ctx) => {
        const batch = await this.lockBatch(tx, ctx, batchId);
        if (batch.status !== 'DRAFT') {
          throw invalidState('Only a draft opening batch can be deleted; posted history is kept.');
        }
        const lines = await listOpeningLines(tx, ctx.organizationId, batch.id);
        const attachments = await listLinkedFiles(
          tx,
          ctx.organizationId,
          'opening_balance_batch',
          batch.id,
        );
        for (const { file } of attachments) {
          if (file.status === 'available') {
            await this.files.systemDeleteInTransaction(tx, ctx.organizationId, file.id, origin);
          }
        }
        if (!(await deleteDraftOpeningBatch(tx, ctx.organizationId, batch.id))) {
          throw invalidState('The opening batch changed; reload and try again.');
        }
        await this.audit(tx, ctx, 'opening_balance.deleted', batch.id, this.now, origin, {
          lines: lines.length,
          attachments: attachments.length,
        });
      },
    );
  }

  private async lockBatch(
    tx: Transaction,
    ctx: AuthorizationContext,
    batchId: string,
    version?: number,
  ): Promise<OpeningBatch> {
    const batch = await getOpeningBatch(tx, ctx.organizationId, batchId, { forUpdate: true });
    if (!batch) throw new NotFoundError('Opening batch not found.');
    if (version !== undefined && batch.version !== version) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'The opening batch was changed by someone else. Reload and try again.',
      );
    }
    return batch;
  }
}

function conversionView(conversionDate: string | null) {
  return {
    conversionDate,
    openingDate: conversionDate ? openingDateFor(conversionDate) : null,
  };
}

function batchSummary(batch: OpeningBatch) {
  return {
    id: batch.id,
    status: batch.status,
    conversionDate: batch.conversionDate,
    openingDate: batch.openingDate,
    version: batch.version,
    notes: batch.notes,
    approvalRequestId: batch.approvalRequestId,
    createdByUserId: batch.createdByUserId,
    createdAt: batch.createdAt.toISOString(),
    updatedAt: batch.updatedAt.toISOString(),
    submittedAt: batch.submittedAt?.toISOString() ?? null,
    postedAt: batch.postedAt?.toISOString() ?? null,
    postedByUserId: batch.postedByUserId,
    reversedAt: batch.reversedAt?.toISOString() ?? null,
    reversalReason: batch.reversalReason,
  };
}

function toInput(line: OpeningLine): OpeningLineInput {
  return {
    accountId: line.accountId,
    description: line.description,
    debit: line.debit === null ? null : trimAmount(line.debit),
    credit: line.credit === null ? null : trimAmount(line.credit),
    baseAmount: line.baseAmount === null ? null : trimAmount(line.baseAmount),
    dimensions: line.dimensions,
  };
}

/** numeric(28,4) comes back as e.g. "125.5000"; the currency precision rules need "125.5". */
function trimAmount(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}

function lineView(
  line: OpeningLine,
  accounts: ReadonlyMap<string, OpeningAccount>,
  baseCurrency: string,
) {
  const account = accounts.get(line.accountId);
  return {
    id: line.id,
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    accountCode: account?.code ?? null,
    accountName: account?.name ?? null,
    currency: account?.currencyCode ?? baseCurrency,
    description: line.description,
    debit: line.debit === null ? null : trimAmount(line.debit),
    credit: line.credit === null ? null : trimAmount(line.credit),
    baseAmount: line.baseAmount === null ? null : trimAmount(line.baseAmount),
    dimensions: line.dimensions,
  };
}
