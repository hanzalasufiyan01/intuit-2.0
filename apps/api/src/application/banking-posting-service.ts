import { randomUUID } from 'node:crypto';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  findApplicableRate,
  getAccount,
  getDimensionValuesByIds,
  getJournalLines,
  isValidIsoDate,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  BankingPermissions,
  bankEntryNumberExists,
  bankTransferNumberExists,
  countUnmatchedUpTo,
  endMatch,
  getActiveMatches,
  getActiveMatchesByJournal,
  getBankEntry,
  getBankingAccount,
  getBankingAccountByLedgerAccount,
  getBankTransaction,
  getBankTransfer,
  getLatestReconciliation,
  getReconciliation,
  insertBankEntry,
  insertBankMatch,
  insertBankTransfer,
  insertReconciliation,
  isReconciled,
  ledgerBalance,
  listBankEntries,
  listBankTransfers,
  listClearableTransactions,
  listBankTransactions,
  listReconciliationItems,
  listReconciliations,
  reopenReconciliation,
  setBankTransactionStatus,
  takeNextBankingNumber,
  updateBankEntry,
  updateBankTransfer,
  type BankEntry,
  type BankingAccount,
  type BankReconciliation,
  type BankTransfer,
} from '../modules/banking/index.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import type { JournalService } from './journal-service.js';
import { withOrganization } from './organization-service.js';
import { requireAccountingSettings } from './accounting-service.js';
import {
  bankLedgerAccountProblem,
  categoryAccountProblem,
  requireBankingAccount,
} from './banking-service.js';
import {
  assertOpenPeriod,
  assertRequiredDimensions,
  journalLine,
  shownMoney,
} from './sales-documents.js';

/**
 * Banking documents that post, and the reconciliation (ledger tables are never written here).
 *
 * - A bank entry categorizes one statement transaction: Dr/Cr the bank account against a chosen
 *   account, posted through the `banking.entry_posted` accounting event and matched to its
 *   transaction at once.
 * - A transfer moves money between two bank accounts, posted through `banking.transfer_posted`
 *   (same currency, or one foreign account and one base-currency account at the implied rate).
 * - Both are voided by reversing their journal through Banking (a recent password confirmation is
 *   required); a transaction counted by a reconciliation cannot be released until it is reopened.
 * - A reconciliation compares the matched (cleared) transactions with the statement balance. It
 *   writes only its own tables: a posted journal line is never touched.
 */

export const BANK_ENTRY_POSTED_EVENT = 'banking.entry_posted';
export const BANK_TRANSFER_POSTED_EVENT = 'banking.transfer_posted';
const ENTRY_RESOURCE = 'bank_entry';
const TRANSFER_RESOURCE = 'bank_transfer';
const RECONCILIATION_RESOURCE = 'bank_reconciliation';

const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun: string) =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

export interface CategorizeInput {
  categoryAccountId: string;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
}

export interface TransferInput {
  transferDate: string;
  fromBankingAccountId: string;
  toBankingAccountId: string;
  fromAmount: string;
  /** Needed when the two accounts are in different currencies. */
  toAmount?: string | undefined;
  memo?: string | undefined;
  dimensionValueIds?: string[] | undefined;
}

interface PostingSide {
  accountId: string;
  side: 'debit' | 'credit';
  amount: string;
  description: string;
}

