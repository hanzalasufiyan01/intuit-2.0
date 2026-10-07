import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal, minorUnits } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { designationsOfAccount, getAccount, isValidIsoDate } from '../modules/accounting/index.js';
import { getApprovalRequest } from '../modules/approvals/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  claimNumberExists,
  deleteClaim,
  ExpenseClaimPermissions,
  getClaim,
  getClaimLines,
  getClaimSettings,
  insertClaim,
  listClaims,
  replaceClaimLines,
  saveClaimSettings,
  takeNextClaimNumber,
  updateClaim,
  type ClaimStatus,
  type ExpenseClaim,
  type ExpenseClaimLine,
} from '../modules/expense-claims/index.js';
import { listLinkedFiles } from '../modules/files/index.js';
import { getParty, getPartyDetail, partyIdsMatching } from '../modules/parties/index.js';
import { getBill, getPurchasesSettings } from '../modules/purchases/index.js';
import { getVendorByParty, purchaseAccountProblem } from '../modules/vendors/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import type { ApprovalService } from './approval-service.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { BillService } from './bill-service.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { withOrganization } from './organization-service.js';
import { shownMoney } from './sales-documents.js';
import type { VendorService } from './vendor-service.js';

/**
 * Employee expense claims (approved 2026-10-07; ADR 0009).
 *
 * An employee is a Party with the `employee` role. A claim lists what they spent, with receipts
 * attached (and required above an amount when the organization says so). It follows DRAFT →
 * PENDING_APPROVAL → APPROVED → POSTED (or CANCELLED before posting, VOID after). Posting reuses the
 * AP engine: the claim becomes a posted bill from the employee as a vendor (Dr each expense account
 * / Cr the AP control account, subledgered by employee), so the reimbursement is an ordinary vendor
 * payment and appears in the AP aging. This service never writes the ledger.
 */

export const CLAIM_APPROVE_ACTION = 'expense_claims.approve';
const RESOURCE = 'expense_claim';
const SETTINGS_RESOURCE = 'expense_claim_settings';
const MAX_CLAIM_LINES = 100;

export interface ClaimDraftInput {
  employeePartyId: string;
  claimDate: string;
  memo?: string | undefined;
  lines: {
    expenseDate: string;
    description: string;
    accountId?: string | undefined;
    amount: string;
  }[];
}

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun = 'expense claim') =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

function encodeCursor(claim: ExpenseClaim) {
  return Buffer.from(JSON.stringify({ d: claim.claimDate, i: claim.id })).toString('base64url');
}

function decodeCursor(cursor: string): { date: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      d?: unknown;
      i?: unknown;
    };
    if (
      typeof parsed.d === 'string' &&
      isValidIsoDate(parsed.d) &&
      typeof parsed.i === 'string' &&
      /^[0-9a-f-]{36}$/i.test(parsed.i)
    ) {
      return { date: parsed.d, id: parsed.i };
    }
  } catch {
    // fall through
  }
  throw new ValidationError([{ path: 'after', message: 'Invalid cursor.' }]);
}

