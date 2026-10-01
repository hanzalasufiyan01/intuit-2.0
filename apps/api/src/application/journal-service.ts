import {
  AppError,
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '../domain/errors.js';
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
  getDimensionValuesByIds,
  isFxSystemJournal,
  mirrorJournalLines,
  OPENING_SOURCE,
  REVALUATION_REVERSAL_TYPE,
  REVALUATION_SOURCE,
  getJournalLines,
  getLineDimensions,
  getReversalLinks,
  listDimensionTypes,
  missingRequiredDimensions,
  isValidIsoDate,
  listJournals,
  receiveAccountingEvent,
  recordReversal,
  replaceDraftJournal,
  transitionJournal,
  validateDraftLines,
  validatePostableJournal,
  validateSystemJournal,
  writeBaseAmounts,
  type AccountingSettings,
  type DimensionAssignmentInput,
  type LineDimension,
  type JournalEntry,
  type JournalLine,
  type JournalLineInput,
  type JournalStatus,
  type Period,
  type PostableLine,
  type RuleIssue,
  type SourceRef,
  type SystemJournalLineInput,
} from '../modules/accounting/index.js';
import { getApprovalRequest, type ApprovalFacts } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import { enqueueOutboxEvent } from '../modules/outbox/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { ApprovalRequiredError, type ApprovalService } from './approval-service.js';
import {
  hasPermission,
  requirePermission,
  type AuthorizationContext,
  type Principal,
} from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import { inTransaction, setDbContext } from './unit-of-work.js';
import { withOrganization } from './organization-service.js';

export const JOURNAL_POST_ACTION = 'accounting.journal.post';

/**
 * S10-03: transaction types of journal posting, derived on the server from the journal itself:
 * `imported` (a manual journal created by an import batch), `accounting_event` (a journal of an
 * accounting event) and `manual` (every other manual journal).
 */
export const JOURNAL_TRANSACTION_TYPES = ['manual', 'imported', 'accounting_event'] as const;

export function journalTransactionType(
  journal: Pick<JournalEntry, 'source' | 'sourceModule' | 'sourceType'>,
): (typeof JOURNAL_TRANSACTION_TYPES)[number] {
  if (journal.source === 'event') return 'accounting_event';
  if (journal.sourceModule === 'data_exchange' && journal.sourceType === 'import_batch') {
    return 'imported';
  }
  return 'manual';
}
export const MAX_JOURNAL_LINES = 500;

/** A manual or event journal line. Dimensions are line-level only (Decision 85). */
export interface JournalLineWithDimensions extends JournalLineInput {
  /**
   * Omitted on an edit: the line keeps the assignments of the line at the same position.
   * An empty array removes them.
   */
  dimensions?: DimensionAssignmentInput[] | undefined;
}

export interface JournalInput {
  entryDate: string | null;
  description: string;
  reference: string;
  currency: string;
  exchangeRate: string | null;
  lines: JournalLineWithDimensions[];
}

/** Actor performing an accounting operation: a user, or the system (accounting events). */
export interface Actor {
  organizationId: string;
  userId: string | null;
}

/** Phase 3B E2: journals from this module are reversed only through it. */
const SALES_SOURCE_MODULE = 'sales';

const CONTROL_ACCOUNT_MESSAGE =
  'Control accounts cannot be used in manual journals; they are maintained through their subledger.';
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const invalidJournal = (issues: RuleIssue[]) =>
  new ValidationError(issues, 'The journal is not a valid balanced double entry.');

/** `dimensions` is undefined when the viewer lacks accounting.dimensions.view (Decision 91). */
function lineView(line: JournalLine, dimensions?: readonly LineDimension[]) {
  return {
    lineNumber: line.lineNumber,
    kind: line.lineKind,
    accountId: line.accountId,
    description: line.description,
    debit: line.debit,
    credit: line.credit,
    baseDebit: line.baseDebit,
    baseCredit: line.baseCredit,
    roundingAdjustment: line.roundingAdjustment,
    ...(dimensions
      ? {
          dimensions: dimensions
            .filter((d) => d.journalLineId === line.id)
            .map((d) => ({
              dimensionTypeId: d.dimensionTypeId,
              dimensionValueId: d.dimensionValueId,
              typeCode: d.typeCode,
              typeName: d.typeName,
              valueCode: d.valueCode,
              valueName: d.valueName,
            })),
        }
      : {}),
  };
}

export function journalView(
  journal: JournalEntry,
  lines?: JournalLine[],
  dimensions?: readonly LineDimension[],
) {
  return {
    id: journal.id,
    number: journal.journalNumber,
    status: journal.status,
    source: journal.source,
    sourceModule: journal.sourceModule,
    sourceType: journal.sourceType,
    sourceId: journal.sourceId,
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
    discardedByUserId: journal.discardedByUserId,
    discardedAt: journal.discardedAt?.toISOString() ?? null,
    ...(lines ? { lines: lines.map((l) => lineView(l, dimensions)) } : {}),
  };
}

function countAssignments(lines: readonly JournalLineWithDimensions[]): number {
  return lines.reduce((n, l) => n + (l.dimensions?.length ?? 0), 0);
}

const pairKey = (d: DimensionAssignmentInput) => `${d.dimensionTypeId}:${d.dimensionValueId}`;

/**
 * Decision 91: selecting dimension values needs accounting.dimensions.view. Without it a user
 * may keep the assignments a journal already carries, but may not add new ones.
 */
