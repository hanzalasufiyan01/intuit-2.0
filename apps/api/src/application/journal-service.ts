import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, parseRate, type Money } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  allocateJournalNumber,
  completeAccountingEvent,
  convertJournalToBase,
  createDraftJournal,
  findApplicableRate,
  findPeriodForDate,
  fixedAmount,
  getAccountFacts,
  getJournal,
  getJournalLines,
  getReversalLinks,
  isValidIsoDate,
  listJournals,
  receiveAccountingEvent,
  recordReversal,
  replaceDraftJournal,
  transitionJournal,
  validateDraftLines,
  validatePostableJournal,
  writeBaseAmounts,
  type AccountingSettings,
  type JournalEntry,
  type JournalLine,
  type JournalLineInput,
  type JournalStatus,
  type Period,
  type PostableLine,
  type RuleIssue,
} from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { ApprovalRequiredError, type ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction, setDbContext } from './unit-of-work.js';
import { withOrganization } from './organization-service.js';

export const JOURNAL_POST_ACTION = 'accounting.journal.post';
export const MAX_JOURNAL_LINES = 500;

export interface JournalInput {
  entryDate: string | null;
  description: string;
  reference: string;
  currency: string;
  exchangeRate: string | null;
  lines: JournalLineInput[];
}

