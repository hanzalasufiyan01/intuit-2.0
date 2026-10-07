import { AppError, ConflictError, NotFoundError, ValidationError } from '../domain/errors.js';
import { decimal, isSupportedCurrency, minorUnits, parseRate } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  AccountingPermissions,
  addDays,
  deleteRevaluationRun,
  findActiveRunForDate,
  findApplicableRate,
  findPeriodForDate,
  findRunByKey,
  getDesignatedAccountId,
  getRevaluationRun,
  insertRevaluationLines,
  insertRevaluationRun,
  isValidIsoDate,
  linkRevaluationJournal,
  listAccounts,
  listRevaluationJournals,
  listRevaluationLines,
  listRevaluationRuns,
  lockRevaluation,
  planRevaluation,
  queryAccountExposures,
  REVALUATION_SOURCE,
  updateRevaluationRun,
  type ClosingRate,
  type RevaluationExposure,
  type RevaluationLine,
  type RevaluationPlan,
  type RevaluationRun,
  type RuleIssue,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { MAX_JOURNAL_LINES, type JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import type { RevaluationExposureRegistry } from './revaluation-exposures.js';
import { documentApprovalState } from './sales-documents.js';

const RESOURCE = 'accounting_revaluation_run';
/** P4-52: the approval action of the revaluation user workflow, on the S9 PENDING_APPROVAL state. */
export const REVALUATION_POST_ACTION = 'accounting.revaluation.post';
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = () =>
  new ConflictError(
    'VERSION_CONFLICT',
    'The revaluation run was changed by someone else. Reload and try again.',
  );

type Settings = Awaited<ReturnType<typeof requireAccountingSettings>>;

/**
 * How the sensitive-action confirmation was satisfied, recorded on the audit event.
 * - `session`: the production path (`post`/`cancel`), which requires a recent password
 *   re-authentication of the caller's session.
 * - `dev_trigger_bypass`: the development/testing trigger only (no browser session exists). It is
 *   passed exclusively by `runDevRevaluation`, which refuses to run outside APP_ENV
 *   development/testing and still checks the acting user's identity, permission and MFA.
 */
export type RevaluationReauthentication = 'session' | 'dev_trigger_bypass';
type Actor = Pick<AuthorizationContext, 'organizationId' | 'userId'>;

export interface RevaluationInput {
  revaluationDate: string;
  /** Idempotency key: a retry with the same key returns the run it created. */
  runKey?: string | null;
  /** Explicit closing rates per currency (source `manual`), for later phases and tests. */
  rates?: Record<string, string>;
}

/** A blocking problem; `code` marks the ones reported with their own error code. */
interface Blocker extends RuleIssue {
  code?: 'DESIGNATION_REQUIRED' | 'PERIOD_NOT_FOUND' | 'PERIOD_CLOSED' | 'EXCHANGE_RATE_REQUIRED';
}

interface Evaluation {
  revaluationDate: string;
  reversalDate: string;
  unrealizedAccountId: string | null;
  errors: Blocker[];
  warnings: RuleIssue[];
  plan: RevaluationPlan | null;
}

/**
 * Foreign-currency revaluation support (Decision 9, S9), owned by accounting. A run revalues every
 * foreign-currency monetary exposure at the closing rate of its date D: one base-only
 * `revaluation` journal per currency against the designated Unrealized FX account, posted through
 * `postSystemJournal`, and its mirrored `revaluation_reversal` dated D + 1 (the REVERSING method),
 * all in one transaction. A posted run is corrected only by cancelling it, which reverses every
 * journal of the run through the journal engine's revaluation reversal path.
 *
 * S9 has no HTTP routes or UI (Phase 4); callers are the development trigger and tests.
 */
export class RevaluationService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    readonly providers: RevaluationExposureRegistry,
    private readonly approvals: ApprovalService,
  ) {
    approvals.register({
      actionKey: REVALUATION_POST_ACTION,
      label: 'Approve foreign-currency revaluations before posting',
      subjectType: RESOURCE,
      approverPermission: AccountingPermissions.JournalsApprove,
      decisionRequiresReauth: false,
      // P4-52: the size of the revaluation in base (gain plus loss); the type is `revaluation`.
      conditions: { amount: true, transactionTypes: ['revaluation'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        // Approval authorizes; the run stays pending until someone posts it.
        await this.audit(tx, authz, 'revaluation.approved', request.subjectId, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the revaluation.' },
          ]);
        }
        const run = await getRevaluationRun(tx, authz.organizationId, request.subjectId, {
          forUpdate: true,
        });
        if (!run || run.status !== 'PENDING_APPROVAL') {
          throw invalidState('The revaluation is no longer awaiting approval.');
        }
        await this.discardPending(tx, authz, run, now, origin, 'revaluation.rejected', {
          approvalRequestId: request.id,
          comment: comment.trim(),
        });
      },
    });
  }

  private get now() {
    return this.deps.clock.now();
  }

  private async audit(
    tx: Transaction,
    actor: Actor,
    action: string,
    runId: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      action,
      resourceType: RESOURCE,
      resourceId: runId,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  list(principal: Principal, options: { limit?: number } = {}) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        const runs = await listRevaluationRuns(tx, ctx.organizationId, options.limit ?? 50);
        return runs.map(runView);
      },
    );
  }

  get(principal: Principal, runId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        const run = await getRevaluationRun(tx, ctx.organizationId, runId);
        if (!run) throw new NotFoundError('Revaluation run not found.');
        return this.detailWithApproval(tx, ctx, run);
      },
    );
  }

  async detail(tx: Transaction, organizationId: string, run: RevaluationRun) {
    const [lines, journals] = await Promise.all([
      listRevaluationLines(tx, organizationId, run.id),
      listRevaluationJournals(tx, organizationId, run.id),
    ]);
    return {
      ...runView(run),
      journalCount: journals.filter((j) => j.role === 'REVALUATION').length,
      lines: lines.map((l) => ({
        lineNumber: l.lineNumber,
        exposureKind: l.exposureKind,
        accountId: l.accountId,
        currency: l.currencyCode,
        document:
          l.documentId === null
            ? null
            : { module: l.documentModule, type: l.documentType, id: l.documentId },
        foreignBalance: trim(l.foreignBalance),
        carryingBase: trim(l.carryingBase),
        rate: trim(l.rate),
        rateDate: l.rateDate,
        rateSource: l.rateSource,
        revaluedBase: trim(l.revaluedBase),
        adjustment: trim(l.adjustment),
      })),
      journals: journals.map((j) => ({
        journalId: j.journalId,
        number: j.number,
        currency: j.currency,
        role: j.role,
        status: j.status,
        entryDate: j.entryDate,
      })),
    };
  }

  /** The calculation at a date without writing anything (errors and warnings included). */
  preview(principal: Principal, input: Omit<RevaluationInput, 'runKey'>) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsView },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const evaluation = await this.evaluate(tx, ctx.organizationId, settings, input);
        const approvalRequired =
          evaluation.plan && !evaluation.errors.length
            ? (
                await this.approvals.requirementFor(
                  tx,
                  ctx.organizationId,
                  REVALUATION_POST_ACTION,
                  this.factsOf(evaluation.plan, settings.baseCurrency),
                )
              ).required
            : false;
        return {
          approvalRequired,
          revaluationDate: evaluation.revaluationDate,
          reversalDate: evaluation.reversalDate,
          errors: evaluation.errors.map(({ path, message }) => ({ path, message })),
          warnings: evaluation.warnings,
          lines:
            evaluation.plan?.lines.map((l) => ({
              lineNumber: l.lineNumber,
              exposureKind: l.exposure.kind,
              accountId: l.exposure.accountId,
              accountCode: l.exposure.accountCode,
              currency: l.exposure.currency,
              foreignBalance: trim(l.exposure.foreignBalance),
              carryingBase: trim(l.exposure.carryingBase),
              rate: trim(l.rate.rate),
              rateDate: l.rate.rateDate,
              revaluedBase: l.revaluedBase,
              adjustment: l.adjustment,
            })) ?? [],
          journals:
            evaluation.plan?.journals.map((j) => ({
              currency: j.currency,
              rate: trim(j.rate.rate),
              gain: j.gain,
              loss: j.loss,
              lines: j.lines,
            })) ?? [],
          totals: evaluation.plan?.totals ?? { gain: '0', loss: '0', net: '0' },
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Posting
  // ---------------------------------------------------------------------------

  /**
   * Posts a run (S9): `accounting.journals.post` plus re-authentication. When an approval policy
   * applies to the run (Phase 4B-10, P4-52), it is refused and must go through `submit`.
   */
  post(principal: Principal, input: RevaluationInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsPost, sensitive: true },
      (tx, ctx) =>
        this.postInTransaction(tx, ctx, input, origin, {
          trigger: 'user',
          jobId: null,
          reauthentication: 'session',
        }),
    );
  }

  /**
   * The posting sequence, in the caller's transaction (the caller has authorized the action):
   * lock, idempotency and duplicate checks, calculation, the approval check, the DRAFT run and its
   * lines, one revaluation journal per currency on D with its mirrored reversal on D + 1, the
   * journal links, the move to POSTED and the audit event. Any failure rolls all of it back.
   */
  async postInTransaction(
    tx: Transaction,
    actor: Actor,
    input: RevaluationInput,
    origin: EventOrigin,
    options: {
      trigger: 'user' | 'job';
      jobId: string | null;
      reauthentication: RevaluationReauthentication;
    },
  ) {
    const settings = await requireAccountingSettings(tx, actor.organizationId);
    const runKey = input.runKey?.trim() || null;
    await lockRevaluation(tx, actor.organizationId);

    const replay = await this.guardNewRun(tx, actor.organizationId, runKey, input.revaluationDate);
    if (replay) return { ...(await this.detail(tx, actor.organizationId, replay)), replayed: true };

    const evaluation = await this.evaluate(tx, actor.organizationId, settings, input);
    const plan = this.assertPostable(evaluation);
    // P4-52 / S10: a policy step that matches the run's facts means it is approved, then posted.
    const facts = this.factsOf(plan, settings.baseCurrency);
    const requirement = await this.approvals.requirementFor(
      tx,
      actor.organizationId,
      REVALUATION_POST_ACTION,
      facts,
    );
    if (requirement.required) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        409,
        'This revaluation needs approval: submit it for approval first.',
      );
    }

    const now = this.now;
    const run = await this.createRun(tx, actor, settings, evaluation, plan, runKey, options, now);
    const updated = await this.postRunJournals(tx, actor, run, evaluation, plan, origin, now, {
      trigger: options.trigger,
      reauthentication: options.reauthentication,
      from: 'DRAFT',
    });
    return { ...(await this.detail(tx, actor.organizationId, updated)), replayed: false };
  }

  /** Idempotent retry by run key, and one active run per revaluation date. */
  private async guardNewRun(
    tx: Transaction,
    organizationId: string,
    runKey: string | null,
    revaluationDate: string,
  ): Promise<RevaluationRun | null> {
    if (runKey) {
      const existing = await findRunByKey(tx, organizationId, runKey);
      if (existing) {
        if (existing.revaluationDate !== revaluationDate) {
          throw new ConflictError(
            'IDEMPOTENCY_CONFLICT',
            'This run key was already used for a revaluation at another date.',
          );
        }
        return existing;
      }
    }
    if (isValidIsoDate(revaluationDate)) {
      const active = await findActiveRunForDate(tx, organizationId, revaluationDate);
      if (active) {
        throw new ConflictError(
          'CONFLICT',
          active.status === 'POSTED'
            ? `A revaluation at ${revaluationDate} is already posted. Cancel it before revaluing that date again.`
            : `A revaluation at ${revaluationDate} is already awaiting approval. Withdraw it before revaluing that date again.`,
        );
      }
    }
    return null;
  }

  /** The calculation must be free of blocking problems; returns its plan. */
  private assertPostable(evaluation: Evaluation): RevaluationPlan {
    const coded = evaluation.errors.find((e) => e.code);
    if (coded?.code) throw new AppError(coded.code, 409, coded.message);
    if (evaluation.errors.length || !evaluation.plan || !evaluation.unrealizedAccountId) {
      throw new ValidationError(evaluation.errors, 'The revaluation cannot be posted.');
    }
    return evaluation.plan;
  }

  /** The approval facts of a run: the revaluation's size in base (gain plus loss). */
  private factsOf(plan: RevaluationPlan, baseCurrency: string): ApprovalFacts {
    return {
      transactionType: 'revaluation',
      baseAmount: decimal(plan.totals.gain)
        .plus(plan.totals.loss)
        .toFixed(minorUnits(baseCurrency)),
      baseCurrency,
    };
  }

  /** Inserts the DRAFT run with its calculated lines. */
  private async createRun(
    tx: Transaction,
    actor: Actor,
    settings: Settings,
    evaluation: Evaluation,
    plan: RevaluationPlan,
    runKey: string | null,
    options: { trigger: 'user' | 'job'; jobId: string | null },
    now: Date,
  ): Promise<RevaluationRun> {
    const run = await insertRevaluationRun(tx, {
      organizationId: actor.organizationId,
      revaluationDate: evaluation.revaluationDate,
      reversalDate: evaluation.reversalDate,
      baseCurrency: settings.baseCurrency,
      unrealizedAccountId: evaluation.unrealizedAccountId!,
      runKey,
      trigger: options.trigger,
      jobId: options.jobId,
      userId: actor.userId!,
      now,
    });
    await insertRevaluationLines(tx, lineRows(actor.organizationId, run.id, plan));
    return run;
  }

  /**
   * Posts the journals of a DRAFT run: one revaluation journal per currency on D with its mirrored
   * reversal on D + 1, the links, the move to POSTED and the audit event (S9, unchanged).
   */
  private async postRunJournals(
    tx: Transaction,
    actor: Actor,
    run: RevaluationRun,
    evaluation: Evaluation,
    plan: RevaluationPlan,
    origin: EventOrigin,
    now: Date,
    options: {
      trigger: 'user' | 'job';
      reauthentication: RevaluationReauthentication;
      from: 'DRAFT';
      approvalRequestId?: string | null;
    },
  ): Promise<RevaluationRun> {
    const posted: { currency: string; journalId: string; reversalJournalId: string }[] = [];
    for (const journal of plan.journals) {
      const revaluation = await this.journals.postSystemJournal(
        tx,
        {
          organizationId: actor.organizationId,
          userId: actor.userId,
          source: { ...REVALUATION_SOURCE, id: run.id },
          entryDate: evaluation.revaluationDate,
          description: `Revaluation of ${journal.currency} balances at ${evaluation.revaluationDate}`,
          reference: `Revaluation ${evaluation.revaluationDate}`,
          currency: journal.currency,
          exchangeRate: journal.rate.rate,
          exchangeRateSource: journal.rate.source,
          lines: journal.lines,
        },
        origin,
      );
      await linkRevaluationJournal(tx, {
        organizationId: actor.organizationId,
        runId: run.id,
        journalId: revaluation.id,
        currency: journal.currency,
        role: 'REVALUATION',
      });
      const reversal = await this.journals.reverseRevaluationJournalInTransaction(
        tx,
        actor,
        revaluation.id,
        {
          entryDate: evaluation.reversalDate,
          mode: 'scheduled',
          reason: `scheduled reversal of the ${evaluation.revaluationDate} revaluation`,
        },
        origin,
      );
      await linkRevaluationJournal(tx, {
        organizationId: actor.organizationId,
        runId: run.id,
        journalId: reversal.id,
        currency: journal.currency,
        role: 'SCHEDULED_REVERSAL',
      });
      posted.push({
        currency: journal.currency,
        journalId: revaluation.id,
        reversalJournalId: reversal.id,
      });
    }

    const updated = await updateRevaluationRun(tx, {
      organizationId: actor.organizationId,
      runId: run.id,
      from: options.from,
      set: {
        status: 'POSTED',
        netAdjustment: plan.totals.net,
        totalGain: plan.totals.gain,
        totalLoss: plan.totals.loss,
        lineCount: plan.lines.length,
        postedByUserId: actor.userId,
        postedAt: now,
        updatedByUserId: actor.userId,
        updatedAt: now,
      },
    });
    if (!updated) throw invalidState('The revaluation run changed while posting; try again.');
    await this.audit(tx, actor, 'revaluation.posted', run.id, now, origin, {
      revaluationDate: run.revaluationDate,
      reversalDate: run.reversalDate,
      method: run.method,
      trigger: run.trigger,
      currencies: plan.journals.map((j) => j.currency),
      lineCount: plan.lines.length,
      journalCount: plan.journals.length,
      totalGain: plan.totals.gain,
      totalLoss: plan.totals.loss,
      netAdjustment: plan.totals.net,
      journals: posted,
      warnings: evaluation.warnings.length,
      reauthentication: options.reauthentication,
      ...(options.approvalRequestId ? { approvalRequestId: options.approvalRequestId } : {}),
    });
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Approval (Phase 4B-10; P4-52): submit, post the approved run, withdraw
  // ---------------------------------------------------------------------------

  /**
   * Calculates the run and, when an approval policy step matches its facts, saves it as
   * PENDING_APPROVAL with an approval request; nothing is posted. The approvers authorize exactly
   * this calculation: posting it later recomputes and refuses if balances or rates have changed.
   * `accounting.journals.post` is needed; there is no self-approval.
   */
  submit(principal: Principal, input: RevaluationInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsPost },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const runKey = input.runKey?.trim() || null;
        await lockRevaluation(tx, ctx.organizationId);
        const replay = await this.guardNewRun(
          tx,
          ctx.organizationId,
          runKey,
          input.revaluationDate,
        );
        if (replay) {
          return { ...(await this.detailWithApproval(tx, ctx, replay)), replayed: true };
        }
        const evaluation = await this.evaluate(tx, ctx.organizationId, settings, input);
        const plan = this.assertPostable(evaluation);
        const facts = this.factsOf(plan, settings.baseCurrency);
        const now = this.now;
        const run = await this.createRun(
          tx,
          ctx,
          settings,
          evaluation,
          plan,
          runKey,
          { trigger: 'user', jobId: null },
          now,
        );
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: REVALUATION_POST_ACTION,
          subjectId: run.id,
          // No self-approval: the submitter cannot approve their own revaluation.
          excludedUserIds: [ctx.userId],
          reason: null,
          facts,
          now,
        });
        if (!request) {
          throw invalidState('No approval step applies to this revaluation; post it directly.');
        }
        const updated = await updateRevaluationRun(tx, {
          organizationId: ctx.organizationId,
          runId: run.id,
          from: 'DRAFT',
          set: {
            status: 'PENDING_APPROVAL',
            approvalRequestId: request.id,
            netAdjustment: plan.totals.net,
            totalGain: plan.totals.gain,
            totalLoss: plan.totals.loss,
            lineCount: plan.lines.length,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw invalidState('The revaluation run changed while submitting.');
        await this.audit(tx, ctx, 'revaluation.submitted', run.id, now, origin, {
          revaluationDate: run.revaluationDate,
          approvalRequestId: request.id,
          lineCount: plan.lines.length,
          totalGain: plan.totals.gain,
          totalLoss: plan.totals.loss,
          facts,
        });
        return { ...(await this.detailWithApproval(tx, ctx, updated)), replayed: false };
      },
    );
  }

  /**
   * Posts a run whose approval is complete (P4-52): `accounting.journals.post` plus
   * re-authentication. The calculation is repeated and must equal the approved one.
   */
  postApproved(
    principal: Principal,
    runId: string,
    input: { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsPost, sensitive: true },
      async (tx, ctx) => {
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        await lockRevaluation(tx, ctx.organizationId);
        const run = await getRevaluationRun(tx, ctx.organizationId, runId, { forUpdate: true });
        if (!run) throw new NotFoundError('Revaluation run not found.');
        if (run.version !== input.version) throw versionConflict();
        if (run.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a revaluation awaiting approval can be posted this way.');
        }
        const evaluation = await this.evaluate(tx, ctx.organizationId, settings, {
          revaluationDate: run.revaluationDate,
        });
        const plan = this.assertPostable(evaluation);
        // The approvers authorized one calculation; balances or rates must not have moved.
        const stored = await listRevaluationLines(tx, ctx.organizationId, run.id);
        if (
          evaluation.unrealizedAccountId !== run.unrealizedAccountId ||
          !sameCalculation(stored, lineRows(ctx.organizationId, run.id, plan))
        ) {
          throw new AppError(
            'APPROVAL_REQUIRED',
            409,
            'Balances or exchange rates have changed since this revaluation was submitted. Withdraw it and submit it again.',
          );
        }
        const approval = await documentApprovalState(
          this.approvals,
          tx,
          ctx.organizationId,
          REVALUATION_POST_ACTION,
          run,
          this.factsOf(plan, settings.baseCurrency),
        );
        if (!approval.readyToIssue) {
          throw new AppError(
            'APPROVAL_REQUIRED',
            409,
            approval.approvalOutdated
              ? 'The revaluation now needs further approval. Withdraw it and submit it again.'
              : 'The revaluation has not received all required approvals.',
          );
        }
        const now = this.now;
        // Journals link to a DRAFT run only (migration 0017): the run returns to draft first.
        const draft = await updateRevaluationRun(tx, {
          organizationId: ctx.organizationId,
          runId: run.id,
          from: 'PENDING_APPROVAL',
          version: run.version,
          set: { status: 'DRAFT', updatedByUserId: ctx.userId, updatedAt: now },
        });
        if (!draft) throw versionConflict();
        const updated = await this.postRunJournals(tx, ctx, draft, evaluation, plan, origin, now, {
          trigger: 'user',
          reauthentication: 'session',
          from: 'DRAFT',
          approvalRequestId: run.approvalRequestId,
        });
        return this.detailWithApproval(tx, ctx, updated);
      },
    );
  }

  /** Withdraws a run awaiting approval: the request is withdrawn and the draft run is removed. */
  withdraw(principal: Principal, runId: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsPost },
      async (tx, ctx) => {
        await lockRevaluation(tx, ctx.organizationId);
        const run = await getRevaluationRun(tx, ctx.organizationId, runId, { forUpdate: true });
        if (!run) throw new NotFoundError('Revaluation run not found.');
        if (run.version !== input.version) throw versionConflict();
        if (run.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only a revaluation awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = run.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, run.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        await this.discardPending(tx, ctx, run, now, origin, 'revaluation.withdrawn', {
          approvalRequestId: request?.id ?? null,
        });
        return { id: run.id, discarded: true };
      },
    );
  }

  /** Returns a pending run to draft and removes it, freeing its date; the audit event stays. */
  private async discardPending(
    tx: Transaction,
    actor: Actor,
    run: RevaluationRun,
    now: Date,
    origin: EventOrigin,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    const draft = await updateRevaluationRun(tx, {
      organizationId: actor.organizationId,
      runId: run.id,
      from: 'PENDING_APPROVAL',
      set: { status: 'DRAFT', updatedByUserId: actor.userId, updatedAt: now },
    });
    if (!draft) throw invalidState('The revaluation run is no longer awaiting approval.');
    await deleteRevaluationRun(tx, actor.organizationId, run.id);
    await this.audit(tx, actor, action, run.id, now, origin, {
      revaluationDate: run.revaluationDate,
      ...metadata,
    });
  }

  /** The run's detail with its approval state (the facts come from the stored totals). */
  private async detailWithApproval(tx: Transaction, ctx: Actor, run: RevaluationRun) {
    const detail = await this.detail(tx, ctx.organizationId, run);
    const open = run.status === 'DRAFT' || run.status === 'PENDING_APPROVAL';
    const facts = open ? this.factsOfTotals(run.totalGain, run.totalLoss, run.baseCurrency) : null;
    return {
      ...detail,
      approval: await documentApprovalState(
        this.approvals,
        tx,
        ctx.organizationId,
        REVALUATION_POST_ACTION,
        run,
        facts,
      ),
    };
  }

  private factsOfTotals(gain: string, loss: string, baseCurrency: string): ApprovalFacts {
    return {
      transactionType: 'revaluation',
      baseAmount: decimal(gain).plus(loss).toFixed(minorUnits(baseCurrency)),
      baseCurrency,
    };
  }

  // ---------------------------------------------------------------------------
  // Cancellation
  // ---------------------------------------------------------------------------

  /** Cancels a posted run (S9): `accounting.journals.reverse` plus re-authentication. */
  cancel(
    principal: Principal,
    runId: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsReverse, sensitive: true },
      (tx, ctx) =>
        this.cancelInTransaction(tx, ctx, runId, input, origin, { reauthentication: 'session' }),
    );
  }

  /**
   * Reverses every journal of a posted run (the revaluation on D and its reversal on D + 1), each
   * on its own date, through the journal engine's revaluation reversal path; then the run becomes
   * REVERSED. One transaction; both periods must still be open.
   */
  async cancelInTransaction(
    tx: Transaction,
    actor: Actor,
    runId: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
    options: { reauthentication: RevaluationReauthentication },
  ) {
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new ValidationError([
        { path: 'reason', message: 'Give a reason of 3 to 500 characters.' },
      ]);
    }
    await lockRevaluation(tx, actor.organizationId);
    const run = await getRevaluationRun(tx, actor.organizationId, runId, { forUpdate: true });
    if (!run) throw new NotFoundError('Revaluation run not found.');
    if (run.version !== input.version) {
      throw new ConflictError(
        'VERSION_CONFLICT',
        'The revaluation run was changed by someone else. Reload and try again.',
      );
    }
    if (run.status !== 'POSTED')
      throw invalidState('Only a posted revaluation run can be cancelled.');

    const journals = (await listRevaluationJournals(tx, actor.organizationId, run.id)).filter(
      (j) => j.role !== 'CANCELLATION' && j.status === 'POSTED',
    );
    const cancellations = [];
    for (const journal of journals) {
      const reversal = await this.journals.reverseRevaluationJournalInTransaction(
        tx,
        actor,
        journal.journalId,
        { entryDate: journal.entryDate!, mode: 'cancellation', reason },
        origin,
      );
      await linkRevaluationJournal(tx, {
        organizationId: actor.organizationId,
        runId: run.id,
        journalId: reversal.id,
        currency: journal.currency,
        role: 'CANCELLATION',
      });
      cancellations.push({ journalId: journal.journalId, cancellationJournalId: reversal.id });
    }
    const now = this.now;
    const updated = await updateRevaluationRun(tx, {
      organizationId: actor.organizationId,
      runId: run.id,
      from: 'POSTED',
      version: run.version,
      set: {
        status: 'REVERSED',
        reversedByUserId: actor.userId,
        reversedAt: now,
        reversalReason: reason,
        updatedByUserId: actor.userId,
        updatedAt: now,
      },
    });
    if (!updated) throw invalidState('The revaluation run changed while cancelling; try again.');
    await this.audit(tx, actor, 'revaluation.reversed', run.id, now, origin, {
      revaluationDate: run.revaluationDate,
      method: run.method,
      reason,
      journals: cancellations,
      reauthentication: options.reauthentication,
    });
    return this.detail(tx, actor.organizationId, updated);
  }

  // ---------------------------------------------------------------------------
  // Calculation
  // ---------------------------------------------------------------------------

  private async evaluate(
    tx: Transaction,
    organizationId: string,
    settings: Settings,
    input: Omit<RevaluationInput, 'runKey'>,
  ): Promise<Evaluation> {
    const errors: Blocker[] = [];
    const date = input.revaluationDate;
    if (!isValidIsoDate(date)) {
      return {
        revaluationDate: date,
        reversalDate: '',
        unrealizedAccountId: null,
        errors: [{ path: 'revaluationDate', message: 'Enter a valid date (YYYY-MM-DD).' }],
        warnings: [],
        plan: null,
      };
    }
    const reversalDate = addDays(date, 1);

    const overrides = new Map<string, ClosingRate>();
    for (const [currency, value] of Object.entries(input.rates ?? {})) {
      if (!isSupportedCurrency(currency) || currency === settings.baseCurrency) {
        errors.push({ path: `rates.${currency}`, message: `${currency} cannot be revalued.` });
      } else if (!parseRate(value).ok) {
        errors.push({
          path: `rates.${currency}`,
          message: 'Rates are positive decimal strings with at most 10 decimals.',
        });
      } else {
        overrides.set(currency, {
          rate: decimal(value).toFixed(),
          rateDate: date,
          source: 'manual',
        });
      }
    }

    const unrealizedAccountId = await getDesignatedAccountId(
      tx,
      organizationId,
      'UNREALIZED_FX_GAIN_LOSS',
    );
    if (!unrealizedAccountId) {
      errors.push({
        path: 'designations.UNREALIZED_FX_GAIN_LOSS',
        code: 'DESIGNATION_REQUIRED',
        message:
          'Designate an Unrealized FX Gain/Loss account under Accounting > Designations before revaluing.',
      });
    }

    let periodStart: string | null = null;
    for (const [path, day] of [
      ['revaluationDate', date],
      ['reversalDate', reversalDate],
    ] as const) {
      const period = await findPeriodForDate(tx, organizationId, day);
      if (!period) {
        errors.push({
          path,
          code: 'PERIOD_NOT_FOUND',
          message: `No accounting period covers ${day}. Create the fiscal year that includes it; periods are never created automatically.`,
        });
      } else if (period.status !== 'OPEN') {
        errors.push({
          path,
          code: 'PERIOD_CLOSED',
          message: `The accounting period ${period.name}, which covers ${day}, is closed.`,
        });
      } else if (path === 'revaluationDate') {
        periodStart = period.startDate;
      }
    }

    const accountRows = await queryAccountExposures(tx, {
      organizationId,
      baseCurrency: settings.baseCurrency,
      onDate: date,
    });
    // S9 (N8): an archived account with an exposure blocks the whole run; nothing is skipped.
    const archived = accountRows.filter((r) => r.status === 'ARCHIVED');
    if (archived.length) {
      errors.push({
        path: 'accounts',
        message:
          `Archived accounts still carry foreign-currency balances: ` +
          `${archived.map((r) => `${r.accountCode} ${r.accountName}`).join(', ')}. ` +
          'Reactivate them, or clear their balances, before revaluing.',
      });
    }
    const exposures: RevaluationExposure[] = accountRows.map(({ status: _status, ...e }) => e);
    exposures.push(
      ...(await this.documentExposures(tx, organizationId, settings.baseCurrency, date, errors)),
    );

    const rates = new Map<string, ClosingRate | undefined>();
    for (const currency of new Set(exposures.map((e) => e.currency))) {
      const override = overrides.get(currency);
      if (override) {
        rates.set(currency, override);
        continue;
      }
      const found = await findApplicableRate(tx, {
        organizationId,
        fromCurrency: currency,
        toCurrency: settings.baseCurrency,
        onDate: date,
      });
      rates.set(
        currency,
        found
          ? { rate: decimal(found.rate).toFixed(), rateDate: found.rateDate, source: 'table' }
          : undefined,
      );
    }
    for (const currency of overrides.keys()) {
      if (!rates.has(currency)) {
        errors.push({ path: `rates.${currency}`, message: `Nothing is held in ${currency}.` });
      }
    }

    const plan = planRevaluation({
      baseCurrency: settings.baseCurrency,
      exposures,
      rates,
      unrealizedAccountId: unrealizedAccountId ?? '',
      staleBefore: periodStart,
      maxLines: MAX_JOURNAL_LINES,
    });
    for (const issue of plan.issues) {
      errors.push(
        issue.path.startsWith('rates.') ? { ...issue, code: 'EXCHANGE_RATE_REQUIRED' } : issue,
      );
    }
    return {
      revaluationDate: date,
      reversalDate,
      unrealizedAccountId,
      errors,
      warnings: plan.warnings,
      plan,
    };
  }

  /**
   * Exposures reported by the registered document providers (none in S9), checked before use:
   * a known, active leaf account in the base currency or the document currency, a foreign
   * document currency, and decimal amounts.
   */
  private async documentExposures(
    tx: Transaction,
    organizationId: string,
    baseCurrency: string,
    revaluationDate: string,
    errors: Blocker[],
  ): Promise<RevaluationExposure[]> {
    const providers = this.providers.list();
    if (providers.length === 0) return [];
    const accounts = new Map((await listAccounts(tx, organizationId)).map((a) => [a.id, a]));
    const exposures: RevaluationExposure[] = [];
    for (const provider of providers) {
      const reported = await provider.listExposures(tx, {
        organizationId,
        revaluationDate,
        baseCurrency,
      });
      for (const d of reported) {
        const path = `documents.${provider.key}.${d.documentId}`;
        const account = accounts.get(d.controlAccountId);
        const amountsOk = [d.foreignBalance, d.carryingBase].every((v) =>
          /^-?\d+(\.\d+)?$/.test(v),
        );
        if (!account || account.status !== 'ACTIVE' || account.isLeaf === false) {
          errors.push({ path, message: 'The document points to an unusable account.' });
        } else if (
          d.currency === baseCurrency ||
          (account.currencyCode !== baseCurrency && account.currencyCode !== d.currency)
        ) {
          errors.push({ path, message: 'The document currency does not fit its account.' });
        } else if (!amountsOk) {
          errors.push({ path, message: 'The document amounts are not decimal strings.' });
        } else {
          exposures.push({
            kind: 'DOCUMENT',
            accountId: account.id,
            accountCode: account.code,
            accountName: account.name,
            currency: d.currency,
            foreignBalance: d.foreignBalance,
            carryingBase: d.carryingBase,
            document: { module: d.documentModule, type: d.documentType, id: d.documentId },
          });
        }
      }
    }
    return exposures;
  }
}