export class ExpenseClaimService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly approvals: ApprovalService,
    private readonly idempotency: IdempotencyService,
    private readonly bills: BillService,
    private readonly vendors: VendorService,
  ) {
    approvals.register({
      actionKey: CLAIM_APPROVE_ACTION,
      label: 'Approve expense claims',
      subjectType: RESOURCE,
      approverPermission: ExpenseClaimPermissions.Approve,
      decisionRequiresReauth: false,
      conditions: { amount: true, transactionTypes: ['expense_claim'] },
      onApproved: async (tx, { request, authz, now, origin }) => {
        const claim = await updateClaim(tx, {
          organizationId: authz.organizationId,
          id: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'APPROVED',
            approvedAt: now,
            updatedByUserId: authz.userId,
            updatedAt: now,
          },
        });
        if (!claim) throw invalidState('The expense claim is no longer awaiting approval.');
        await this.audit(tx, authz, 'expense_claim.approved', claim.id, now, origin, {
          approvalRequestId: request.id,
        });
      },
      onRejected: async (tx, { request, authz, comment, now, origin }) => {
        if (!comment?.trim()) {
          throw new ValidationError([
            { path: 'comment', message: 'Give a reason for rejecting the expense claim.' },
          ]);
        }
        const claim = await updateClaim(tx, {
          organizationId: authz.organizationId,
          id: request.subjectId,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: authz.userId,
            updatedAt: now,
          },
        });
        if (!claim) throw invalidState('The expense claim is no longer awaiting approval.');
        await this.audit(tx, authz, 'expense_claim.rejected', claim.id, now, origin, {
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
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    id: string,
    now: Date,
    origin: EventOrigin,
    metadata: Record<string, unknown>,
    resourceType = RESOURCE,
  ) {
    await recordAuditEvent(tx, {
      occurredAt: now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId: id,
      metadata,
      origin,
    });
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  getSettings(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const s = await getClaimSettings(tx, ctx.organizationId);
        return {
          defaultExpenseAccountId: s?.defaultExpenseAccountId ?? null,
          receiptRequiredOver: s?.receiptRequiredOver
            ? decimal(s.receiptRequiredOver).toFixed()
            : null,
          version: s?.version ?? 0,
        };
      },
    );
  }

  updateSettings(
    principal: Principal,
    input: {
      version: number;
      defaultExpenseAccountId: string | null;
      receiptRequiredOver: string | null;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.SettingsManage },
      async (tx, ctx) => {
        if (input.defaultExpenseAccountId) {
          const problem = await this.accountProblem(
            tx,
            ctx.organizationId,
            input.defaultExpenseAccountId,
          );
          if (problem) {
            throw new ValidationError([{ path: 'defaultExpenseAccountId', message: problem }]);
          }
        }
        const saved = await saveClaimSettings(tx, {
          organizationId: ctx.organizationId,
          version: input.version,
          defaultExpenseAccountId: input.defaultExpenseAccountId,
          receiptRequiredOver: input.receiptRequiredOver,
          userId: ctx.userId,
          at: this.now,
        });
        if (!saved) throw versionConflict('setting');
        await this.audit(
          tx,
          ctx,
          'expense_claim.settings_updated',
          ctx.organizationId,
          this.now,
          origin,
          {
            defaultExpenseAccountId: saved.defaultExpenseAccountId,
            receiptRequiredOver: saved.receiptRequiredOver,
          },
          SETTINGS_RESOURCE,
        );
        return {
          defaultExpenseAccountId: saved.defaultExpenseAccountId,
          receiptRequiredOver: saved.receiptRequiredOver
            ? decimal(saved.receiptRequiredOver).toFixed()
            : null,
          version: saved.version,
        };
      },
    );
  }

  private async accountProblem(tx: Transaction, organizationId: string, accountId: string) {
    const account = await getAccount(tx, organizationId, accountId);
    if (!account) return 'Account not found.';
    return purchaseAccountProblem({
      status: account.status,
      isLeaf: account.isLeaf,
      subtype: account.subtype,
      isControlAccount: account.isControlAccount,
      designated: (await designationsOfAccount(tx, organizationId, accountId)).length > 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  private async employeeName(tx: Transaction, organizationId: string, partyId: string) {
    return (await getParty(tx, organizationId, partyId))?.displayName ?? null;
  }

  private summary(claim: ExpenseClaim, name: string | null, currency: string) {
    return {
      id: claim.id,
      status: claim.status,
      number: claim.number,
      employeePartyId: claim.employeePartyId,
      employeeName: name,
      claimDate: claim.claimDate,
      currencyCode: currency,
      total: shownMoney(claim.total, currency),
      billId: claim.billId,
      version: claim.version,
      approvedAt: claim.approvedAt?.toISOString() ?? null,
      postedAt: claim.postedAt?.toISOString() ?? null,
    };
  }

  private lineView(l: ExpenseClaimLine, currency: string) {
    return {
      id: l.id,
      lineNo: l.lineNo,
      expenseDate: l.expenseDate,
      description: l.description,
      accountId: l.accountId,
      amount: shownMoney(l.amount, currency),
    };
  }

  private async detail(tx: Transaction, ctx: AuthorizationContext, id: string) {
    const claim = await getClaim(tx, ctx.organizationId, id);
    if (!claim) throw new NotFoundError('Expense claim not found.');
    const accounting = await requireAccountingSettings(tx, ctx.organizationId);
    const currency = accounting.baseCurrency;
    const lines = await getClaimLines(tx, ctx.organizationId, id);
    const bill = claim.billId ? await getBill(tx, ctx.organizationId, claim.billId) : undefined;
    const receipts = await listLinkedFiles(tx, ctx.organizationId, 'expense_claim', id);
    const request = claim.approvalRequestId
      ? await getApprovalRequest(tx, ctx.organizationId, claim.approvalRequestId)
      : undefined;
    return {
      ...this.summary(
        claim,
        await this.employeeName(tx, ctx.organizationId, claim.employeePartyId),
        currency,
      ),
      memo: claim.memo,
      cancelReason: claim.cancelReason,
      voidReason: claim.voidReason,
      createdByUserId: claim.createdByUserId,
      lines: lines.map((l) => this.lineView(l, currency)),
      receiptCount: receipts.length,
      bill: bill
        ? {
            id: bill.id,
            number: bill.number,
            status: bill.status,
            total: shownMoney(bill.total, bill.currencyCode),
            amountDue:
              bill.amountDue === null ? null : shownMoney(bill.amountDue, bill.currencyCode),
            reimbursed:
              bill.status === 'POSTED' &&
              bill.amountDue !== null &&
              decimal(bill.amountDue).isZero(),
          }
        : null,
      approval: request ? { requestId: request.id, requestStatus: request.status } : null,
    };
  }

  list(
    principal: Principal,
    query: {
      status?: ClaimStatus[] | undefined;
      employeePartyId?: string | undefined;
      search?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.View, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const search = query.search?.trim() || null;
        const page = await listClaims(tx, {
          organizationId: ctx.organizationId,
          statuses: query.status?.length ? query.status : null,
          employeePartyId: query.employeePartyId ?? null,
          search,
          employeeIdsIn: search ? partyIdsMatching(ctx.organizationId, search) : undefined,
          limit: query.limit,
          after: query.after ? decodeCursor(query.after) : null,
        });
        const names = new Map<string, string | null>();
        for (const id of new Set(page.items.map((c) => c.employeePartyId))) {
          names.set(id, await this.employeeName(tx, ctx.organizationId, id));
        }
        const last = page.items.at(-1);
        return {
          items: page.items.map((c) =>
            this.summary(c, names.get(c.employeePartyId) ?? null, accounting.baseCurrency),
          ),
          nextCursor: page.hasMore && last ? encodeCursor(last) : null,
        };
      },
    );
  }

  get(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.View, readOnlySnapshot: true },
      (tx, ctx) => this.detail(tx, ctx, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Drafts
  // ---------------------------------------------------------------------------

  /** Validates a draft and returns the stored line values. */
  private async resolve(tx: Transaction, organizationId: string, input: ClaimDraftInput) {
    const issues: ValidationIssue[] = [];
    const accounting = await requireAccountingSettings(tx, organizationId);
    const scale = minorUnits(accounting.baseCurrency);
    if (!isValidIsoDate(input.claimDate)) {
      issues.push({ path: 'claimDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    const employee = await getPartyDetail(tx, organizationId, input.employeePartyId);
    if (!employee || !employee.roles.includes('employee')) {
      issues.push({
        path: 'employeePartyId',
        message: 'Choose an employee (a contact with the employee role).',
      });
    } else if (employee.party.status !== 'ACTIVE') {
      issues.push({ path: 'employeePartyId', message: 'The employee is archived.' });
    }
    if (!input.lines.length || input.lines.length > MAX_CLAIM_LINES) {
      issues.push({ path: 'lines', message: `Add between 1 and ${MAX_CLAIM_LINES} lines.` });
    }
    const settings = await getClaimSettings(tx, organizationId);
    const purchases = await getPurchasesSettings(tx, organizationId);
    const checked = new Map<string, string | null>();
    const lines = [];
    for (const [i, line] of input.lines.entries()) {
      if (!isValidIsoDate(line.expenseDate)) {
        issues.push({
          path: `lines.${i}.expenseDate`,
          message: 'Enter a valid date (YYYY-MM-DD).',
        });
      } else if (isValidIsoDate(input.claimDate) && line.expenseDate > input.claimDate) {
        issues.push({
          path: `lines.${i}.expenseDate`,
          message: 'An expense cannot be after the claim date.',
        });
      }
      const amount = decimal(line.amount);
      if (!amount.gt(0) || amount.decimalPlaces() > scale) {
        issues.push({
          path: `lines.${i}.amount`,
          message: `Enter an amount above zero with at most ${scale} decimals.`,
        });
      }
      if (!line.description.trim()) {
        issues.push({ path: `lines.${i}.description`, message: 'Describe the expense.' });
      }
      const accountId =
        line.accountId ??
        settings?.defaultExpenseAccountId ??
        purchases?.defaultExpenseAccountId ??
        null;
      if (!accountId) {
        issues.push({
          path: `lines.${i}.accountId`,
          message:
            'Choose an account, or set a default expense account in the claim or Purchases settings.',
        });
      } else {
        if (!checked.has(accountId)) {
          checked.set(accountId, await this.accountProblem(tx, organizationId, accountId));
        }
        const problem = checked.get(accountId);
        if (problem) issues.push({ path: `lines.${i}.accountId`, message: problem });
      }
      lines.push({
        expenseDate: line.expenseDate,
        description: line.description.trim(),
        accountId: accountId!,
        amount: amount.toFixed(4),
      });
    }
    if (issues.length) throw new ValidationError(issues);
    const total = lines.reduce((sum, l) => sum.plus(l.amount), decimal(0));
    return { lines, total: total.toFixed(4) };
  }

  create(
    principal: Principal,
    input: ClaimDraftInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'expense_claims.create', request: input },
          async () => {
            const resolved = await this.resolve(tx, ctx.organizationId, input);
            const now = this.now;
            const claim = await insertClaim(tx, {
              organizationId: ctx.organizationId,
              employeePartyId: input.employeePartyId,
              claimDate: input.claimDate,
              memo: input.memo?.trim() ?? '',
              total: resolved.total,
              createdByUserId: ctx.userId,
              createdAt: now,
              updatedAt: now,
            });
            await replaceClaimLines(tx, ctx.organizationId, claim.id, resolved.lines);
            await this.audit(tx, ctx, 'expense_claim.created', claim.id, now, origin, {
              employeePartyId: claim.employeePartyId,
              total: claim.total,
              lines: resolved.lines.length,
            });
            return this.detail(tx, ctx, claim.id);
          },
        ),
    );
  }

  update(
    principal: Principal,
    id: string,
    input: ClaimDraftInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      async (tx, ctx) => {
        const claim = await this.lockDraft(tx, ctx, id, input.version, 'edited');
        const resolved = await this.resolve(tx, ctx.organizationId, input);
        const now = this.now;
        const updated = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: {
            employeePartyId: input.employeePartyId,
            claimDate: input.claimDate,
            memo: input.memo?.trim() ?? '',
            total: resolved.total,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await replaceClaimLines(tx, ctx.organizationId, id, resolved.lines);
        await this.audit(tx, ctx, 'expense_claim.updated', id, now, origin, {
          total: { before: claim.total, after: updated.total },
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  delete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      async (tx, ctx) => {
        const claim = await this.lockDraft(tx, ctx, id, input.version, 'deleted');
        await deleteClaim(tx, ctx.organizationId, id);
        await this.audit(tx, ctx, 'expense_claim.deleted', id, this.now, origin, {
          total: claim.total,
        });
        return { id, deleted: true };
      },
    );
  }

  private async lockDraft(
    tx: Transaction,
    ctx: AuthorizationContext,
    id: string,
    version: number,
    verb: 'edited' | 'deleted',
  ) {
    const claim = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
    if (!claim) throw new NotFoundError('Expense claim not found.');
    if (claim.version !== version) throw versionConflict();
    if (claim.status !== 'DRAFT') {
      throw invalidState(
        claim.status === 'PENDING_APPROVAL'
          ? `The expense claim is awaiting approval. Withdraw it before it can be ${verb}.`
          : `Only draft expense claims can be ${verb}.`,
      );
    }
    return claim;
  }

  // ---------------------------------------------------------------------------
  // Submit, withdraw, cancel
  // ---------------------------------------------------------------------------

  submit(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      async (tx, ctx) => {
        const claim = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
        if (!claim) throw new NotFoundError('Expense claim not found.');
        if (claim.version !== input.version) throw versionConflict();
        if (claim.status !== 'DRAFT')
          throw invalidState('Only draft expense claims can be submitted.');
        const lines = await getClaimLines(tx, ctx.organizationId, id);
        // Recheck with today's references: the employee, the accounts, the amounts.
        await this.resolve(tx, ctx.organizationId, {
          employeePartyId: claim.employeePartyId,
          claimDate: claim.claimDate,
          memo: claim.memo,
          lines: lines.map((l) => ({
            expenseDate: l.expenseDate,
            description: l.description,
            accountId: l.accountId,
            amount: l.amount,
          })),
        });
        const settings = await getClaimSettings(tx, ctx.organizationId);
        if (settings?.receiptRequiredOver) {
          const needs = lines.some((l) => decimal(l.amount).gte(settings.receiptRequiredOver!));
          const receipts = await listLinkedFiles(tx, ctx.organizationId, 'expense_claim', id);
          if (needs && receipts.length === 0) {
            throw new ValidationError([
              {
                path: 'receipts',
                message: `Attach a receipt: a line is ${decimal(settings.receiptRequiredOver).toFixed()} or more.`,
              },
            ]);
          }
        }
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        const now = this.now;
        const facts = {
          transactionType: 'expense_claim',
          baseAmount: decimal(claim.total).toFixed(minorUnits(accounting.baseCurrency)),
          baseCurrency: accounting.baseCurrency,
        };
        const request = await this.approvals.openRequest(tx, {
          authz: ctx,
          actionKey: CLAIM_APPROVE_ACTION,
          subjectId: id,
          // No self-approval: neither the preparer nor the submitter.
          excludedUserIds: [...new Set([ctx.userId, claim.createdByUserId])],
          reason: null,
          facts,
          now,
        });
        const number = claim.number ?? (await this.nextNumber(tx, ctx.organizationId));
        const submitted = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'DRAFT',
          version: input.version,
          set: request
            ? {
                status: 'PENDING_APPROVAL',
                number,
                approvalRequestId: request.id,
                submittedByUserId: ctx.userId,
                submittedAt: now,
                updatedByUserId: ctx.userId,
                updatedAt: now,
              }
            : {
                status: 'APPROVED',
                number,
                submittedByUserId: ctx.userId,
                submittedAt: now,
                approvedAt: now,
                updatedByUserId: ctx.userId,
                updatedAt: now,
              },
        });
        if (!submitted) throw versionConflict();
        await this.audit(
          tx,
          ctx,
          request ? 'expense_claim.submitted' : 'expense_claim.approved',
          id,
          now,
          origin,
          {
            number,
            approvalRequestId: request?.id ?? null,
            facts,
          },
        );
        return this.detail(tx, ctx, id);
      },
    );
  }

  private async nextNumber(tx: Transaction, organizationId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextClaimNumber(tx, organizationId);
      if (!(await claimNumberExists(tx, organizationId, number))) return number;
    }
    throw new ConflictError('CONFLICT', 'Could not find a free number; check the numbering.');
  }

  withdraw(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      async (tx, ctx) => {
        const claim = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
        if (!claim) throw new NotFoundError('Expense claim not found.');
        if (claim.version !== input.version) throw versionConflict();
        if (claim.status !== 'PENDING_APPROVAL') {
          throw invalidState('Only an expense claim awaiting approval can be withdrawn.');
        }
        const now = this.now;
        const request = claim.approvalRequestId
          ? await getApprovalRequest(tx, ctx.organizationId, claim.approvalRequestId, {
              forUpdate: true,
            })
          : undefined;
        if (request?.status === 'pending') {
          await this.approvals.withdrawRequest(tx, ctx.organizationId, request.id, now);
        }
        const updated = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'PENDING_APPROVAL',
          set: {
            status: 'DRAFT',
            approvalRequestId: null,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'expense_claim.withdrawn', id, now, origin, {
          approvalRequestId: request?.id ?? null,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  cancel(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Create },
      async (tx, ctx) => {
        const claim = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
        if (!claim) throw new NotFoundError('Expense claim not found.');
        if (claim.version !== input.version) throw versionConflict();
        if (claim.status !== 'APPROVED') {
          throw invalidState(
            'Only an approved expense claim that is not yet posted can be cancelled.',
          );
        }
        if (claim.billId) {
          throw invalidState(
            'A bill was started for this claim; post or delete it in Bills first.',
          );
        }
        const now = this.now;
        const updated = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'APPROVED',
          version: input.version,
          set: {
            status: 'CANCELLED',
            cancelledByUserId: ctx.userId,
            cancelledAt: now,
            cancelReason: input.reason.trim(),
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!updated) throw versionConflict();
        await this.audit(tx, ctx, 'expense_claim.cancelled', id, now, origin, {
          reason: updated.cancelReason,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Posting: the claim becomes a posted bill from the employee as a vendor
  // ---------------------------------------------------------------------------

  /**
   * Posts an approved claim. The claim's own step and the bill's steps run one after the other and
   * can be repeated safely: the bill is created once (an idempotency key and the stored link), and
   * a bill that stopped for its own approval is posted when the claim is posted again.
   */
  async post(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    // 1. The claim, the employee's vendor record and the draft bill to create.
    const start = await withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Post },
      async (tx, ctx) => {
        const claim = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
        if (!claim) throw new NotFoundError('Expense claim not found.');
        if (claim.status !== 'APPROVED') {
          throw invalidState(
            claim.status === 'POSTED'
              ? 'The expense claim is already posted.'
              : 'Only an approved expense claim can be posted.',
          );
        }
        if (!claim.billId && claim.version !== input.version) throw versionConflict();
        let vendor = await getVendorByParty(tx, ctx.organizationId, claim.employeePartyId);
        if (!vendor) {
          vendor = (
            await this.vendors.createInTransaction(
              tx,
              ctx,
              { partyId: claim.employeePartyId, paymentTermsDays: 0 },
              origin,
            )
          ).vendor;
        } else if (vendor.status !== 'ACTIVE') {
          throw invalidState(
            "The employee's vendor record is archived; restore it to reimburse the claim.",
          );
        }
        const lines = await getClaimLines(tx, ctx.organizationId, id);
        const accounting = await requireAccountingSettings(tx, ctx.organizationId);
        return {
          claim,
          vendorId: vendor.id,
          baseCurrency: accounting.baseCurrency,
          lines,
        };
      },
    );
    const { claim } = start;

    // 2. The bill: created once, linked to the claim.
    let billId = claim.billId;
    if (!billId) {
      const created = await this.bills.create(
        principal,
        {
          vendorId: start.vendorId,
          billDate: claim.claimDate,
          dueDate: claim.claimDate,
          vendorReference: claim.number,
          currencyCode: start.baseCurrency,
          taxTreatment: 'no_tax',
          memo: `Expense claim ${claim.number}${claim.memo ? `. ${claim.memo}` : ''}`.slice(
            0,
            2000,
          ),
          lines: start.lines.map((l) => ({
            description: `${l.expenseDate} ${l.description}`.slice(0, 1000),
            quantity: '1',
            unitPrice: decimal(l.amount).toFixed(),
            accountId: l.accountId,
            taxCodeId: null,
          })),
        },
        { idempotencyKey: `expense-claim:${id}:bill` },
        origin,
      );
      billId = (created.value as { id: string }).id;
      await withOrganization(
        this.deps,
        principal,
        { permission: ExpenseClaimPermissions.Post },
        async (tx, ctx) => {
          const updated = await updateClaim(tx, {
            organizationId: ctx.organizationId,
            id,
            from: 'APPROVED',
            set: { billId: billId!, updatedByUserId: ctx.userId, updatedAt: this.now },
          });
          if (!updated) throw versionConflict();
          await this.audit(tx, ctx, 'expense_claim.bill_created', id, this.now, origin, { billId });
        },
      );
    }

    // 3. Post the bill when it is still a draft (a bill policy may hold it for its own approval).
    const bill = await withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Post, readOnlySnapshot: true },
      async (tx, ctx) => {
        const row = await getBill(tx, ctx.organizationId, billId!);
        if (!row) throw new NotFoundError('The expense claim bill was not found.');
        return { status: row.status, version: row.version };
      },
    );
    if (bill.status === 'DRAFT' || bill.status === 'PENDING_APPROVAL') {
      await this.bills.post(
        principal,
        billId,
        { version: bill.version },
        { idempotencyKey: `expense-claim:${id}:post` },
        origin,
      );
    } else if (bill.status !== 'POSTED') {
      throw invalidState('The bill for this claim is not postable; check it in Bills.');
    }

    // 4. The claim is posted.
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Post },
      async (tx, ctx) => {
        const current = await getClaim(tx, ctx.organizationId, id, { forUpdate: true });
        if (!current) throw new NotFoundError('Expense claim not found.');
        if (current.status === 'POSTED') return this.detail(tx, ctx, id);
        const now = this.now;
        const posted = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'APPROVED',
          set: {
            status: 'POSTED',
            postedByUserId: ctx.userId,
            postedAt: now,
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!posted) throw versionConflict();
        await this.audit(tx, ctx, 'expense_claim.posted', id, now, origin, {
          number: posted.number,
          billId: posted.billId,
          total: posted.total,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }

  /** Voids a posted claim by voiding its bill (which needs bills.void and no payments applied). */
  async void(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    const claim = await withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const row = await getClaim(tx, ctx.organizationId, id);
        if (!row) throw new NotFoundError('Expense claim not found.');
        if (row.version !== input.version) throw versionConflict();
        if (row.status !== 'POSTED' || !row.billId) {
          throw invalidState('Only a posted expense claim can be voided.');
        }
        const bill = await getBill(tx, ctx.organizationId, row.billId);
        return { billId: row.billId, billVersion: bill?.version ?? 0, number: row.number };
      },
    );
    // The bill is voided first: it refuses when payments or credits are applied.
    await this.bills.void(
      principal,
      claim.billId,
      {
        version: claim.billVersion,
        reason: `Expense claim ${claim.number} voided: ${input.reason.trim()}`,
      },
      origin,
    );
    return withOrganization(
      this.deps,
      principal,
      { permission: ExpenseClaimPermissions.Void, sensitive: true },
      async (tx, ctx) => {
        const now = this.now;
        const voided = await updateClaim(tx, {
          organizationId: ctx.organizationId,
          id,
          from: 'POSTED',
          set: {
            status: 'VOID',
            voidedByUserId: ctx.userId,
            voidedAt: now,
            voidReason: input.reason.trim(),
            updatedByUserId: ctx.userId,
            updatedAt: now,
          },
        });
        if (!voided) throw versionConflict();
        await this.audit(tx, ctx, 'expense_claim.voided', id, now, origin, {
          reason: voided.voidReason,
          billId: voided.billId,
        });
        return this.detail(tx, ctx, id);
      },
    );
  }
}