/** Actor performing an accounting operation: a user, or the system (accounting events). */
interface Actor {
  organizationId: string;
  userId: string | null;
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const invalidJournal = (issues: RuleIssue[]) =>
  new ValidationError(issues, 'The journal is not a valid balanced double entry.');

function lineView(line: JournalLine) {
  return {
    lineNumber: line.lineNumber,
    accountId: line.accountId,
    description: line.description,
    debit: line.debit,
    credit: line.credit,
    baseDebit: line.baseDebit,
    baseCredit: line.baseCredit,
    roundingAdjustment: line.roundingAdjustment,
  };
}

export function journalView(journal: JournalEntry, lines?: JournalLine[]) {
  return {
    id: journal.id,
    number: journal.journalNumber,
    status: journal.status,
    source: journal.source,
    entryDate: journal.entryDate,
    periodId: journal.periodId,
    description: journal.description,
    reference: journal.reference,
    currency: journal.currency,
    exchangeRate: journal.exchangeRate,
    exchangeRateSource: journal.exchangeRateSource,
    baseCurrency: journal.baseCurrency,
    totalDebit: journal.totalDebit,
    totalCredit: journal.totalCredit,
    totalBaseDebit: journal.totalBaseDebit,
    totalBaseCredit: journal.totalBaseCredit,
    approvalRequestId: journal.approvalRequestId,
    createdByUserId: journal.createdByUserId,
    createdAt: journal.createdAt.toISOString(),
    updatedAt: journal.updatedAt.toISOString(),
    submittedByUserId: journal.submittedByUserId,
    submittedAt: journal.submittedAt?.toISOString() ?? null,
    postedByUserId: journal.postedByUserId,
    postedAt: journal.postedAt?.toISOString() ?? null,
    reversedByUserId: journal.reversedByUserId,
    reversedAt: journal.reversedAt?.toISOString() ?? null,
    ...(lines ? { lines: lines.map(lineView) } : {}),
  };
}

function sumSide(lines: readonly JournalLineInput[], side: 'debit' | 'credit'): Money {
  return lines.reduce((acc, l) => (l[side] ? acc.plus(decimal(l[side]!)) : acc), decimal(0));
}

export type AccountingEventHandler = (event: {
  eventType: string;
  payload: Record<string, unknown>;
}) => JournalInput | null;

/**
 * Journal engine: manual journals, the DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED
 * lifecycle, the atomic posting engine, reversals and the accounting-event foundation.
 */
export class JournalService {
  private readonly eventHandlers = new Map<string, AccountingEventHandler>();

  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
  ) {
    approvals.register({
      actionKey: JOURNAL_POST_ACTION,
      label: 'Approve journals before posting',
      subjectType: 'accounting_journal',
      approverPermission: AccountingPermissions.JournalsApprove,
      decisionRequiresReauth: false,
      onApproved: async (tx, { request, authz, now, origin }) => {
        await this.audit(tx, authz, 'journal.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
          fullyApproved: true,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        const journal = await transitionJournal(tx, {
          organizationId: authz.organizationId,
          journalId: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            periodId: null,
            updatedByUserId: authz.userId,
          },
        });
        if (!journal) throw invalidState('The journal is no longer pending approval.');
        await this.audit(tx, authz, 'journal.rejected', request.subjectId, now, origin, {
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
    actor: Actor | AuthorizationContext,
    action: string,
    journalId: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    const userId = 'userId' in actor ? actor.userId : null;
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: actor.organizationId,
      actorUserId: userId,
      actorType: userId ? 'user' : 'system',
      action,
      resourceType: 'accounting_journal',
      resourceId: journalId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /** Draft-level validation: amounts, precision, currency, rate format, account ownership. */
  private async validateDraft(
    tx: Transaction,
    organizationId: string,
    settings: AccountingSettings,
    input: JournalInput,
  ) {
    const issues: RuleIssue[] = [];
    if (input.entryDate !== null && !isValidIsoDate(input.entryDate)) {
      issues.push({ path: 'entryDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (input.lines.length > MAX_JOURNAL_LINES) {
      issues.push({
        path: 'lines',
        message: `A journal can have at most ${MAX_JOURNAL_LINES} lines.`,
      });
    }
    issues.push(...validateDraftLines(input.lines, input.currency));
    if (input.exchangeRate !== null) {
      const parsed = parseRate(input.exchangeRate);
      if (!parsed.ok) {
        issues.push({
          path: 'exchangeRate',
          message: 'Rates are positive decimal strings with at most 10 decimals.',
        });
      } else if (input.currency === settings.baseCurrency && !parsed.value.eq(1)) {
        issues.push({
          path: 'exchangeRate',
          message: 'Journals in the base currency use a rate of 1.',
        });
      }
    }
    const accountIds = input.lines
      .map((l) => l.accountId)
      .filter((id): id is string => id !== null);
    const facts = await getAccountFacts(tx, organizationId, accountIds);
    input.lines.forEach((line, i) => {
      if (line.accountId && !facts.has(line.accountId)) {
        issues.push({ path: `lines.${i}.accountId`, message: 'Unknown account.' });
      }
    });
    if (issues.length) throw new ValidationError(issues);
  }

  createJournal(principal: Principal, input: JournalInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsCreate },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        await this.validateDraft(tx, ctx.organizationId, settings, input);
        const journal = await createDraftJournal(tx, {
          ...input,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          source: 'manual',
        });
        await this.audit(tx, ctx, 'journal.created', journal.id, this.now, origin, {
          currency: input.currency,
          entryDate: input.entryDate,
          lines: input.lines.length,
          totalDebit: sumSide(input.lines, 'debit').toFixed(),
          totalCredit: sumSide(input.lines, 'credit').toFixed(),
        });
        return this.load(tx, ctx.organizationId, journal.id);
      },
    );
  }

  /** Edits a draft. Only DRAFT journals are editable (posted journals are immutable). */
  updateJournal(
    principal: Principal,
    journalId: string,
    patch: { [K in keyof JournalInput]?: JournalInput[K] | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsEditDraft },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const journal = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
        if (!journal) throw new NotFoundError('Journal not found.');
        if (journal.status !== 'DRAFT')
          throw invalidState(`A ${journal.status} journal cannot be edited.`);
        const currentLines = await getJournalLines(tx, ctx.organizationId, [journalId]);
        const next: JournalInput = {
          entryDate: patch.entryDate === undefined ? journal.entryDate : patch.entryDate,
          description: patch.description ?? journal.description,
          reference: patch.reference ?? journal.reference,
          currency: patch.currency ?? journal.currency,
          exchangeRate:
            patch.exchangeRate === undefined ? journal.exchangeRate : patch.exchangeRate,
          lines:
            patch.lines ??
            currentLines.map((l) => ({
              accountId: l.accountId,
              description: l.description,
              debit: l.debit,
              credit: l.credit,
            })),
        };
        await this.validateDraft(tx, ctx.organizationId, settings, next);
        await replaceDraftJournal(tx, {
          ...next,
          organizationId: ctx.organizationId,
          journalId,
          userId: ctx.userId,
        });
        await this.audit(tx, ctx, 'journal.updated', journalId, this.now, origin, {
          changedFields: Object.keys(patch).filter(
            (k) => patch[k as keyof JournalInput] !== undefined,
          ),
          before: {
            entryDate: journal.entryDate,
            currency: journal.currency,
            lines: currentLines.length,
            totalDebit: sumSide(currentLines, 'debit').toFixed(),
          },
          after: {
            entryDate: next.entryDate,
            currency: next.currency,
            lines: next.lines.length,
            totalDebit: sumSide(next.lines, 'debit').toFixed(),
          },
        });
        return this.load(tx, ctx.organizationId, journalId);
      },
    );
  }

  listJournals(
    principal: Principal,
    filter: { statuses?: JournalStatus[] | undefined; limit: number; before?: Date | undefined },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const journals = await listJournals(tx, ctx.organizationId, filter);
        return journals.map((j) => journalView(j));
      },
    );
  }

  getJournal(principal: Principal, journalId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const view = await this.load(tx, ctx.organizationId, journalId);
        const links = await getReversalLinks(tx, ctx.organizationId, journalId);
        let approval = null;
        if (view.approvalRequestId) {
          const request = await getApprovalRequest(tx, ctx.organizationId, view.approvalRequestId);
          if (request) {
            const { progress, decisions } = await this.approvals.progress(
              tx,
              ctx.organizationId,
              request,
            );
            approval = {
              requestId: request.id,
              status: request.status,
              steps: progress.steps,
              satisfied: progress.satisfied,
              decisions: decisions.map((d) => ({
                approverUserId: d.approverUserId,
                decision: d.decision,
                stepOrder: d.stepOrder,
                comment: d.comment,
                decidedAt: d.decidedAt.toISOString(),
              })),
            };
          }
        }
        const approvalRequired = await this.approvals.isApprovalRequired(
          tx,
          ctx.organizationId,
          JOURNAL_POST_ACTION,
        );
        return {
          ...view,
          approval,
          approvalRequiredForPosting: approvalRequired,
          reversedByJournalId: links.reversedBy?.reversalJournalId ?? null,
          reversesJournalId: links.reverses?.originalJournalId ?? null,
          reversalReason: links.reversedBy?.reason ?? links.reverses?.reason ?? null,
        };
      },
    );
  }

  private async load(tx: Transaction, organizationId: string, journalId: string) {
    const journal = await getJournal(tx, organizationId, journalId);
    if (!journal) throw new NotFoundError('Journal not found.');
    return journalView(journal, await getJournalLines(tx, organizationId, [journalId]));
  }

  // ---------------------------------------------------------------------------
  // Validation shared by submission and posting
  // ---------------------------------------------------------------------------

  private async validateForPosting(
    tx: Transaction,
    organizationId: string,
    settings: AccountingSettings,
    journal: JournalEntry,
    options: { lockPeriod: boolean; reversal?: boolean },
  ): Promise<{
    lines: PostableLine[];
    total: Money;
    period: Period;
    rate: Money;
    rateSource: 'base' | 'manual' | 'table';
  }> {
    const lines = await getJournalLines(tx, organizationId, [journal.id]);
    const facts = await getAccountFacts(
      tx,
      organizationId,
      lines.map((l) => l.accountId).filter((id): id is string => id !== null),
    );
    if (options.reversal) {
      // A reversal corrects an earlier posting, so it may hit accounts archived since then.
      for (const [id, fact] of facts) facts.set(id, { ...fact, status: 'ACTIVE' });
    }
    const validation = validatePostableJournal(
      {
        currency: journal.currency,
        entryDate: journal.entryDate,
        lines: lines.map((l) => ({
          lineNumber: l.lineNumber,
          accountId: l.accountId,
          description: l.description,
          debit: l.debit === null ? null : decimal(l.debit).toFixed(),
          credit: l.credit === null ? null : decimal(l.credit).toFixed(),
        })),
      },
      facts,
    );
    if (!validation.ok) throw invalidJournal(validation.issues);

    const period = await findPeriodForDate(
      tx,
      organizationId,
      journal.entryDate!,
      options.lockPeriod ? 'share' : undefined,
    );
    if (!period) {
      throw new AppError('PERIOD_NOT_FOUND', 409, 'No accounting period covers the journal date.');
    }
    if (period.status !== 'OPEN') {
      throw new AppError('PERIOD_CLOSED', 409, `The accounting period ${period.name} is closed.`);
    }

    let rate: Money;
    let rateSource: 'base' | 'manual' | 'table';
    if (journal.currency === settings.baseCurrency) {
      rate = decimal(1);
      rateSource = 'base';
    } else if (journal.exchangeRate !== null) {
      rate = decimal(journal.exchangeRate);
      rateSource = journal.exchangeRateSource === 'table' ? 'table' : 'manual';
    } else {
      const found = await findApplicableRate(tx, {
        organizationId,
        fromCurrency: journal.currency,
        toCurrency: settings.baseCurrency,
        onDate: journal.entryDate!,
      });
      if (!found) {
        throw new AppError(
          'EXCHANGE_RATE_REQUIRED',
          409,
          `An exchange rate from ${journal.currency} to ${settings.baseCurrency} is required for ${journal.entryDate}.`,
        );
      }
      rate = decimal(found.rate);
      rateSource = 'table';
    }
    return { lines: validation.lines, total: validation.total, period, rate, rateSource };
  }

  // ---------------------------------------------------------------------------
  // Workflow: submit / approve / reject / withdraw
  // ---------------------------------------------------------------------------

  submitJournal(principal: Principal, journalId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsSubmit },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const journal = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
        if (!journal) throw new NotFoundError('Journal not found.');
        if (journal.status !== 'DRAFT') throw invalidState('Only draft journals can be submitted.');
        const checked = await this.validateForPosting(tx, ctx.organizationId, settings, journal, {
          lockPeriod: false,
        });
        const now = this.now;
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: JOURNAL_POST_ACTION,
          subjectId: journalId,
          // Self-approval is prohibited for both the preparer and the submitter.
          excludedUserIds: [
            ctx.userId,
            ...(journal.createdByUserId ? [journal.createdByUserId] : []),
          ],
          reason: null,
          now,
        });
        await transitionJournal(tx, {
          organizationId: ctx.organizationId,
          journalId,
          from: 'DRAFT',
          set: {
            status: 'PENDING_APPROVAL',
            periodId: checked.period.id,
            approvalRequestId: request?.id ?? null,
            exchangeRate: checked.rate.toFixed(10),
            exchangeRateSource: checked.rateSource,
            submittedByUserId: ctx.userId,
            submittedAt: now,
            updatedByUserId: ctx.userId,
          },
        });
        await this.audit(tx, ctx, 'journal.submitted', journalId, now, origin, {
          approvalRequired: request !== null,
          approvalRequestId: request?.id ?? null,
          periodId: checked.period.id,
          total: checked.total.toFixed(),
          currency: journal.currency,
        });
        return this.load(tx, ctx.organizationId, journalId);
      },
    );
  }

  private async pendingRequest(tx: Transaction, organizationId: string, journalId: string) {
    const journal = await getJournal(tx, organizationId, journalId, { forUpdate: true });
    if (!journal) throw new NotFoundError('Journal not found.');
    if (journal.status !== 'PENDING_APPROVAL')
      throw invalidState('The journal is not pending approval.');
    if (!journal.approvalRequestId) {
      throw invalidState('This journal does not require approval; it can be posted directly.');
    }
    const request = await getApprovalRequest(tx, organizationId, journal.approvalRequestId, {
      forUpdate: true,
    });
    if (!request) throw new NotFoundError('Approval request not found.');
    return { journal, request };
  }

  decideJournal(
    principal: Principal,
    journalId: string,
    decision: 'approved' | 'rejected',
    comment: string | null,
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsApprove },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const { request } = await this.pendingRequest(tx, ctx.organizationId, journalId);
        const now = this.now;
        const outcome = await this.approvals.decideInTransaction(tx, {
          principal,
          authz: ctx,
          request,
          decision,
          comment,
          now,
          origin,
        });
        if (decision === 'approved' && outcome.requestStatus === 'pending') {
          await this.audit(tx, ctx, 'journal.approved', journalId, now, origin, {
            approvalRequestId: request.id,
            fullyApproved: false,
            progress: outcome.progress.steps,
          });
        }
        return {
          ...(await this.load(tx, ctx.organizationId, journalId)),
          approvalStatus: outcome.requestStatus,
        };
      },
    );
  }

  /** Withdrawn journals return to draft (any pending approval is voided). */
  withdrawJournal(principal: Principal, journalId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsSubmit },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const journal = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
        if (!journal) throw new NotFoundError('Journal not found.');
        if (journal.status !== 'PENDING_APPROVAL')
          throw invalidState('Only pending journals can be withdrawn.');
        const now = this.now;
        if (journal.approvalRequestId) {
          const request = await getApprovalRequest(
            tx,
            ctx.organizationId,
            journal.approvalRequestId,
          );
          if (request?.status === 'pending') {
            await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
          }
        }
        await transitionJournal(tx, {
          organizationId: ctx.organizationId,
          journalId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            periodId: null,
            updatedByUserId: ctx.userId,
          },
        });
        await this.audit(tx, ctx, 'journal.withdrawn', journalId, now, origin, {
          approvalRequestId: journal.approvalRequestId,
        });
        return this.load(tx, ctx.organizationId, journalId);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Posting engine
  // ---------------------------------------------------------------------------

  /**
   * Atomically posts a journal (all of §19 in one transaction; any failure rolls back):
   * organization + authorization (caller), structure, >= 2 lines, balance, amounts, currency,
   * exchange rate, open period, approvals, then numbering, base amounts, audit and outbox.
   */
  private async postInTransaction(
    tx: Transaction,
    actor: Actor,
    journal: JournalEntry,
    origin: EventOrigin,
    options: {
      presetBase?: Map<number, { baseDebit: string | null; baseCredit: string | null }>;
      /** Reversals post directly without approval (decision E22). */
      reversal?: boolean;
    } = {},
  ): Promise<JournalEntry> {
    const settings = await requireAccountingSettings(tx, actor.organizationId);

    if (journal.status === 'DRAFT' && options.reversal) {
      if (journal.source !== 'reversal')
        throw invalidState('Only reversal journals bypass approval.');
    } else if (journal.status === 'DRAFT') {
      if (await this.approvals.isApprovalRequired(tx, actor.organizationId, JOURNAL_POST_ACTION)) {
        throw new ApprovalRequiredError(
          'This organization requires approval: submit the journal first.',
        );
      }
    } else if (journal.status === 'PENDING_APPROVAL') {
      if (journal.approvalRequestId) {
        const request = await getApprovalRequest(
          tx,
          actor.organizationId,
          journal.approvalRequestId,
        );
        if (request?.status !== 'approved') {
          throw new ApprovalRequiredError('The journal has not received all required approvals.');
        }
      }
    } else {
      throw invalidState(`A ${journal.status} journal cannot be posted.`);
    }

    const checked = await this.validateForPosting(tx, actor.organizationId, settings, journal, {
      lockPeriod: true,
      reversal: options.reversal === true,
    });
    let baseLines: {
      lineNumber: number;
      baseDebit: string | null;
      baseCredit: string | null;
      roundingAdjustment: string;
    }[];
    if (options.presetBase) {
      baseLines = checked.lines.map((l) => ({
        lineNumber: l.lineNumber,
        ...options.presetBase!.get(l.lineNumber)!,
        roundingAdjustment: '0',
      }));
    } else {
      const conversion = convertJournalToBase(checked.lines, checked.rate, settings.baseCurrency);
      baseLines = conversion.lines.map((l) => ({
        lineNumber: l.lineNumber,
        baseDebit: l.side === 'debit' ? fixedAmount(l.baseAmount) : null,
        baseCredit: l.side === 'credit' ? fixedAmount(l.baseAmount) : null,
        roundingAdjustment: fixedAmount(l.roundingAdjustment),
      }));
    }
    const totalBase = baseLines.reduce(
      (acc, l) => (l.baseDebit ? acc.plus(decimal(l.baseDebit)) : acc),
      decimal(0),
    );
    const totalBaseCredit = baseLines.reduce(
      (acc, l) => (l.baseCredit ? acc.plus(decimal(l.baseCredit)) : acc),
      decimal(0),
    );
    if (!totalBase.eq(totalBaseCredit)) {
      throw invalidJournal([{ path: 'lines', message: 'Base-currency amounts do not balance.' }]);
    }

    await writeBaseAmounts(
      tx,
      actor.organizationId,
      baseLines.map((l) => ({ journalId: journal.id, ...l })),
    );
    const now = this.now;
    const number = await allocateJournalNumber(tx, actor.organizationId);
    const posted = await transitionJournal(tx, {
      organizationId: actor.organizationId,
      journalId: journal.id,
      from: journal.status,
      set: {
        status: 'POSTED',
        journalNumber: number,
        periodId: checked.period.id,
        exchangeRate: checked.rate.toFixed(10),
        exchangeRateSource: checked.rateSource,
        baseCurrency: settings.baseCurrency,
        totalDebit: fixedAmount(checked.total),
        totalCredit: fixedAmount(checked.total),
        totalBaseDebit: fixedAmount(totalBase),
        totalBaseCredit: fixedAmount(totalBase),
        postedByUserId: actor.userId,
        postedAt: now,
        updatedByUserId: actor.userId,
      },
    });
    if (!posted) throw invalidState('The journal changed while posting; try again.');

    const adjustments = baseLines.filter((l) => !decimal(l.roundingAdjustment).isZero());
    await this.audit(tx, actor, 'journal.posted', journal.id, now, origin, {
      number,
      source: journal.source,
      entryDate: journal.entryDate,
      periodId: checked.period.id,
      currency: journal.currency,
      exchangeRate: checked.rate.toFixed(10),
      exchangeRateSource: checked.rateSource,
      baseCurrency: settings.baseCurrency,
      total: fixedAmount(checked.total),
      totalBase: fixedAmount(totalBase),
      roundingAdjustments: adjustments.map((l) => ({
        line: l.lineNumber,
        amount: l.roundingAdjustment,
      })),
      approvalRequestId: journal.approvalRequestId,
    });
    await enqueueOutboxEvent(
      tx,
      {
        eventType: 'accounting.journal_posted',
        aggregateType: 'accounting_journal',
        aggregateId: journal.id,
        organizationId: actor.organizationId,
        payload: {
          journalId: journal.id,
          number,
          entryDate: journal.entryDate,
          source: journal.source,
        },
      },
      now,
    );
    return posted;
  }

  postJournal(principal: Principal, journalId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsPost, sensitive: true },
      async (tx, ctx) => {
        const journal = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
        if (!journal) throw new NotFoundError('Journal not found.');
        await this.postInTransaction(
          tx,
          { organizationId: ctx.organizationId, userId: ctx.userId },
          journal,
          origin,
        );
        return this.load(tx, ctx.organizationId, journalId);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Reversal
  // ---------------------------------------------------------------------------

  /**
   * Reverses a posted journal with a new journal that swaps every debit and credit and
   * reuses the original's exchange rate and exact base amounts. The original is never
   * modified beyond its lifecycle status (POSTED -> REVERSED). The reversal posts directly
   * into an open period (default: the original date when that period is open).
   */
  reverseJournal(
    principal: Principal,
    journalId: string,
    input: { reason: string; reversalDate?: string | undefined },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsReverse, sensitive: true },
      async (tx, ctx) => {
        await requireAccountingSettings(tx, ctx.organizationId);
        const original = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
        if (!original) throw new NotFoundError('Journal not found.');
        if (original.status !== 'POSTED')
          throw invalidState(`A ${original.status} journal cannot be reversed.`);
        if (input.reversalDate !== undefined && !isValidIsoDate(input.reversalDate)) {
          throw new ValidationError([
            { path: 'reversalDate', message: 'Enter a valid date (YYYY-MM-DD).' },
          ]);
        }
        const reversalDate = input.reversalDate ?? original.entryDate!;
        const period = await findPeriodForDate(tx, ctx.organizationId, reversalDate);
        if (!period) {
          throw new AppError(
            'PERIOD_NOT_FOUND',
            409,
            'No accounting period covers the reversal date.',
          );
        }
        if (period.status !== 'OPEN') {
          throw new AppError(
            'PERIOD_CLOSED',
            409,
            input.reversalDate
              ? 'The reversal date must fall in an open accounting period.'
              : "The original journal's period is closed; choose a reversal date in an open period.",
          );
        }

        const originalLines = await getJournalLines(tx, ctx.organizationId, [journalId]);
        const reversal = await createDraftJournal(tx, {
          organizationId: ctx.organizationId,
          entryDate: reversalDate,
          description:
            `Reversal of journal ${original.journalNumber}: ${input.reason.trim()}`.slice(0, 1000),
          reference: original.reference,
          currency: original.currency,
          exchangeRate: original.exchangeRate,
          exchangeRateSource: original.exchangeRateSource,
          lines: originalLines.map((l) => ({
            accountId: l.accountId,
            description: l.description,
            debit: l.credit,
            credit: l.debit,
          })),
          userId: ctx.userId,
          source: 'reversal',
        });
        const presetBase = new Map(
          originalLines.map((l) => [
            l.lineNumber,
            { baseDebit: l.baseCredit, baseCredit: l.baseDebit },
          ]),
        );
        const now = this.now;
        const posted = await this.postInTransaction(
          tx,
          { organizationId: ctx.organizationId, userId: ctx.userId },
          reversal,
          origin,
          { presetBase, reversal: true },
        );
        await recordReversal(tx, {
          organizationId: ctx.organizationId,
          originalJournalId: journalId,
          reversalJournalId: reversal.id,
          reason: input.reason,
          userId: ctx.userId,
          now,
        });
        const reversed = await transitionJournal(tx, {
          organizationId: ctx.organizationId,
          journalId,
          from: 'POSTED',
          set: { status: 'REVERSED', reversedAt: now, reversedByUserId: ctx.userId },
        });
        if (!reversed) throw invalidState('The journal changed while reversing; try again.');
        await this.audit(tx, ctx, 'journal.reversed', journalId, now, origin, {
          originalNumber: original.journalNumber,
          reversalJournalId: reversal.id,
          reversalNumber: posted.journalNumber,
          reversalDate,
          reason: input.reason.trim(),
        });
        await enqueueOutboxEvent(
          tx,
          {
            eventType: 'accounting.journal_reversed',
            aggregateType: 'accounting_journal',
            aggregateId: journalId,
            organizationId: ctx.organizationId,
            payload: { journalId, reversalJournalId: reversal.id },
          },
          now,
        );
        return {
          original: journalView(reversed),
          reversal: await this.load(tx, ctx.organizationId, reversal.id),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Accounting events (foundation for future operational modules)
  // ---------------------------------------------------------------------------

  /** Registers how an accounting event type becomes a journal (none in Phase 2). */
  registerEventHandler(eventType: string, handler: AccountingEventHandler): void {
    this.eventHandlers.set(eventType, handler);
  }

  /**
   * Receives an accounting event idempotently. Replays of the same event never create a
   * second journal. A registered handler turns the event into a journal that is posted
   * through the same engine (or submitted for approval when the organization requires it).
   */
  receiveEvent(input: {
    organizationId: string;
    sourceModule: string;
    eventType: string;
    eventKey: string;
    payload: Record<string, unknown>;
    occurredAt: Date;
    origin: EventOrigin;
  }) {
    const now = this.now;
    return inTransaction(this.deps.db, { organizationId: input.organizationId }, async (tx) => {
      await setDbContext(tx, { organizationId: input.organizationId });
      await requireAccountingSettings(tx, input.organizationId);
      const received = await receiveAccountingEvent(tx, { ...input, now });
      if (received.outcome === 'conflict') {
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          409,
          'An accounting event with this key was already received with different content.',
        );
      }
      if (received.outcome === 'duplicate') {
        return {
          outcome: 'duplicate' as const,
          eventId: received.event.id,
          journalId: received.event.journalId,
          status: received.event.status,
        };
      }
      const handler = this.eventHandlers.get(input.eventType);
      if (!handler) {
        return {
          outcome: 'received' as const,
          eventId: received.event.id,
          journalId: null,
          status: 'received' as const,
        };
      }
      const actor: Actor = { organizationId: input.organizationId, userId: null };
      try {
        const journalId = await tx.transaction(async (savepoint) => {
          const journalInput = handler({ eventType: input.eventType, payload: input.payload });
          if (!journalInput) return null;
          const journal = await createDraftJournal(savepoint, {
            ...journalInput,
            organizationId: input.organizationId,
            userId: null,
            source: 'event',
            accountingEventId: received.event.id,
          });
          if (
            await this.approvals.isApprovalRequired(
              savepoint,
              input.organizationId,
              JOURNAL_POST_ACTION,
            )
          ) {
            // Approval is required: the event journal waits as a draft for the normal workflow.
            return journal.id;
          }
          await this.postInTransaction(savepoint, actor, journal, input.origin);
          return journal.id;
        });
        await completeAccountingEvent(tx, {
          organizationId: input.organizationId,
          eventId: received.event.id,
          status: 'processed',
          journalId,
          error: null,
          now,
        });
        return {
          outcome: 'processed' as const,
          eventId: received.event.id,
          journalId,
          status: 'processed' as const,
        };
      } catch (error) {
        await completeAccountingEvent(tx, {
          organizationId: input.organizationId,
          eventId: received.event.id,
          status: 'failed',
          journalId: null,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          now,
        });
        return {
          outcome: 'failed' as const,
          eventId: received.event.id,
          journalId: null,
          status: 'failed' as const,
        };
      }
    });
  }
}