function trim(value: string): string {
  return decimal(value).toFixed();
}

/** The stored-line rows of a calculation (also the shape compared at approved post). */
function lineRows(organizationId: string, runId: string, plan: RevaluationPlan) {
  return plan.lines.map((l) => ({
    organizationId,
    runId,
    lineNumber: l.lineNumber,
    exposureKind: l.exposure.kind,
    accountId: l.exposure.accountId,
    currencyCode: l.exposure.currency,
    documentModule: l.exposure.document?.module ?? null,
    documentType: l.exposure.document?.type ?? null,
    documentId: l.exposure.document?.id ?? null,
    foreignBalance: l.exposure.foreignBalance,
    carryingBase: l.exposure.carryingBase,
    rate: l.rate.rate,
    rateDate: l.rate.rateDate,
    rateSource: l.rate.source,
    revaluedBase: l.revaluedBase,
    adjustment: l.adjustment,
  }));
}

/** Whether a fresh calculation is the stored (approved) one, line by line. */
function sameCalculation(
  stored: readonly RevaluationLine[],
  fresh: ReturnType<typeof lineRows>,
): boolean {
  const key = (l: {
    lineNumber: number;
    accountId: string;
    currencyCode: string;
    documentId: string | null;
    foreignBalance: string;
    carryingBase: string;
    rate: string;
    rateDate: string;
    rateSource: string;
    revaluedBase: string;
    adjustment: string;
  }) =>
    [
      l.lineNumber,
      l.accountId,
      l.currencyCode,
      l.documentId ?? '',
      trim(l.foreignBalance),
      trim(l.carryingBase),
      trim(l.rate),
      l.rateDate,
      l.rateSource,
      trim(l.revaluedBase),
      trim(l.adjustment),
    ].join('|');
  const a = stored.map(key).sort();
  const b = fresh.map(key).sort();
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function runView(run: RevaluationRun) {
  return {
    id: run.id,
    status: run.status,
    method: run.method,
    revaluationDate: run.revaluationDate,
    reversalDate: run.reversalDate,
    baseCurrency: run.baseCurrency,
    unrealizedAccountId: run.unrealizedAccountId,
    version: run.version,
    runKey: run.runKey,
    trigger: run.trigger,
    netAdjustment: trim(run.netAdjustment),
    totalGain: trim(run.totalGain),
    totalLoss: trim(run.totalLoss),
    lineCount: run.lineCount,
    createdByUserId: run.createdByUserId,
    createdAt: run.createdAt.toISOString(),
    postedAt: run.postedAt?.toISOString() ?? null,
    reversedAt: run.reversedAt?.toISOString() ?? null,
    reversalReason: run.reversalReason,
    approvalRequestId: run.approvalRequestId,
  };
}