export class BankingPostingService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly journals: JournalService,
    private readonly idempotency: IdempotencyService,
  ) {
    for (const event of [BANK_ENTRY_POSTED_EVENT, BANK_TRANSFER_POSTED_EVENT]) {
      // Banking posts under its own permissions; the journal is already complete (Decision 13).
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

  /** Known, active dimension values, one per type (D10). */
  private async dimensionIssues(
    tx: Transaction,
    organizationId: string,
    ids: readonly string[],
  ): Promise<{ issues: ValidationIssue[]; typeOf: Map<string, string> }> {
    const values = await getDimensionValuesByIds(tx, organizationId, ids);
    const issues: ValidationIssue[] = [];
    const types = new Set<string>();
    for (const id of ids) {
      const value = values.get(id);
      if (!value) issues.push({ path: 'dimensionValueIds', message: 'Unknown dimension value.' });
      else if (types.has(value.dimensionTypeId)) {
        issues.push({ path: 'dimensionValueIds', message: 'Choose only one value per dimension.' });
      } else if (value.status !== 'ACTIVE' || value.typeStatus !== 'ACTIVE') {
        issues.push({
          path: 'dimensionValueIds',
          message: `${value.name} is archived and cannot be assigned.`,
        });
      } else types.add(value.dimensionTypeId);
    }
    return {
      issues,
      typeOf: new Map([...values].map(([id, v]) => [id, v.dimensionTypeId])),
    };
  }

  /** Dr/Cr lines as the shared journal-line shape; the dimensions go on every line. */
  private journalLines(
    sides: readonly PostingSide[],
    dimensionValueIds: readonly string[],
    number: string,
    typeOf: ReadonlyMap<string, string>,
  ) {
    const lines = sides.map((s) => ({
      role: 'payable' as const,
      accountId: s.accountId,
      side: s.side,
      amount: decimal(s.amount),
      description: s.description,
      dimensionValueIds: [...dimensionValueIds],
      baseAmount: decimal(0),
    }));
    return {
      postingLines: lines,
      journalLines: lines.map((l) => journalLine(l, number, typeOf)),
    };
  }

  private async exchangeRate(
    tx: Transaction,
    organizationId: string,
    baseCurrency: string,
    currency: string,
    date: string,
  ): Promise<{ rate: string | null; source: 'base' | 'table' }> {
    if (currency === baseCurrency) return { rate: null, source: 'base' };
    const found = await findApplicableRate(tx, {
      organizationId,
      fromCurrency: currency,
      toCurrency: baseCurrency,
      onDate: date,
    });
    if (!found) {
      throw new AppError(
        'EXCHANGE_RATE_REQUIRED',
        409,
        `An exchange rate from ${currency} to ${baseCurrency} is required for ${date}.`,
      );
    }
    return { rate: decimal(found.rate).toFixed(10), source: 'table' };
  }

  private async nextNumber(
    tx: Transaction,
    organizationId: string,
    type: 'bank_entry' | 'bank_transfer',
  ): Promise<string> {
    const exists = type === 'bank_entry' ? bankEntryNumberExists : bankTransferNumberExists;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const number = await takeNextBankingNumber(tx, organizationId, type);
      if (!(await exists(tx, organizationId, number))) return number;
    }
    throw new AppError('CONFLICT', 409, 'Could not find a free number; check the numbering.');
  }

  // ---------------------------------------------------------------------------
  // Entries (categorize a statement transaction)
  // ---------------------------------------------------------------------------

  private entryView(entry: BankEntry) {
    const c = entry.currencyCode;
    return {
      id: entry.id,
      number: entry.number,
      status: entry.status,
      bankingTransactionId: entry.bankingTransactionId,
      bankingAccountId: entry.bankingAccountId,
      date: entry.entryDate,
      direction: entry.direction,
      amount: shownMoney(entry.amount, c),
      currencyCode: c,
      categoryAccountId: entry.categoryAccountId,
      memo: entry.memo,
      dimensionValueIds: entry.dimensionValueIds,
      exchangeRate: entry.exchangeRateSource === 'base' ? null : entry.exchangeRate,
      baseAmount: entry.baseAmount,
      journalId: entry.journalId,
      voidJournalId: entry.voidJournalId,
      voidedAt: entry.voidedAt?.toISOString() ?? null,
      voidReason: entry.voidReason,
      version: entry.version,
    };
  }

  categorize(
    principal: Principal,
    transactionId: string,
    input: CategorizeInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsCategorize },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'banking.entry.post',
            request: { transactionId, ...input },
          },
          () => this.categorizeInTransaction(tx, ctx, transactionId, input, origin),
        ),
    );
  }

  private async categorizeInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    transactionId: string,
    input: CategorizeInput,
    origin: EventOrigin,
  ) {
    const txn = await getBankTransaction(tx, ctx.organizationId, transactionId, {
      forUpdate: true,
    });
    if (!txn) throw new NotFoundError('Bank transaction not found.');
    if (txn.status !== 'UNMATCHED') {
      throw invalidState(
        txn.status === 'MATCHED'
          ? 'The transaction is already matched.'
          : 'An excluded transaction must be restored before it is categorized.',
      );
    }
    const bank = await requireBankingAccount(tx, ctx.organizationId, txn.bankingAccountId);
    if (bank.status !== 'ACTIVE') throw invalidState('The bank account is archived.');
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const issues: ValidationIssue[] = [];
    const bankLedger = await getAccount(tx, ctx.organizationId, bank.accountId);
    const bankProblem = bankLedgerAccountProblem(bankLedger);
    if (bankProblem) issues.push({ path: 'bankingAccountId', message: bankProblem });
    const category = await getAccount(tx, ctx.organizationId, input.categoryAccountId);
    const categoryProblem = categoryAccountProblem(category);
    if (categoryProblem) issues.push({ path: 'categoryAccountId', message: categoryProblem });
    else if (input.categoryAccountId === bank.accountId) {
      issues.push({
        path: 'categoryAccountId',
        message: 'Choose an account other than the bank account.',
      });
    } else if (
      await getBankingAccountByLedgerAccount(tx, ctx.organizationId, input.categoryAccountId)
    ) {
      issues.push({
        path: 'categoryAccountId',
        message: 'This is another bank account: record a transfer between your accounts instead.',
      });
    }
    const dimensionIds = [...new Set(input.dimensionValueIds ?? [])];
    const dims = await this.dimensionIssues(tx, ctx.organizationId, dimensionIds);
    issues.push(...dims.issues);
    if (issues.length) throw new ValidationError(issues);

    await assertOpenPeriod(tx, ctx.organizationId, txn.txnDate);
    const direction = decimal(txn.amount).gt(0) ? ('in' as const) : ('out' as const);
    const amount = decimal(txn.amount).abs().toFixed(4);
    const entryId = randomUUID();
    const number = await this.nextNumber(tx, ctx.organizationId, 'bank_entry');
    const rate = await this.exchangeRate(
      tx,
      ctx.organizationId,
      settings.baseCurrency,
      txn.currencyCode,
      txn.txnDate,
    );
    const memo = (input.memo ?? '').trim().slice(0, 500);
    const text = memo || txn.description;
    const { postingLines, journalLines } = this.journalLines(
      [
        {
          accountId: bank.accountId,
          side: direction === 'in' ? 'debit' : 'credit',
          amount,
          description: `${number}: ${text}`.slice(0, 500),
        },
        {
          accountId: input.categoryAccountId,
          side: direction === 'in' ? 'credit' : 'debit',
          amount,
          description: `${number}: ${text}`.slice(0, 500),
        },
      ],
      dimensionIds,
      number,
      dims.typeOf,
    );
    await assertRequiredDimensions(tx, ctx.organizationId, postingLines, dims.typeOf);

    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'banking',
      eventType: BANK_ENTRY_POSTED_EVENT,
      eventKey: `bank_entry:${entryId}:posted`,
      payload: {
        entryId,
        number,
        journal: {
          entryDate: txn.txnDate,
          description: `Bank entry ${number} — ${txn.description}`.slice(0, 500),
          reference: number,
          currency: txn.currencyCode,
          exchangeRate: rate.rate,
          ...(rate.rate ? { exchangeRateSource: 'table' as const } : {}),
          sourceRef: { module: 'banking', type: 'entry', id: entryId },
          lines: journalLines,
        },
      },
      occurredAt: now,
      origin,
    });
    if (!event.journalId)
      throw new AppError('CONFLICT', 409, 'The entry was not posted; try again.');
    const lines = await getJournalLines(tx, ctx.organizationId, [event.journalId]);
    const bankLine = lines.find((l) => l.accountId === bank.accountId);
    if (!bankLine) throw new AppError('CONFLICT', 409, 'The entry was not posted; try again.');
    const baseAmount = decimal(bankLine.baseDebit ?? bankLine.baseCredit ?? '0');
    const entry = await insertBankEntry(tx, {
      id: entryId,
      organizationId: ctx.organizationId,
      number,
      bankingTransactionId: txn.id,
      bankingAccountId: bank.id,
      entryDate: txn.txnDate,
      direction,
      amount,
      currencyCode: txn.currencyCode,
      categoryAccountId: input.categoryAccountId,
      memo,
      dimensionValueIds: dimensionIds,
      exchangeRate: rate.rate ?? '1.0000000000',
      exchangeRateSource: rate.source,
      baseAmount: baseAmount.toFixed(4),
      journalId: event.journalId,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    await setBankTransactionStatus(tx, ctx.organizationId, txn.id, 'UNMATCHED', {
      status: 'MATCHED',
    });
    await insertBankMatch(tx, {
      organizationId: ctx.organizationId,
      bankingTransactionId: txn.id,
      journalId: event.journalId,
      journalLineId: bankLine.id,
      source: 'entry',
      matchedByUserId: ctx.userId,
      matchedAt: now,
    });
    await this.audit(tx, ctx, 'bank_entry.posted', ENTRY_RESOURCE, entry.id, origin, {
      number,
      transactionId: txn.id,
      direction,
      amount,
      currencyCode: txn.currencyCode,
      categoryAccountId: input.categoryAccountId,
      journalId: event.journalId,
    });
    return this.entryView(entry);
  }

  listEntries(
    principal: Principal,
    query: { bankingAccountId?: string | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listBankEntries(tx, ctx.organizationId, query)).map((e) => this.entryView(e)),
      }),
    );
  }

  getEntry(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const entry = await getBankEntry(tx, ctx.organizationId, id);
        if (!entry) throw new NotFoundError('Bank entry not found.');
        return this.entryView(entry);
      },
    );
  }

  voidEntry(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransfersVoid, sensitive: true },
      async (tx, ctx) => {
        const entry = await getBankEntry(tx, ctx.organizationId, id, { forUpdate: true });
        if (!entry) throw new NotFoundError('Bank entry not found.');
        if (entry.version !== input.version) throw versionConflict('bank entry');
        if (entry.status !== 'POSTED') throw invalidState('The bank entry is already void.');
        const reason = input.reason.trim();
        if (await isReconciled(tx, ctx.organizationId, entry.bankingTransactionId)) {
          throw invalidState('The transaction is reconciled; reopen the reconciliation first.');
        }
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'banking',
          entry.journalId,
          { reason: `Bank entry ${entry.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        for (const match of await getActiveMatches(tx, ctx.organizationId, [
          entry.bankingTransactionId,
        ])) {
          await endMatch(tx, ctx.organizationId, match.id, ctx.userId, now);
        }
        await setBankTransactionStatus(
          tx,
          ctx.organizationId,
          entry.bankingTransactionId,
          'MATCHED',
          {
            status: 'UNMATCHED',
          },
        );
        const voided = await updateBankEntry(tx, {
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
        if (!voided) throw versionConflict('bank entry');
        await this.audit(tx, ctx, 'bank_entry.voided', ENTRY_RESOURCE, id, origin, {
          number: entry.number,
          reason,
          reversalJournalId: reversal.id,
        });
        return this.entryView(voided);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------

  private async transferView(tx: Transaction, organizationId: string, t: BankTransfer) {
    const from = await getBankingAccount(tx, organizationId, t.fromBankingAccountId);
    const to = await getBankingAccount(tx, organizationId, t.toBankingAccountId);
    return {
      id: t.id,
      number: t.number,
      status: t.status,
      date: t.transferDate,
      fromBankingAccountId: t.fromBankingAccountId,
      fromName: from?.name ?? null,
      toBankingAccountId: t.toBankingAccountId,
      toName: to?.name ?? null,
      fromAmount: shownMoney(t.fromAmount, t.fromCurrencyCode),
      fromCurrencyCode: t.fromCurrencyCode,
      toAmount: shownMoney(t.toAmount, t.toCurrencyCode),
      toCurrencyCode: t.toCurrencyCode,
      exchangeRate: t.exchangeRateSource === 'base' ? null : t.exchangeRate,
      exchangeRateSource: t.exchangeRateSource,
      baseAmount: t.baseAmount,
      memo: t.memo,
      dimensionValueIds: t.dimensionValueIds,
      journalId: t.journalId,
      voidJournalId: t.voidJournalId,
      voidedAt: t.voidedAt?.toISOString() ?? null,
      voidReason: t.voidReason,
      version: t.version,
    };
  }

  createTransfer(
    principal: Principal,
    input: TransferInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransfersCreate },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          { key: options.idempotencyKey, scope: 'banking.transfer.post', request: input },
          () => this.transferInTransaction(tx, ctx, input, origin),
        ),
    );
  }

  private async transferInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: TransferInput,
    origin: EventOrigin,
  ) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(input.transferDate)) {
      throw new ValidationError([
        { path: 'transferDate', message: 'Enter a valid date (YYYY-MM-DD).' },
      ]);
    }
    if (input.fromBankingAccountId === input.toBankingAccountId) {
      throw new ValidationError([
        { path: 'toBankingAccountId', message: 'Choose two different bank accounts.' },
      ]);
    }
    // Lock both accounts in a fixed order so two opposite transfers cannot deadlock.
    const [firstId, secondId] = [input.fromBankingAccountId, input.toBankingAccountId].sort();
    const first = await requireBankingAccount(tx, ctx.organizationId, firstId!, {
      forUpdate: true,
    });
    const second = await requireBankingAccount(tx, ctx.organizationId, secondId!, {
      forUpdate: true,
    });
    const from: BankingAccount = first.id === input.fromBankingAccountId ? first : second;
    const to: BankingAccount = first.id === input.toBankingAccountId ? first : second;
    if (from.status !== 'ACTIVE')
      issues.push({ path: 'fromBankingAccountId', message: 'The bank account is archived.' });
    if (to.status !== 'ACTIVE')
      issues.push({ path: 'toBankingAccountId', message: 'The bank account is archived.' });
    for (const [path, account] of [
      ['fromBankingAccountId', from],
      ['toBankingAccountId', to],
    ] as const) {
      const problem = bankLedgerAccountProblem(
        await getAccount(tx, ctx.organizationId, account.accountId),
      );
      if (problem) issues.push({ path, message: problem });
    }
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const fromAmount = decimal(input.fromAmount);
    if (!fromAmount.gt(0))
      issues.push({ path: 'fromAmount', message: 'The amount must be greater than zero.' });
    const sameCurrency = from.currencyCode === to.currencyCode;
    let journalCurrency = from.currencyCode;
    let journalAmount = fromAmount;
    let toAmount = fromAmount;
    let journalRate: string | null = null;
    let rateSource: 'base' | 'table' | 'implied' = 'base';
    if (sameCurrency) {
      if (input.toAmount !== undefined && !decimal(input.toAmount).eq(fromAmount)) {
        issues.push({
          path: 'toAmount',
          message: 'Accounts in the same currency receive the amount sent.',
        });
      }
      if (!issues.length) {
        const rate = await this.exchangeRate(
          tx,
          ctx.organizationId,
          settings.baseCurrency,
          from.currencyCode,
          input.transferDate,
        );
        journalRate = rate.rate;
        rateSource = rate.source;
      }
    } else {
      const base = settings.baseCurrency;
      if (from.currencyCode !== base && to.currencyCode !== base) {
        issues.push({
          path: 'toBankingAccountId',
          message: `A transfer between two foreign currencies is not supported yet; one account must be in ${base}.`,
        });
      } else if (input.toAmount === undefined || !decimal(input.toAmount).gt(0)) {
        issues.push({ path: 'toAmount', message: 'Enter the amount the other account receives.' });
      } else {
        toAmount = decimal(input.toAmount);
        const foreignIsFrom = from.currencyCode !== base;
        const foreignAmount = foreignIsFrom ? fromAmount : toAmount;
        const baseAmount = foreignIsFrom ? toAmount : fromAmount;
        journalCurrency = foreignIsFrom ? from.currencyCode : to.currencyCode;
        journalAmount = foreignAmount;
        const rate = baseAmount.div(foreignAmount).toDecimalPlaces(10);
        const reproduced = foreignAmount.times(rate).toDecimalPlaces(4);
        if (rate.lte(0) || reproduced.minus(baseAmount).abs().gt('0.01')) {
          issues.push({
            path: 'toAmount',
            message: 'These two amounts cannot be expressed by an exchange rate with 10 decimals.',
          });
        }
        journalRate = rate.toFixed(10);
        rateSource = 'implied';
      }
    }
    const dimensionIds = [...new Set(input.dimensionValueIds ?? [])];
    const dims = await this.dimensionIssues(tx, ctx.organizationId, dimensionIds);
    issues.push(...dims.issues);
    if (issues.length) throw new ValidationError(issues);

    await assertOpenPeriod(tx, ctx.organizationId, input.transferDate);
    const number = await this.nextNumber(tx, ctx.organizationId, 'bank_transfer');
    const transferId = randomUUID();
    const memo = (input.memo ?? '').trim().slice(0, 500);
    const text = memo || `Transfer from ${from.name} to ${to.name}`;
    const amount = journalAmount.toFixed(4);
    const { postingLines, journalLines } = this.journalLines(
      [
        {
          accountId: to.accountId,
          side: 'debit',
          amount,
          description: `${number}: ${text}`.slice(0, 500),
        },
        {
          accountId: from.accountId,
          side: 'credit',
          amount,
          description: `${number}: ${text}`.slice(0, 500),
        },
      ],
      dimensionIds,
      number,
      dims.typeOf,
    );
    await assertRequiredDimensions(tx, ctx.organizationId, postingLines, dims.typeOf);
    const now = this.now;
    const event = await this.journals.receiveEventInTransaction(tx, {
      organizationId: ctx.organizationId,
      sourceModule: 'banking',
      eventType: BANK_TRANSFER_POSTED_EVENT,
      eventKey: `bank_transfer:${transferId}:posted`,
      payload: {
        transferId,
        number,
        journal: {
          entryDate: input.transferDate,
          description: `Bank transfer ${number} — ${from.name} to ${to.name}`.slice(0, 500),
          reference: number,
          currency: journalCurrency,
          exchangeRate: journalCurrency === settings.baseCurrency ? null : journalRate,
          ...(journalCurrency !== settings.baseCurrency
            ? {
                exchangeRateSource:
                  rateSource === 'implied' ? ('manual' as const) : ('table' as const),
              }
            : {}),
          sourceRef: { module: 'banking', type: 'transfer', id: transferId },
          lines: journalLines,
        },
      },
      occurredAt: now,
      origin,
    });
    if (!event.journalId)
      throw new AppError('CONFLICT', 409, 'The transfer was not posted; try again.');
    const lines = await getJournalLines(tx, ctx.organizationId, [event.journalId]);
    const debit = lines.find((l) => l.baseDebit !== null);
    const baseAmount = decimal(debit?.baseDebit ?? '0');
    // The base-currency side receives exactly what the journal booked in base.
    const base = settings.baseCurrency;
    const transfer = await insertBankTransfer(tx, {
      id: transferId,
      organizationId: ctx.organizationId,
      number,
      transferDate: input.transferDate,
      fromBankingAccountId: from.id,
      toBankingAccountId: to.id,
      fromCurrencyCode: from.currencyCode,
      toCurrencyCode: to.currencyCode,
      fromAmount: (from.currencyCode === base ? baseAmount : fromAmount).toFixed(4),
      toAmount: (to.currencyCode === base ? baseAmount : toAmount).toFixed(4),
      journalCurrencyCode: journalCurrency,
      exchangeRate: journalRate ?? '1.0000000000',
      exchangeRateSource: rateSource,
      baseAmount: baseAmount.toFixed(4),
      memo,
      dimensionValueIds: dimensionIds,
      journalId: event.journalId,
      accountingEventId: event.eventId,
      createdByUserId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    });
    await this.audit(tx, ctx, 'bank_transfer.posted', TRANSFER_RESOURCE, transfer.id, origin, {
      number,
      from: from.id,
      to: to.id,
      fromAmount: transfer.fromAmount,
      toAmount: transfer.toAmount,
      exchangeRate: transfer.exchangeRate,
      journalId: event.journalId,
    });
    return this.transferView(tx, ctx.organizationId, transfer);
  }

  listTransfers(
    principal: Principal,
    query: { bankingAccountId?: string | undefined; limit: number },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const rows = await listBankTransfers(tx, ctx.organizationId, query);
        const items = [];
        for (const row of rows) items.push(await this.transferView(tx, ctx.organizationId, row));
        return { items };
      },
    );
  }

  getTransfer(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const transfer = await getBankTransfer(tx, ctx.organizationId, id);
        if (!transfer) throw new NotFoundError('Transfer not found.');
        return this.transferView(tx, ctx.organizationId, transfer);
      },
    );
  }

  voidTransfer(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransfersVoid, sensitive: true },
      async (tx, ctx) => {
        const transfer = await getBankTransfer(tx, ctx.organizationId, id, { forUpdate: true });
        if (!transfer) throw new NotFoundError('Transfer not found.');
        if (transfer.version !== input.version) throw versionConflict('transfer');
        if (transfer.status !== 'POSTED') throw invalidState('The transfer is already void.');
        const reason = input.reason.trim();
        const matches = await getActiveMatchesByJournal(tx, ctx.organizationId, transfer.journalId);
        for (const match of matches) {
          if (await isReconciled(tx, ctx.organizationId, match.bankingTransactionId)) {
            throw invalidState(
              'A statement transaction of this transfer is reconciled; reopen the reconciliation first.',
            );
          }
        }
        const reversal = await this.journals.reverseSubledgerJournalInTransaction(
          tx,
          ctx,
          'banking',
          transfer.journalId,
          { reason: `Transfer ${transfer.number} voided: ${reason}` },
          origin,
        );
        const now = this.now;
        for (const match of matches) {
          await endMatch(tx, ctx.organizationId, match.id, ctx.userId, now);
          await setBankTransactionStatus(
            tx,
            ctx.organizationId,
            match.bankingTransactionId,
            'MATCHED',
            {
              status: 'UNMATCHED',
            },
          );
        }
        const voided = await updateBankTransfer(tx, {
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
        if (!voided) throw versionConflict('transfer');
        await this.audit(tx, ctx, 'bank_transfer.voided', TRANSFER_RESOURCE, id, origin, {
          number: transfer.number,
          reason,
          reversalJournalId: reversal.id,
        });
        return this.transferView(tx, ctx.organizationId, voided);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Reconciliation
  // ---------------------------------------------------------------------------

  /** What a reconciliation to this statement would count, and whether it balances. */
  private async reconciliationPlan(
    tx: Transaction,
    organizationId: string,
    account: BankingAccount,
    statementDate: string,
    statementBalance: string,
  ) {
    const last = await getLatestReconciliation(tx, organizationId, account.id);
    const opening = last ? last.statementBalance : account.openingBalance;
    const items = await listClearableTransactions(tx, organizationId, account.id, statementDate);
    const cleared = items.reduce((sum, t) => sum.plus(t.amount), decimal(0));
    const difference = decimal(statementBalance).minus(decimal(opening).plus(cleared));
    const unmatched = await countUnmatchedUpTo(tx, organizationId, account.id, statementDate);
    const settings = await requireAccountingSettings(tx, organizationId);
    const book = await ledgerBalance(tx, {
      organizationId,
      ledgerAccountId: account.accountId,
      inBase: account.currencyCode === settings.baseCurrency,
      upTo: statementDate,
    });
    return { last, opening, items, cleared, difference, unmatched, book };
  }

  private validateStatement(statementDate: string, statementBalance: string, today: string) {
    const issues: ValidationIssue[] = [];
    if (!isValidIsoDate(statementDate)) {
      issues.push({ path: 'statementDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    } else if (statementDate > today) {
      issues.push({
        path: 'statementDate',
        message: 'The statement date cannot be in the future.',
      });
    }
    if (!/^-?\d+(\.\d{1,4})?$/.test(statementBalance)) {
      issues.push({
        path: 'statementBalance',
        message: 'Enter the statement balance with up to 4 decimals.',
      });
    }
    if (issues.length) throw new ValidationError(issues);
  }

  previewReconciliation(
    principal: Principal,
    bankingAccountId: string,
    input: { statementDate: string; statementBalance: string },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        this.validateStatement(
          input.statementDate,
          input.statementBalance,
          this.now.toISOString().slice(0, 10),
        );
        const plan = await this.reconciliationPlan(
          tx,
          ctx.organizationId,
          account,
          input.statementDate,
          input.statementBalance,
        );
        const c = account.currencyCode;
        return {
          statementDate: input.statementDate,
          statementBalance: shownMoney(input.statementBalance, c),
          openingBalance: shownMoney(plan.opening, c),
          openingFrom: plan.last
            ? { reconciliationId: plan.last.id, statementDate: plan.last.statementDate }
            : null,
          clearedTotal: shownMoney(plan.cleared.toFixed(4), c),
          difference: shownMoney(plan.difference.toFixed(4), c),
          bookBalance: shownMoney(plan.book, c),
          unmatchedCount: plan.unmatched,
          canComplete:
            plan.difference.isZero() &&
            plan.items.length > 0 &&
            (!plan.last || input.statementDate > plan.last.statementDate),
          items: plan.items.map((t) => ({
            transactionId: t.id,
            date: t.txnDate,
            description: t.description,
            amount: shownMoney(t.amount, c),
          })),
        };
      },
    );
  }

  private reconciliationView(r: BankReconciliation, currency: string) {
    return {
      id: r.id,
      bankingAccountId: r.bankingAccountId,
      status: r.status,
      statementDate: r.statementDate,
      statementBalance: shownMoney(r.statementBalance, currency),
      openingBalance: shownMoney(r.openingBalance, currency),
      clearedTotal: shownMoney(r.clearedTotal, currency),
      itemCount: r.itemCount,
      completedAt: r.completedAt.toISOString(),
      reopenedAt: r.reopenedAt?.toISOString() ?? null,
      reopenReason: r.reopenReason,
      version: r.version,
    };
  }

  completeReconciliation(
    principal: Principal,
    bankingAccountId: string,
    input: { statementDate: string; statementBalance: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.Reconcile },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId, {
          forUpdate: true,
        });
        this.validateStatement(
          input.statementDate,
          input.statementBalance,
          this.now.toISOString().slice(0, 10),
        );
        const plan = await this.reconciliationPlan(
          tx,
          ctx.organizationId,
          account,
          input.statementDate,
          input.statementBalance,
        );
        if (plan.last && input.statementDate <= plan.last.statementDate) {
          throw invalidState(
            `A reconciliation up to ${plan.last.statementDate} exists; reconcile a later statement or reopen it.`,
          );
        }
        if (!plan.difference.isZero()) {
          throw new ValidationError(
            [
              {
                path: 'statementBalance',
                message: `The statement is ${plan.difference.toFixed(4)} away from the matched transactions. Match or categorize the rest first.`,
              },
            ],
            'The reconciliation does not balance.',
          );
        }
        if (plan.items.length === 0) {
          throw invalidState('There are no matched transactions to reconcile.');
        }
        const now = this.now;
        const reconciliation = await insertReconciliation(
          tx,
          {
            organizationId: ctx.organizationId,
            bankingAccountId,
            statementDate: input.statementDate,
            statementBalance: decimal(input.statementBalance).toFixed(4),
            openingBalance: decimal(plan.opening).toFixed(4),
            clearedTotal: plan.cleared.toFixed(4),
            itemCount: plan.items.length,
            completedByUserId: ctx.userId,
            completedAt: now,
          },
          plan.items.map((t) => ({ transactionId: t.id, amount: t.amount })),
        );
        await this.audit(
          tx,
          ctx,
          'bank_reconciliation.completed',
          RECONCILIATION_RESOURCE,
          reconciliation.id,
          origin,
          {
            bankingAccountId,
            statementDate: input.statementDate,
            statementBalance: reconciliation.statementBalance,
            itemCount: plan.items.length,
          },
        );
        return this.reconciliationView(reconciliation, account.currencyCode);
      },
    );
  }

  reopen(
    principal: Principal,
    reconciliationId: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.Reconcile, sensitive: true },
      async (tx, ctx) => {
        const reconciliation = await getReconciliation(tx, ctx.organizationId, reconciliationId, {
          forUpdate: true,
        });
        if (!reconciliation) throw new NotFoundError('Reconciliation not found.');
        if (reconciliation.version !== input.version) throw versionConflict('reconciliation');
        if (reconciliation.status !== 'COMPLETED')
          throw invalidState('The reconciliation is already reopened.');
        const account = await requireBankingAccount(
          tx,
          ctx.organizationId,
          reconciliation.bankingAccountId,
          {
            forUpdate: true,
          },
        );
        const latest = await getLatestReconciliation(tx, ctx.organizationId, account.id);
        if (latest?.id !== reconciliation.id) {
          throw invalidState('Only the latest reconciliation of a bank account can be reopened.');
        }
        const reason = input.reason.trim();
        if (!reason) {
          throw new ValidationError([
            { path: 'reason', message: 'Give a reason for reopening it.' },
          ]);
        }
        const reopened = await reopenReconciliation(tx, {
          organizationId: ctx.organizationId,
          id: reconciliationId,
          version: input.version,
          userId: ctx.userId,
          reason,
          at: this.now,
        });
        if (!reopened) throw versionConflict('reconciliation');
        await this.audit(
          tx,
          ctx,
          'bank_reconciliation.reopened',
          RECONCILIATION_RESOURCE,
          reconciliationId,
          origin,
          {
            statementDate: reconciliation.statementDate,
            reason,
          },
        );
        return this.reconciliationView(reopened, account.currencyCode);
      },
    );
  }

  listReconciliations(principal: Principal, bankingAccountId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        const rows = await listReconciliations(tx, ctx.organizationId, bankingAccountId, 200);
        return { items: rows.map((r) => this.reconciliationView(r, account.currencyCode)) };
      },
    );
  }

  getReconciliation(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const reconciliation = await getReconciliation(tx, ctx.organizationId, id);
        if (!reconciliation) throw new NotFoundError('Reconciliation not found.');
        const account = await requireBankingAccount(
          tx,
          ctx.organizationId,
          reconciliation.bankingAccountId,
        );
        const items = await listReconciliationItems(tx, ctx.organizationId, id);
        return {
          ...this.reconciliationView(reconciliation, account.currencyCode),
          items: items.map((i) => ({
            transactionId: i.transactionId,
            date: i.txnDate,
            description: i.description,
            amount: shownMoney(i.amount, account.currencyCode),
            counted: i.counted,
          })),
        };
      },
    );
  }

  /** Statement transactions not yet reconciled: unmatched ones and matched ones awaiting a statement. */
  unreconciled(principal: Principal, bankingAccountId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        const c = account.currencyCode;
        const unmatched = await listBankTransactions(tx, {
          organizationId: ctx.organizationId,
          bankingAccountId,
          status: 'UNMATCHED',
          limit: 1000,
        });
        const cleared = await listClearableTransactions(
          tx,
          ctx.organizationId,
          bankingAccountId,
          '9999-12-31',
        );
        const view = (t: { id: string; txnDate: string; description: string; amount: string }) => ({
          transactionId: t.id,
          date: t.txnDate,
          description: t.description,
          amount: shownMoney(t.amount, c),
        });
        return {
          unmatched: unmatched.map(view),
          matchedNotReconciled: cleared.map(view),
        };
      },
    );
  }
}