function assertMayAssignDimensions(
  ctx: AuthorizationContext,
  lines: readonly JournalLineWithDimensions[],
  existing: ReadonlySet<string>,
) {
  if (hasPermission(ctx, AccountingPermissions.DimensionsView)) return;
  const adds = lines.some((l) => (l.dimensions ?? []).some((d) => !existing.has(pairKey(d))));
  if (adds) {
    throw new PermissionDeniedError(
      'You need permission to view dimensions to assign dimension values.',
    );
  }
}

function sumSide(lines: readonly JournalLineInput[], side: 'debit' | 'credit'): Money {
  return lines.reduce((acc, l) => (l[side] ? acc.plus(decimal(l[side]!)) : acc), decimal(0));
}

/**
 * Phase 3B E1: a handler may instead return a system-journal payload (explicit per-line base
 * amounts; base-only lines for the allowlisted FX type), posted through `postSystemJournal` in
 * the same transaction and linked to its event. The journal-type allowlist is unchanged.
 */
export interface EventSystemJournal {
  system: Omit<SystemJournalInput, 'organizationId' | 'userId' | 'accountingEventId'>;
}

export type AccountingEventHandler = (event: {
  eventType: string;
  payload: Record<string, unknown>;
}) =>
  | (JournalInput & {
      sourceRef?: SourceRef;
      /** Phase 3B E1: a document rate taken from the rate table is recorded as such. */
      exchangeRateSource?: 'table' | 'manual';
    })
  | EventSystemJournal
  | null;

export interface EventHandlerOptions {
  /**
   * The originating module has its own approval (Decision 13): its journals post directly,
   * without a second accounting journal approval.
   */
  domainApproval?: boolean;
}

export interface EventIntakeInput {
  organizationId: string;
  sourceModule: string;
  eventType: string;
  eventKey: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  origin: EventOrigin;
}

export interface SystemJournalInput {
  organizationId: string;
  /** The user whose action produced the journal, or null for the system. */
  userId: string | null;
  source: SourceRef;
  entryDate: string;
  description: string;
  reference: string;
  currency: string;
  /** Used when the currency is not the base currency (otherwise the rate table applies). */
  exchangeRate: string | null;
  /** Where a supplied rate came from (default 'manual'); S9 passes 'table' for table rates. */
  exchangeRateSource?: 'manual' | 'table';
  lines: SystemJournalLineInput[];
  /** Phase 3B E1: the accounting event this journal was posted for. */
  accountingEventId?: string | null;
}

interface BaseLine {
  lineNumber: number;
  baseDebit: string | null;
  baseCredit: string | null;
  roundingAdjustment: string;
}

/**
 * Journal engine: manual journals, the DRAFT -> PENDING_APPROVAL -> POSTED -> REVERSED
 * lifecycle, the atomic posting engine, reversals and the accounting-event foundation.
 */
export class JournalService {
  private readonly eventHandlers = new Map<
    string,
    { handler: AccountingEventHandler; options: EventHandlerOptions }
  >();

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
      // S10-03: the base-currency total the journal posts, and its transaction type.
      conditions: { amount: true, transactionTypes: JOURNAL_TRANSACTION_TYPES },
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
    existingAssignments: ReadonlySet<string> = new Set(),
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
      } else if (line.accountId && facts.get(line.accountId)!.isControlAccount) {
        issues.push({ path: `lines.${i}.accountId`, message: CONTROL_ACCOUNT_MESSAGE });
      }
    });
    issues.push(
      ...(await this.assignmentIssues(tx, organizationId, input.lines, existingAssignments)),
    );
    if (issues.length) throw new ValidationError(issues);
  }

  /**
   * Line dimension assignments (Decision 16): at most one value per type per line, values of the
   * organization that belong to the stated type, and only active types and values for new
   * assignments. `existing` holds type:value pairs the journal already carried, which stay
   * valid after a value is archived. Nothing is ever assigned automatically.
   */
  private async assignmentIssues(
    tx: Transaction,
    organizationId: string,
    lines: readonly { dimensions?: readonly DimensionAssignmentInput[] | undefined }[],
    existing: ReadonlySet<string>,
  ): Promise<RuleIssue[]> {
    const issues: RuleIssue[] = [];
    const values = await getDimensionValuesByIds(
      tx,
      organizationId,
      lines.flatMap((l) => (l.dimensions ?? []).map((d) => d.dimensionValueId)),
    );
    lines.forEach((line, i) => {
      const seen = new Set<string>();
      for (const d of line.dimensions ?? []) {
        const path = `lines.${i}.dimensions`;
        if (seen.has(d.dimensionTypeId)) {
          issues.push({ path, message: 'A line can have only one value per dimension type.' });
          continue;
        }
        seen.add(d.dimensionTypeId);
        const value = values.get(d.dimensionValueId);
        if (!value || value.dimensionTypeId !== d.dimensionTypeId) {
          issues.push({ path, message: 'Unknown dimension value for this dimension type.' });
        } else if (
          (value.status !== 'ACTIVE' || value.typeStatus !== 'ACTIVE') &&
          !existing.has(pairKey(d))
        ) {
          issues.push({ path, message: `${value.name} is archived and cannot be assigned.` });
        }
      }
    });
    return issues;
  }

  createJournal(principal: Principal, input: JournalInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsCreate },
      async (tx, ctx) => {
        const journal = await this.createJournalInTransaction(tx, ctx, input, origin);
        return this.load(tx, ctx, journal.id);
      },
    );
  }

  /**
   * S6 (L-7): runs every draft rule without writing anything, for import validation. Throws the
   * same ValidationError / PermissionDeniedError the create path would.
   */
  async validateDraftInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: JournalInput,
  ) {
    requirePermission(ctx, AccountingPermissions.JournalsCreate);
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    assertMayAssignDimensions(ctx, input.lines, new Set());
    await this.validateDraft(tx, ctx.organizationId, settings, input);
  }

  /**
   * S6 (L-7, L-8): creates a manual DRAFT inside the caller's transaction with exactly the rules
   * and audit of the HTTP path. An import passes its batch as the source reference (Decision
   * 12); the journal stays a manual journal under manual-journal rules and is never submitted,
   * approved or posted here.
   */
  async createJournalInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: JournalInput,
    origin: EventOrigin,
    options: { sourceRef?: SourceRef } = {},
  ) {
    requirePermission(ctx, AccountingPermissions.JournalsCreate);
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    assertMayAssignDimensions(ctx, input.lines, new Set());
    await this.validateDraft(tx, ctx.organizationId, settings, input);
    const journal = await createDraftJournal(tx, {
      ...input,
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      source: 'manual',
      sourceRef: options.sourceRef ?? null,
    });
    await this.audit(tx, ctx, 'journal.created', journal.id, this.now, origin, {
      currency: input.currency,
      entryDate: input.entryDate,
      lines: input.lines.length,
      totalDebit: sumSide(input.lines, 'debit').toFixed(),
      totalCredit: sumSide(input.lines, 'credit').toFixed(),
      dimensionAssignments: countAssignments(input.lines),
      ...(options.sourceRef
        ? {
            sourceModule: options.sourceRef.module,
            sourceType: options.sourceRef.type,
            sourceId: options.sourceRef.id,
          }
        : {}),
    });
    return journal;
  }

  /**
   * L-9: discards a never-submitted manual draft that an import created. The journal is kept
   * (DISCARDED is terminal and immutable); nothing is ever deleted. The database guard enforces
   * the same conditions.
   */
  discardImportedDraft(principal: Principal, journalId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: AccountingPermissions.JournalsEditDraft },
      async (tx, ctx) => {
        await this.discardImportedDraftInTransaction(tx, ctx, journalId, origin);
        return this.load(tx, ctx, journalId);
      },
    );
  }

  /** Returns false (without changing anything) when the journal is no longer discardable. */
  async discardImportedDraftInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    journalId: string,
    origin: EventOrigin,
    options: { quiet?: boolean } = {},
  ): Promise<boolean> {
    requirePermission(ctx, AccountingPermissions.JournalsEditDraft);
    const journal = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
    if (!journal) throw new NotFoundError('Journal not found.');
    const eligible =
      journal.status === 'DRAFT' &&
      journal.submittedAt === null &&
      journal.source === 'manual' &&
      journal.sourceModule === 'data_exchange' &&
      journal.sourceType === 'import_batch';
    if (!eligible) {
      if (options.quiet) return false;
      throw invalidState('Only imported drafts that were never submitted can be discarded.');
    }
    const now = this.now;
    await transitionJournal(tx, {
      organizationId: ctx.organizationId,
      journalId,
      from: 'DRAFT',
      set: {
        status: 'DISCARDED',
        discardedAt: now,
        discardedByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      },
    });
    await this.audit(tx, ctx, 'journal.discarded', journalId, now, origin, {
      sourceId: journal.sourceId,
    });
    return true;
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
        const currentDimensions = await getLineDimensions(
          tx,
          ctx.organizationId,
          currentLines.map((l) => l.id),
        );
        const dimensionsOf = (lineId: string) =>
          currentDimensions
            .filter((d) => d.journalLineId === lineId)
            .map((d) => ({
              dimensionTypeId: d.dimensionTypeId,
              dimensionValueId: d.dimensionValueId,
            }));
        const next: JournalInput = {
          entryDate: patch.entryDate === undefined ? journal.entryDate : patch.entryDate,
          description: patch.description ?? journal.description,
          reference: patch.reference ?? journal.reference,
          currency: patch.currency ?? journal.currency,
          exchangeRate:
            patch.exchangeRate === undefined ? journal.exchangeRate : patch.exchangeRate,
          lines:
            patch.lines?.map((l, i) => ({
              ...l,
              dimensions: l.dimensions ?? (currentLines[i] ? dimensionsOf(currentLines[i].id) : []),
            })) ??
            currentLines.map((l) => ({
              accountId: l.accountId,
              description: l.description,
              debit: l.debit,
              credit: l.credit,
              dimensions: dimensionsOf(l.id),
            })),
        };
        const existingPairs = new Set(currentDimensions.map(pairKey));
        assertMayAssignDimensions(ctx, next.lines, existingPairs);
        await this.validateDraft(tx, ctx.organizationId, settings, next, existingPairs);
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
            dimensionAssignments: currentDimensions.length,
          },
          after: {
            entryDate: next.entryDate,
            currency: next.currency,
            lines: next.lines.length,
            totalDebit: sumSide(next.lines, 'debit').toFixed(),
            dimensionAssignments: countAssignments(next.lines),
          },
        });
        return this.load(tx, ctx, journalId);
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
        const view = await this.load(tx, ctx, journalId);
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
        // S10-06: whether posting needs approval depends on this journal's own facts.
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const row = await getJournal(tx, ctx.organizationId, journalId);
        const approvalFacts = await this.journalApprovalFacts(
          tx,
          ctx.organizationId,
          settings,
          row!,
        );
        const requirement = await this.approvals.requirementFor(
          tx,
          ctx.organizationId,
          JOURNAL_POST_ACTION,
          approvalFacts,
        );
        return {
          ...view,
          approval,
          approvalRequiredForPosting: requirement.required,
          approvalFacts,
          approvalSteps: requirement.steps.map((step) => ({
            order: step.order,
            name: step.name,
            requiredApprovals: step.requiredApprovals,
            conditions: step.conditions ?? null,
          })),
          reversedByJournalId: links.reversedBy?.reversalJournalId ?? null,
          reversesJournalId: links.reverses?.originalJournalId ?? null,
          reversalReason: links.reversedBy?.reason ?? links.reverses?.reason ?? null,
        };
      },
    );
  }

  /** Journal with lines; dimension details only for viewers with dimensions.view (Decision 91). */
  private async load(tx: Transaction, ctx: AuthorizationContext, journalId: string) {
    const organizationId = ctx.organizationId;
    const journal = await getJournal(tx, organizationId, journalId);
    if (!journal) throw new NotFoundError('Journal not found.');
    const lines = await getJournalLines(tx, organizationId, [journalId]);
    const dimensions = hasPermission(ctx, AccountingPermissions.DimensionsView)
      ? await getLineDimensions(
          tx,
          organizationId,
          lines.map((l) => l.id),
        )
      : undefined;
    return journalView(journal, lines, dimensions);
  }

  // ---------------------------------------------------------------------------
  // Validation shared by submission and posting
  // ---------------------------------------------------------------------------

  /**
   * S10-03: the approval facts of a journal, derived on the server. The amount is the base-currency
   * total the journal posts: its lines converted at the journal's rate exactly as posting converts
   * them (Decision 56). When the journal cannot be validated yet, the amount is unknown and
   * amount conditions fail closed (S10-05).
   */
  private async journalApprovalFacts(
    tx: Transaction,
    organizationId: string,
    settings: AccountingSettings,
    journal: JournalEntry,
    checked?: { lines: PostableLine[]; rate: Money },
  ): Promise<ApprovalFacts> {
    let validated = checked;
    if (!validated) {
      try {
        validated = await this.validateForPosting(tx, organizationId, settings, journal, {
          lockPeriod: false,
        });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }
    let baseAmount: string | null = null;
    if (validated) {
      const conversion = convertJournalToBase(
        validated.lines,
        validated.rate,
        settings.baseCurrency,
      );
      baseAmount = conversion.lines
        .filter((l) => l.side === 'debit')
        .reduce((sum, l) => sum.plus(l.baseAmount), decimal(0))
        .toFixed();
    }
    return {
      transactionType: journalTransactionType(journal),
      baseAmount,
      baseCurrency: settings.baseCurrency,
    };
  }

  /** S10-06: whether a journal without an approved request may not be posted directly. */
  private async approvalRequiredToPost(
    tx: Transaction,
    organizationId: string,
    settings: AccountingSettings,
    journal: JournalEntry,
  ): Promise<boolean> {
    const facts = await this.journalApprovalFacts(tx, organizationId, settings, journal);
    const requirement = await this.approvals.requirementFor(
      tx,
      organizationId,
      JOURNAL_POST_ACTION,
      facts,
    );
    return requirement.required;
  }

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
    if (lines.some((l) => l.lineKind !== 'normal')) {
      // Base-only lines exist only on system journals, which post through postSystemJournal.
      throw invalidJournal([
        {
          path: 'lines',
          message: 'Base-only lines are restricted to FX and revaluation journals.',
        },
      ]);
    }
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
      { baseCurrency: settings.baseCurrency, manual: journal.source === 'manual' },
    );
    if (!validation.ok) throw invalidJournal(validation.issues);
    if (journal.source === 'manual') {
      // Decisions 78, 84, 86: checked at submission and again at posting (authoritative). A
      // requirement added after submission blocks posting; nothing is assigned automatically.
      const assigned = await getLineDimensions(
        tx,
        organizationId,
        lines.map((l) => l.id),
      );
      const missing = missingRequiredDimensions(
        lines.map((l, index) => ({
          index,
          accountId: l.accountId,
          dimensionTypeIds: new Set(
            assigned.filter((d) => d.journalLineId === l.id).map((d) => d.dimensionTypeId),
          ),
        })),
        new Map(
          [...facts].map(([id, f]) => [
            id,
            { accountType: f.accountType!, subtype: f.subtype ?? null },
          ]),
        ),
        await listDimensionTypes(tx, organizationId),
      );
      if (missing.length) {
        throw new ValidationError(missing, 'Required dimensions are missing.');
      }
    }

    const period = await this.openPeriodFor(tx, organizationId, journal.entryDate!, options);
    const { rate, rateSource } = await this.resolveRate(tx, organizationId, settings, journal);
    return { lines: validation.lines, total: validation.total, period, rate, rateSource };
  }

  private async openPeriodFor(
    tx: Transaction,
    organizationId: string,
    entryDate: string,
    options: { lockPeriod: boolean },
  ): Promise<Period> {
    const period = await findPeriodForDate(
      tx,
      organizationId,
      entryDate,
      options.lockPeriod ? 'share' : undefined,
    );
    if (!period) {
      throw new AppError('PERIOD_NOT_FOUND', 409, 'No accounting period covers the journal date.');
    }
    if (period.status !== 'OPEN') {
      throw new AppError('PERIOD_CLOSED', 409, `The accounting period ${period.name} is closed.`);
    }
    return period;
  }

  /** One currency and one rate per journal: 1 for the base currency, a stored rate, or the table. */
  private async resolveRate(
    tx: Transaction,
    organizationId: string,
    settings: AccountingSettings,
    journal: Pick<JournalEntry, 'currency' | 'exchangeRate' | 'exchangeRateSource' | 'entryDate'>,
  ): Promise<{ rate: Money; rateSource: 'base' | 'manual' | 'table' }> {
    if (journal.currency === settings.baseCurrency) {
      return { rate: decimal(1), rateSource: 'base' };
    }
    if (journal.exchangeRate !== null) {
      return {
        rate: decimal(journal.exchangeRate),
        rateSource: journal.exchangeRateSource === 'table' ? 'table' : 'manual',
      };
    }
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
    return { rate: decimal(found.rate), rateSource: 'table' };
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
          // S10: the matching steps are chosen from the facts of the journal as submitted.
          facts: await this.journalApprovalFacts(
            tx,
            ctx.organizationId,
            settings,
            journal,
            checked,
          ),
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
        return this.load(tx, ctx, journalId);
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
          ...(await this.load(tx, ctx, journalId)),
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
        return this.load(tx, ctx, journalId);
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
      /** Journals of events whose module owns the approval (Decision 13) post directly. */
      domainApproved?: boolean;
    } = {},
  ): Promise<JournalEntry> {
    const settings = await requireAccountingSettings(tx, actor.organizationId);

    if (journal.status === 'DRAFT' && options.reversal) {
      if (journal.source !== 'reversal')
        throw invalidState('Only reversal journals bypass approval.');
    } else if (journal.status === 'DRAFT' && options.domainApproved) {
      if (journal.source !== 'event')
        throw invalidState('Only event journals are domain-approved.');
    } else if (journal.status === 'DRAFT') {
      // S10-06: re-checked here, in the posting transaction, against this journal's facts.
      if (await this.approvalRequiredToPost(tx, actor.organizationId, settings, journal)) {
        throw new ApprovalRequiredError(
          "This journal needs approval under the organization's policy: submit it first.",
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
      } else if (await this.approvalRequiredToPost(tx, actor.organizationId, settings, journal)) {
        // Submitted when no step applied; a policy that applies now still governs posting.
        throw new ApprovalRequiredError(
          'An approval policy now applies to this journal: withdraw it and submit it again.',
        );
      }
    } else {
      throw invalidState(`A ${journal.status} journal cannot be posted.`);
    }

    const checked = await this.validateForPosting(tx, actor.organizationId, settings, journal, {
      lockPeriod: true,
      reversal: options.reversal === true,
    });
    let baseLines: BaseLine[];
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
    return this.commitPosting(tx, actor, journal, origin, settings, {
      period: checked.period,
      rate: checked.rate,
      rateSource: checked.rateSource,
      total: checked.total,
      baseLines,
    });
  }

  /**
   * Final step shared by every posting: base balance, base amounts, numbering, the POSTED
   * transition (re-checked by the database guard), audit and outbox.
   */
  private async commitPosting(
    tx: Transaction,
    actor: Actor,
    journal: JournalEntry,
    origin: EventOrigin,
    settings: AccountingSettings,
    checked: {
      period: Period;
      rate: Money;
      rateSource: 'base' | 'manual' | 'table';
      total: Money;
      baseLines: BaseLine[];
    },
  ): Promise<JournalEntry> {
    const { baseLines } = checked;
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
      ...(journal.sourceId
        ? {
            sourceModule: journal.sourceModule,
            sourceType: journal.sourceType,
            sourceId: journal.sourceId,
          }
        : {}),
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
        return this.load(tx, ctx, journalId);
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
      (tx, ctx) => this.reverseJournalInTransaction(tx, ctx, journalId, input, origin),
    );
  }

  /**
   * Reversal inside the caller's transaction (L-7 precedent). The caller has authorized the
   * action. Opening-balance journals are reversed only with their whole batch (S8-14): the
   * opening-balance service passes `openingBatch`; generic reversal refuses them.
   */
  async reverseJournalInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    journalId: string,
    input: { reason: string; reversalDate?: string | undefined },
    origin: EventOrigin,
    options: { openingBatch?: boolean; sales?: boolean } = {},
  ) {
    await requireAccountingSettings(tx, ctx.organizationId);
    const original = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
    if (!original) throw new NotFoundError('Journal not found.');
    if (original.status !== 'POSTED')
      throw invalidState(`A ${original.status} journal cannot be reversed.`);
    // Phase 3B E2: Sales journals, and reversals of them, change only through Sales (void), so
    // the AR subledger and the GL never drift apart.
    if (!options.sales && (await this.isSalesJournal(tx, ctx.organizationId, original))) {
      throw new ConflictError(
        'SYSTEM_JOURNAL',
        'Sales journals are reversed from their invoice or receipt in Sales (void), not manually.',
      );
    }
    if (
      original.source === 'system' &&
      original.sourceType === OPENING_SOURCE.type &&
      !options.openingBatch &&
      // Phase 3B D5: Sales opening invoices are reversed by their invoice void (E2).
      !(options.sales && original.sourceModule === SALES_SOURCE_MODULE)
    ) {
      throw new ConflictError(
        'SYSTEM_JOURNAL',
        'Opening balance journals are reversed with their whole opening batch under Accounting > Opening balances.',
      );
    }
    if (input.reversalDate !== undefined && !isValidIsoDate(input.reversalDate)) {
      throw new ValidationError([
        { path: 'reversalDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    const reversalDate = input.reversalDate ?? original.entryDate!;
    const period = await findPeriodForDate(tx, ctx.organizationId, reversalDate);
    if (!period) {
      throw new AppError('PERIOD_NOT_FOUND', 409, 'No accounting period covers the reversal date.');
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
    const originalDimensions = await getLineDimensions(
      tx,
      ctx.organizationId,
      originalLines.map((l) => l.id),
    );
    if (isFxSystemJournal(original) || originalLines.some((l) => l.lineKind !== 'normal')) {
      // Decision 80: system FX/revaluation journals (by type) and any journal with base-only
      // lines are corrected through their FX/revaluation process, not generic reversal.
      throw new ConflictError(
        'SYSTEM_JOURNAL',
        'FX and revaluation journals are reversed by their originating process, not manually.',
      );
    }
    const reversal = await createDraftJournal(tx, {
      organizationId: ctx.organizationId,
      entryDate: reversalDate,
      description: `Reversal of journal ${original.journalNumber}: ${input.reason.trim()}`.slice(
        0,
        1000,
      ),
      reference: original.reference,
      currency: original.currency,
      exchangeRate: original.exchangeRate,
      exchangeRateSource: original.exchangeRateSource,
      // The reversal mirrors the original line by line, including its dimensions, so tagged
      // activity nets to zero.
      lines: originalLines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debit: l.credit,
        credit: l.debit,
        dimensions: originalDimensions
          .filter((d) => d.journalLineId === l.id)
          .map((d) => ({
            dimensionTypeId: d.dimensionTypeId,
            dimensionValueId: d.dimensionValueId,
          })),
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
      reversal: await this.load(tx, ctx, reversal.id),
    };
  }

  /** Dimension assignment checks shared with other accounting processes (S8-09). */
  dimensionAssignmentIssues(
    tx: Transaction,
    organizationId: string,
    lines: readonly { dimensions?: readonly DimensionAssignmentInput[] | undefined }[],
  ): Promise<RuleIssue[]> {
    return this.assignmentIssues(tx, organizationId, lines, new Set());
  }

  // ---------------------------------------------------------------------------
  // Accounting events (foundation for future operational modules)
  // ---------------------------------------------------------------------------

  /** Registers how an accounting event type becomes a journal (none in Phase 2). */
  registerEventHandler(
    eventType: string,
    handler: AccountingEventHandler,
    options: EventHandlerOptions = {},
  ): void {
    this.eventHandlers.set(eventType, { handler, options });
  }

  /**
   * Receives an accounting event idempotently in its own transaction (Phase 2 behaviour).
   * Replays of the same event never create a second journal. A registered handler turns the
   * event into a journal that is posted through the same engine (or left for the approval
   * workflow when the organization requires it). A handler failure is recorded on the event.
   */
  receiveEvent(input: EventIntakeInput) {
    return inTransaction(this.deps.db, { organizationId: input.organizationId }, async (tx) => {
      await setDbContext(tx, { organizationId: input.organizationId });
      return this.intake(tx, input, { recordFailures: true });
    });
  }

  /**
   * Transaction-aware intake (C1): the event, its journal and the caller's own writes commit or
   * roll back together. The caller owns the transaction and its tenant context. Failures are
   * thrown so the whole unit of work rolls back.
   */
  receiveEventInTransaction(tx: Transaction, input: EventIntakeInput) {
    return this.intake(tx, input, { recordFailures: false });
  }

  private async intake(
    tx: Transaction,
    input: EventIntakeInput,
    options: { recordFailures: boolean },
  ) {
    const now = this.now;
    const settings = await requireAccountingSettings(tx, input.organizationId);
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
    const registration = this.eventHandlers.get(input.eventType);
    if (!registration) {
      return {
        outcome: 'received' as const,
        eventId: received.event.id,
        journalId: null,
        status: 'received' as const,
      };
    }
    const actor: Actor = { organizationId: input.organizationId, userId: null };
    const createAndPost = async (unit: Transaction) => {
      const journalInput = registration.handler({
        eventType: input.eventType,
        payload: input.payload,
      });
      if (!journalInput) return null;
      if ('system' in journalInput) {
        const posted = await this.postSystemJournal(
          unit,
          {
            ...journalInput.system,
            organizationId: input.organizationId,
            userId: null,
            accountingEventId: received.event.id,
          },
          input.origin,
        );
        return posted.id;
      }
      const { sourceRef, ...fields } = journalInput;
      const dimensionIssues = await this.assignmentIssues(
        unit,
        input.organizationId,
        fields.lines,
        new Set(),
      );
      if (dimensionIssues.length) throw new ValidationError(dimensionIssues);
      const journal = await createDraftJournal(unit, {
        ...fields,
        organizationId: input.organizationId,
        userId: null,
        source: 'event',
        sourceRef: sourceRef ?? null,
        accountingEventId: received.event.id,
      });
      const domainApproved = registration.options.domainApproval === true;
      if (
        !domainApproved &&
        (await this.approvalRequiredToPost(unit, input.organizationId, settings, journal))
      ) {
        // Approval is required: the event journal waits as a draft for the normal workflow.
        return journal.id;
      }
      await this.postInTransaction(unit, actor, journal, input.origin, { domainApproved });
      return journal.id;
    };
    const complete = async (journalId: string | null, error: unknown) => {
      await completeAccountingEvent(tx, {
        organizationId: input.organizationId,
        eventId: received.event.id,
        status: error === undefined ? 'processed' : 'failed',
        journalId,
        error:
          error === undefined
            ? null
            : error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        now,
      });
    };

    if (!options.recordFailures) {
      const journalId = await createAndPost(tx);
      await complete(journalId, undefined);
      return {
        outcome: 'processed' as const,
        eventId: received.event.id,
        journalId,
        status: 'processed' as const,
      };
    }
    try {
      const journalId = await tx.transaction(createAndPost);
      await complete(journalId, undefined);
      return {
        outcome: 'processed' as const,
        eventId: received.event.id,
        journalId,
        status: 'processed' as const,
      };
    } catch (error) {
      await complete(null, error);
      return {
        outcome: 'failed' as const,
        eventId: received.event.id,
        journalId: null,
        status: 'failed' as const,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // System journals (Decision 10)
  // ---------------------------------------------------------------------------

  /**
   * Posts a system journal inside the caller's transaction (tenant context already set). Only
   * approved source types are accepted; the FX/revaluation types may carry base-only lines, and
   * every system journal may carry explicit per-line base amounts. It posts directly: the
   * originating process owns any approval.
   */
  async postSystemJournal(
    tx: Transaction,
    input: SystemJournalInput,
    origin: EventOrigin,
  ): Promise<JournalEntry> {
    const settings = await requireAccountingSettings(tx, input.organizationId);
    const issues: RuleIssue[] = [];
    if (!isValidIsoDate(input.entryDate)) {
      issues.push({ path: 'entryDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    if (input.exchangeRate !== null && !parseRate(input.exchangeRate).ok) {
      issues.push({
        path: 'exchangeRate',
        message: 'Rates are positive decimal strings with at most 10 decimals.',
      });
    }
    if (input.lines.length > MAX_JOURNAL_LINES) {
      issues.push({
        path: 'lines',
        message: `A journal can have at most ${MAX_JOURNAL_LINES} lines.`,
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const facts = await getAccountFacts(
      tx,
      input.organizationId,
      input.lines.map((l) => l.accountId),
    );
    const validation = validateSystemJournal(
      {
        sourceType: input.source.type,
        sourceModule: input.source.module,
        currency: input.currency,
        baseCurrency: settings.baseCurrency,
        lines: input.lines,
      },
      facts,
    );
    if (!validation.ok) throw invalidJournal(validation.issues);
    const dimensionIssues = await this.assignmentIssues(
      tx,
      input.organizationId,
      input.lines,
      new Set(),
    );
    if (dimensionIssues.length) throw new ValidationError(dimensionIssues);

    const period = await this.openPeriodFor(tx, input.organizationId, input.entryDate, {
      lockPeriod: true,
    });
    const journal = await createDraftJournal(tx, {
      organizationId: input.organizationId,
      entryDate: input.entryDate,
      description: input.description,
      reference: input.reference,
      currency: input.currency,
      exchangeRate: input.currency === settings.baseCurrency ? null : input.exchangeRate,
      ...(input.exchangeRateSource ? { exchangeRateSource: input.exchangeRateSource } : {}),
      lines: input.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        kind: l.kind,
        debit: l.debit,
        credit: l.credit,
        dimensions: l.dimensions ?? [],
      })),
      userId: input.userId,
      source: 'system',
      sourceRef: input.source,
      accountingEventId: input.accountingEventId ?? null,
    });
    const { rate, rateSource } = await this.resolveRate(
      tx,
      input.organizationId,
      settings,
      journal,
    );

    // Normal lines use their explicit base amounts, or are converted at the journal rate with
    // the approved rounding rule; base-only lines always carry their explicit base amount.
    const baseByLine = new Map<number, { amount: Money; rounding: Money }>();
    const normal = validation.lines.filter((l) => l.kind === 'normal');
    if (!validation.explicitBase && normal.length > 0) {
      const conversion = convertJournalToBase(
        normal.map((l) => ({
          lineNumber: l.lineNumber,
          accountId: l.accountId,
          side: l.side,
          amount: l.amount!,
        })),
        rate,
        settings.baseCurrency,
      );
      for (const l of conversion.lines) {
        baseByLine.set(l.lineNumber, { amount: l.baseAmount, rounding: l.roundingAdjustment });
      }
    }
    const baseLines: BaseLine[] = validation.lines.map((l) => {
      const base = baseByLine.get(l.lineNumber) ?? { amount: l.baseAmount!, rounding: decimal(0) };
      return {
        lineNumber: l.lineNumber,
        baseDebit: l.side === 'debit' ? fixedAmount(base.amount) : null,
        baseCredit: l.side === 'credit' ? fixedAmount(base.amount) : null,
        roundingAdjustment: fixedAmount(base.rounding),
      };
    });
    return this.commitPosting(
      tx,
      { organizationId: input.organizationId, userId: input.userId },
      journal,
      origin,
      settings,
      { period, rate, rateSource, total: validation.total, baseLines },
    );
  }

  /** A journal Sales posted, or the reversal of one (Phase 3B E2). */
  private async isSalesJournal(
    tx: Transaction,
    organizationId: string,
    journal: JournalEntry,
  ): Promise<boolean> {
    if (journal.sourceModule === SALES_SOURCE_MODULE) return true;
    if (journal.source !== 'reversal') return false;
    const { reverses } = await getReversalLinks(tx, organizationId, journal.id);
    if (!reverses) return false;
    const original = await getJournal(tx, organizationId, reverses.originalJournalId);
    return original?.sourceModule === SALES_SOURCE_MODULE;
  }

  /**
   * Phase 3B E2: Sales reverses its own journals (invoice and receipt voids) inside its own
   * transaction. Event journals use the generic reversal engine; Sales realized-FX system journals
   * (Decision 80: never reversed generically) are mirrored line by line as a `realized_fx` system
   * journal, like the S9 cancellation. The original becomes REVERSED either way.
   */
  async reverseSalesJournalInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    journalId: string,
    input: { reason: string; reversalDate?: string | undefined },
    origin: EventOrigin,
  ) {
    const original = await getJournal(tx, ctx.organizationId, journalId, { forUpdate: true });
    if (!original) throw new NotFoundError('Journal not found.');
    if (original.sourceModule !== SALES_SOURCE_MODULE) {
      throw new ConflictError('SYSTEM_JOURNAL', 'Only Sales journals are reversed here.');
    }
    if (!isFxSystemJournal(original)) {
      const result = await this.reverseJournalInTransaction(tx, ctx, journalId, input, origin, {
        sales: true,
      });
      return { id: result.reversal.id, number: result.reversal.number };
    }
    if (original.status !== 'POSTED') {
      throw invalidState(`A ${original.status} journal cannot be reversed.`);
    }
    const lines = await getJournalLines(tx, ctx.organizationId, [journalId]);
    const reversal = await this.postSystemJournal(
      tx,
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        source: {
          module: SALES_SOURCE_MODULE,
          type: original.sourceType!,
          id: original.sourceId!,
        },
        entryDate: input.reversalDate ?? original.entryDate!,
        description: `Reversal of journal ${original.journalNumber}: ${input.reason.trim()}`.slice(
          0,
          1000,
        ),
        reference: original.reference,
        currency: original.currency,
        exchangeRate: original.exchangeRate,
        exchangeRateSource: original.exchangeRateSource === 'table' ? 'table' : 'manual',
        lines: mirrorJournalLines(
          lines.map((l) => ({
            accountId: l.accountId!,
            description: l.description,
            kind: l.lineKind,
            debit: l.debit,
            credit: l.credit,
            baseDebit: l.baseDebit,
            baseCredit: l.baseCredit,
          })),
        ),
      },
      origin,
    );
    const now = this.now;
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
      reversalNumber: reversal.journalNumber,
      reversalDate: reversal.entryDate,
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
    return { id: reversal.id, number: reversal.journalNumber };
  }

  /**
   * S9: the dedicated reversal path for revaluation journals, which generic reversal refuses
   * (Decision 80). Posts a `revaluation_reversal` system journal that mirrors the original line by
   * line (same currency, rate and base amounts) through `postSystemJournal`, so the previous base
   * carrying amounts are restored. The caller has authorized the action.
   *
   * - `scheduled`: the next-day reversal of a revaluation; the original stays POSTED and the
   *   caller links both journals to the run.
   * - `cancellation`: a correction; the original becomes REVERSED and the pair is recorded in the
   *   reversal links, as with any reversal.
   */
  async reverseRevaluationJournalInTransaction(
    tx: Transaction,
    actor: Actor,
    journalId: string,
    input: { entryDate: string; mode: 'scheduled' | 'cancellation'; reason: string },
    origin: EventOrigin,
  ): Promise<JournalEntry> {
    const original = await getJournal(tx, actor.organizationId, journalId, { forUpdate: true });
    if (!original) throw new NotFoundError('Journal not found.');
    if (
      original.source !== 'system' ||
      original.sourceModule !== REVALUATION_SOURCE.module ||
      (original.sourceType !== REVALUATION_SOURCE.type &&
        original.sourceType !== REVALUATION_REVERSAL_TYPE) ||
      original.sourceId === null
    ) {
      throw new ConflictError('SYSTEM_JOURNAL', 'Only revaluation journals are reversed here.');
    }
    if (original.status !== 'POSTED') {
      throw invalidState(`A ${original.status} journal cannot be reversed.`);
    }
    const lines = await getJournalLines(tx, actor.organizationId, [journalId]);
    const reversal = await this.postSystemJournal(
      tx,
      {
        organizationId: actor.organizationId,
        userId: actor.userId,
        source: {
          module: REVALUATION_SOURCE.module,
          type: REVALUATION_REVERSAL_TYPE,
          id: original.sourceId,
        },
        entryDate: input.entryDate,
        description: `Reversal of journal ${original.journalNumber}: ${input.reason.trim()}`.slice(
          0,
          1000,
        ),
        reference: original.reference,
        currency: original.currency,
        exchangeRate: original.exchangeRate,
        exchangeRateSource: original.exchangeRateSource === 'table' ? 'table' : 'manual',
        lines: mirrorJournalLines(
          lines.map((l) => ({
            accountId: l.accountId!,
            description: l.description,
            kind: l.lineKind,
            debit: l.debit,
            credit: l.credit,
            baseDebit: l.baseDebit,
            baseCredit: l.baseCredit,
          })),
        ),
      },
      origin,
    );
    if (input.mode === 'cancellation') {
      const now = this.now;
      await recordReversal(tx, {
        organizationId: actor.organizationId,
        originalJournalId: journalId,
        reversalJournalId: reversal.id,
        reason: input.reason,
        userId: actor.userId!,
        now,
      });
      const reversed = await transitionJournal(tx, {
        organizationId: actor.organizationId,
        journalId,
        from: 'POSTED',
        set: { status: 'REVERSED', reversedAt: now, reversedByUserId: actor.userId },
      });
      if (!reversed) throw invalidState('The journal changed while reversing; try again.');
      await this.audit(tx, actor, 'journal.reversed', journalId, now, origin, {
        originalNumber: original.journalNumber,
        reversalJournalId: reversal.id,
        reversalNumber: reversal.journalNumber,
        reversalDate: input.entryDate,
        reason: input.reason.trim(),
      });
      await enqueueOutboxEvent(
        tx,
        {
          eventType: 'accounting.journal_reversed',
          aggregateType: 'accounting_journal',
          aggregateId: journalId,
          organizationId: actor.organizationId,
          payload: { journalId, reversalJournalId: reversal.id },
        },
        now,
      );
    }
    return reversal;
  }
}
