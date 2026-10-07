import { createHash } from 'node:crypto';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import {
  getAccount,
  getJournal,
  isValidIsoDate,
  type AccountWithFacts,
} from '../modules/accounting/index.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  BankingPermissions,
  countBankTransactionsByStatus,
  csvProvider,
  endMatch,
  findMatchCandidates,
  getActiveMatches,
  getBankingAccount,
  getBankingAccountByLedgerAccount,
  getBankRule,
  getBankTransaction,
  getJournalLineFacts,
  getLatestReconciliation,
  insertBankingAccount,
  insertBankMatch,
  insertBankRule,
  insertBankTransactions,
  insertStatementImport,
  isReconciled,
  ledgerBalance,
  listBankingAccounts,
  listBankRules,
  listBankTransactions,
  listRegisterLines,
  listStatementImports,
  MAX_STATEMENT_CHARS,
  ofxProvider,
  setBankTransactionStatus,
  updateBankingAccount,
  updateBankRule,
  updateStatementImportCounts,
  withFingerprints,
  type BankingAccount,
  type BankMatch,
  type BankRule,
  type BankTransaction,
  type BankTransactionStatus,
  type CsvMapping,
  type ParseProblem,
} from '../modules/banking/index.js';
import type { AuthorizationContext, Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { IdempotencyService } from './idempotency-service.js';
import { withOrganization } from './organization-service.js';
import { requireAccountingSettings } from './accounting-service.js';
import { shownMoney } from './sales-documents.js';

/**
 * Banking: bank accounts, statement import (CSV and OFX behind the provider abstraction), matching
 * statement transactions to posted journal lines, exclusion, and categorization rules.
 *
 * Banking reads the ledger and never writes it: a match is a row in its own table that points at
 * a journal line, so reconciling and matching cannot change posted accounting. Entries and
 * transfers (which do post, through accounting events) live in the banking posting service.
 */

const RESOURCE_ACCOUNT = 'bank_account';
const RESOURCE_TRANSACTION = 'bank_transaction';
const RESOURCE_RULE = 'bank_rule';
const MAX_BANK_ACCOUNTS = 100;
const MAX_RULES = 500;
const AUTO_MATCH_WINDOW_DAYS = 3;

const present = (value: string | null | undefined): value is string =>
  value !== undefined && value !== null;
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const versionConflict = (noun: string) =>
  new ConflictError(
    'VERSION_CONFLICT',
    `This ${noun} was changed by someone else. Reload it and apply your changes again.`,
  );

/** A bank, cash or credit-card posting account: the ledger account a banking account follows. */
export function bankLedgerAccountProblem(account: AccountWithFacts | undefined): string | null {
  if (!account) return 'Account not found.';
  if (account.status !== 'ACTIVE') return 'Choose an active account.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) return 'A control account cannot be a bank account.';
  if (
    account.subtype !== 'BANK' &&
    account.subtype !== 'CASH' &&
    account.subtype !== 'CREDIT_CARD'
  ) {
    return 'Choose a bank, cash or credit card account.';
  }
  return null;
}

/** The account a category (or a rule) may post to: active, posting, not a control account. */
export function categoryAccountProblem(account: AccountWithFacts | undefined): string | null {
  if (!account) return 'Account not found.';
  if (account.status !== 'ACTIVE') return 'Choose an active account.';
  if (!account.isLeaf) return 'Choose a posting (leaf) account.';
  if (account.isControlAccount) {
    return 'A control account is maintained through its subledger and cannot be used here.';
  }
  return null;
}

export async function requireBankingAccount(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<BankingAccount> {
  const account = await getBankingAccount(tx, organizationId, id, options);
  if (!account) throw new NotFoundError('Bank account not found.');
  return account;
}

function encodeCursor(row: BankTransaction) {
  return Buffer.from(JSON.stringify({ d: row.txnDate, i: row.id })).toString('base64url');
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

export interface BankAccountInput {
  accountId: string;
  name?: string | undefined;
  openingBalance?: string | undefined;
  openingBalanceDate?: string | null | undefined;
}

export interface StatementImportInput {
  format: 'csv' | 'ofx';
  content: string;
  mapping?: CsvMapping | undefined;
}

export interface BankRuleInput {
  name: string;
  bankingAccountId?: string | null | undefined;
  priority?: number | undefined;
  direction?: 'in' | 'out' | 'any' | undefined;
  descriptionContains?: string | null | undefined;
  minAmount?: string | null | undefined;
  maxAmount?: string | null | undefined;
  categoryAccountId: string;
  memo?: string | undefined;
}

/** The first active rule (lowest priority number) that fits an unmatched transaction. */
export function suggestRule(
  rules: readonly BankRule[],
  transaction: Pick<BankTransaction, 'bankingAccountId' | 'amount' | 'description'>,
): BankRule | undefined {
  const amount = decimal(transaction.amount);
  const size = amount.abs();
  const text = transaction.description.toLowerCase();
  return rules.find((rule) => {
    if (rule.status !== 'ACTIVE') return false;
    if (rule.bankingAccountId && rule.bankingAccountId !== transaction.bankingAccountId)
      return false;
    if (rule.direction === 'in' && !amount.gt(0)) return false;
    if (rule.direction === 'out' && !amount.lt(0)) return false;
    if (rule.descriptionContains && !text.includes(rule.descriptionContains.toLowerCase())) {
      return false;
    }
    if (rule.minAmount !== null && size.lt(rule.minAmount)) return false;
    if (rule.maxAmount !== null && size.gt(rule.maxAmount)) return false;
    return true;
  });
}

export class BankingService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly idempotency: IdempotencyService,
  ) {}

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

  // ---------------------------------------------------------------------------
  // Bank accounts
  // ---------------------------------------------------------------------------

  private async accountView(tx: Transaction, organizationId: string, account: BankingAccount) {
    const ledger = await getAccount(tx, organizationId, account.accountId);
    const settings = await requireAccountingSettings(tx, organizationId);
    const counts = await countBankTransactionsByStatus(tx, organizationId, account.id);
    const reconciliation = await getLatestReconciliation(tx, organizationId, account.id);
    const today = this.now.toISOString().slice(0, 10);
    const balance = await ledgerBalance(tx, {
      organizationId,
      ledgerAccountId: account.accountId,
      inBase: account.currencyCode === settings.baseCurrency,
      upTo: today,
    });
    const c = account.currencyCode;
    return {
      id: account.id,
      accountId: account.accountId,
      accountCode: ledger?.code ?? null,
      accountName: ledger?.name ?? null,
      name: account.name,
      currencyCode: c,
      status: account.status,
      openingBalance: shownMoney(account.openingBalance, c),
      openingBalanceDate: account.openingBalanceDate,
      bookBalance: shownMoney(balance, c),
      unmatchedCount: counts.UNMATCHED ?? 0,
      matchedCount: counts.MATCHED ?? 0,
      excludedCount: counts.EXCLUDED ?? 0,
      lastReconciledDate: reconciliation?.statementDate ?? null,
      lastReconciledBalance: reconciliation ? shownMoney(reconciliation.statementBalance, c) : null,
      version: account.version,
    };
  }

  listAccounts(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const accounts = await listBankingAccounts(tx, ctx.organizationId);
        const items = [];
        for (const account of accounts) {
          items.push(await this.accountView(tx, ctx.organizationId, account));
        }
        return { items };
      },
    );
  }

  getAccount(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) =>
        this.accountView(
          tx,
          ctx.organizationId,
          await requireBankingAccount(tx, ctx.organizationId, id),
        ),
    );
  }

  createAccount(principal: Principal, input: BankAccountInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.AccountsManage },
      async (tx, ctx) => {
        const existing = await listBankingAccounts(tx, ctx.organizationId);
        if (existing.length >= MAX_BANK_ACCOUNTS) {
          throw new ValidationError([
            {
              path: 'accountId',
              message: `At most ${MAX_BANK_ACCOUNTS} bank accounts are supported.`,
            },
          ]);
        }
        const ledger = await getAccount(tx, ctx.organizationId, input.accountId);
        const problem = bankLedgerAccountProblem(ledger);
        const issues: ValidationIssue[] = [];
        if (problem) issues.push({ path: 'accountId', message: problem });
        else if (await getBankingAccountByLedgerAccount(tx, ctx.organizationId, input.accountId)) {
          issues.push({
            path: 'accountId',
            message: 'This account already has a bank account.',
          });
        }
        issues.push(...this.openingProblems(input));
        if (issues.length) throw new ValidationError(issues);
        const now = this.now;
        const created = await insertBankingAccount(tx, {
          organizationId: ctx.organizationId,
          accountId: input.accountId,
          name: (input.name?.trim() || ledger!.name).slice(0, 100),
          currencyCode: ledger!.currencyCode,
          openingBalance: decimal(input.openingBalance ?? '0').toFixed(4),
          openingBalanceDate: input.openingBalanceDate ?? null,
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit(tx, ctx, 'bank_account.created', RESOURCE_ACCOUNT, created.id, origin, {
          accountId: created.accountId,
          currencyCode: created.currencyCode,
        });
        return this.accountView(tx, ctx.organizationId, created);
      },
    );
  }

  private openingProblems(input: {
    openingBalance?: string | undefined;
    openingBalanceDate?: string | null | undefined;
  }): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    if (input.openingBalance !== undefined && !decimal(input.openingBalance).isZero()) {
      if (!input.openingBalanceDate) {
        issues.push({
          path: 'openingBalanceDate',
          message: 'Give the date of the statement balance the account starts from.',
        });
      }
    }
    if (input.openingBalanceDate && !isValidIsoDate(input.openingBalanceDate)) {
      issues.push({ path: 'openingBalanceDate', message: 'Enter a valid date (YYYY-MM-DD).' });
    }
    return issues;
  }

  updateAccount(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name?: string | undefined;
      openingBalance?: string | undefined;
      openingBalanceDate?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.AccountsManage },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, id, {
          forUpdate: true,
        });
        if (account.version !== input.version) throw versionConflict('bank account');
        const set: Partial<typeof account> = { updatedByUserId: ctx.userId, updatedAt: this.now };
        if (input.name !== undefined) set.name = input.name.trim();
        if (input.openingBalance !== undefined || input.openingBalanceDate !== undefined) {
          // The starting balance anchors every reconciliation: fixed once a statement is in.
          const counts = await countBankTransactionsByStatus(tx, ctx.organizationId, id);
          if (Object.values(counts).some((n) => n > 0)) {
            throw invalidState('The opening balance cannot change after statements were imported.');
          }
          const issues = this.openingProblems({
            openingBalance: input.openingBalance ?? account.openingBalance,
            openingBalanceDate:
              input.openingBalanceDate === undefined
                ? account.openingBalanceDate
                : input.openingBalanceDate,
          });
          if (issues.length) throw new ValidationError(issues);
          if (input.openingBalance !== undefined) {
            set.openingBalance = decimal(input.openingBalance).toFixed(4);
          }
          if (input.openingBalanceDate !== undefined)
            set.openingBalanceDate = input.openingBalanceDate;
        }
        const updated = await updateBankingAccount(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set,
        });
        if (!updated) throw versionConflict('bank account');
        await this.audit(tx, ctx, 'bank_account.updated', RESOURCE_ACCOUNT, id, origin, {
          name: updated.name,
          openingBalance: updated.openingBalance,
        });
        return this.accountView(tx, ctx.organizationId, updated);
      },
    );
  }

  setAccountStatus(
    principal: Principal,
    id: string,
    status: 'ACTIVE' | 'ARCHIVED',
    input: { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.AccountsManage },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, id, {
          forUpdate: true,
        });
        if (account.version !== input.version) throw versionConflict('bank account');
        if (account.status === status) {
          throw invalidState(`The bank account is already ${status.toLowerCase()}.`);
        }
        const updated = await updateBankingAccount(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status, updatedByUserId: ctx.userId, updatedAt: this.now },
        });
        if (!updated) throw versionConflict('bank account');
        await this.audit(
          tx,
          ctx,
          status === 'ARCHIVED' ? 'bank_account.archived' : 'bank_account.restored',
          RESOURCE_ACCOUNT,
          id,
          origin,
          {},
        );
        return this.accountView(tx, ctx.organizationId, updated);
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Statement import
  // ---------------------------------------------------------------------------

  /** Header and sample rows of a CSV statement, for the column mapping screen. */
  previewCsv(principal: Principal, content: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsImport, readOnlySnapshot: true },
      async () => {
        if (content.length > MAX_STATEMENT_CHARS) {
          throw new ValidationError([
            { path: 'content', message: 'The statement is larger than 5 MB.' },
          ]);
        }
        const { csvHeader } = await import('../modules/banking/statement-parsers.js');
        return csvHeader(content);
      },
    );
  }

  importStatement(
    principal: Principal,
    bankingAccountId: string,
    input: StatementImportInput,
    options: { idempotencyKey: string | null },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsImport },
      (tx, ctx) =>
        this.idempotency.run(
          tx,
          ctx,
          {
            key: options.idempotencyKey,
            scope: 'banking.statement.import',
            request: {
              bankingAccountId,
              format: input.format,
              sha: createHash('sha256').update(input.content).digest('hex'),
              mapping: input.mapping ?? null,
            },
          },
          () => this.importInTransaction(tx, ctx, bankingAccountId, input, origin),
        ),
    );
  }

  private async importInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    bankingAccountId: string,
    input: StatementImportInput,
    origin: EventOrigin,
  ) {
    const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId, {
      forUpdate: true,
    });
    if (account.status !== 'ACTIVE')
      throw invalidState('Statements cannot be imported into an archived bank account.');
    if (input.content.length > MAX_STATEMENT_CHARS) {
      throw new ValidationError([
        { path: 'content', message: 'The statement is larger than 5 MB.' },
      ]);
    }
    let parsed;
    if (input.format === 'csv') {
      if (!input.mapping) {
        throw new ValidationError([
          { path: 'mapping', message: 'Map the statement columns first.' },
        ]);
      }
      parsed = await csvProvider.parse(input.content, input.mapping);
    } else {
      parsed = await ofxProvider.parse(input.content, {});
    }
    const problems: ParseProblem[] = [...parsed.problems];
    if (parsed.currency && parsed.currency !== account.currencyCode) {
      problems.push({
        rowNumber: 0,
        field: 'currency',
        message: `The statement is in ${parsed.currency}; this bank account is in ${account.currencyCode}.`,
      });
    }
    if (problems.length) {
      // All or nothing: a statement with unreadable rows is fixed and imported again.
      throw new ValidationError(
        problems.slice(0, 50).map((p) => ({
          path: p.rowNumber ? `row ${p.rowNumber}: ${p.field}` : p.field,
          message: p.message,
        })),
        `The statement has ${problems.length} problem${problems.length === 1 ? '' : 's'}; nothing was imported.`,
      );
    }
    const rows = withFingerprints(parsed.transactions);
    const dates = rows.map((r) => r.date).sort();
    const now = this.now;
    const record = await insertStatementImport(tx, {
      organizationId: ctx.organizationId,
      bankingAccountId,
      source: input.format,
      contentSha256: createHash('sha256').update(input.content).digest('hex'),
      periodStart: dates[0] ?? null,
      periodEnd: dates[dates.length - 1] ?? null,
      transactionCount: 0,
      duplicateCount: 0,
      importedByUserId: ctx.userId,
      createdAt: now,
    });
    const inserted = await insertBankTransactions(
      tx,
      rows.map((r) => ({
        organizationId: ctx.organizationId,
        bankingAccountId,
        importId: record.id,
        txnDate: r.date,
        description: r.description,
        reference: r.reference,
        amount: decimal(r.amount).toFixed(4),
        currencyCode: account.currencyCode,
        balance: r.balance === null ? null : decimal(r.balance).toFixed(4),
        externalId: r.externalId,
        fingerprint: r.fingerprint,
        createdAt: now,
      })),
    );
    const duplicates = rows.length - inserted.length;
    await updateStatementImportCounts(tx, ctx.organizationId, record.id, {
      transactionCount: inserted.length,
      duplicateCount: duplicates,
    });
    await this.audit(
      tx,
      ctx,
      'bank_statement.imported',
      RESOURCE_ACCOUNT,
      bankingAccountId,
      origin,
      {
        importId: record.id,
        source: input.format,
        imported: inserted.length,
        duplicates,
        periodStart: record.periodStart,
        periodEnd: record.periodEnd,
      },
    );
    return {
      importId: record.id,
      imported: inserted.length,
      duplicates,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
    };
  }

  listImports(principal: Principal, bankingAccountId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        const rows = await listStatementImports(tx, ctx.organizationId, bankingAccountId, 100);
        return {
          items: rows.map((r) => ({
            id: r.id,
            source: r.source,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            imported: r.transactionCount,
            duplicates: r.duplicateCount,
            importedAt: r.createdAt.toISOString(),
          })),
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------

  private async transactionViews(
    tx: Transaction,
    organizationId: string,
    rows: readonly BankTransaction[],
    rules: readonly BankRule[],
  ) {
    const matches = await getActiveMatches(
      tx,
      organizationId,
      rows.map((r) => r.id),
    );
    const matchOf = new Map(matches.map((m) => [m.bankingTransactionId, m]));
    const journalNumbers = new Map<string, number | null>();
    for (const m of matches) {
      if (!journalNumbers.has(m.journalId)) {
        const journal = await getJournal(tx, organizationId, m.journalId);
        journalNumbers.set(m.journalId, journal?.journalNumber ?? null);
      }
    }
    return rows.map((r) => {
      const match = matchOf.get(r.id);
      const rule = r.status === 'UNMATCHED' ? suggestRule(rules, r) : undefined;
      return {
        id: r.id,
        bankingAccountId: r.bankingAccountId,
        date: r.txnDate,
        description: r.description,
        reference: r.reference,
        amount: shownMoney(r.amount, r.currencyCode),
        currencyCode: r.currencyCode,
        balance: r.balance === null ? null : shownMoney(r.balance, r.currencyCode),
        status: r.status,
        excludedReason: r.excludedReason,
        match: match
          ? {
              id: match.id,
              source: match.source,
              journalId: match.journalId,
              journalNumber: journalNumbers.get(match.journalId) ?? null,
              journalLineId: match.journalLineId,
            }
          : null,
        suggestion: rule
          ? {
              ruleId: rule.id,
              ruleName: rule.name,
              categoryAccountId: rule.categoryAccountId,
              memo: rule.memo,
            }
          : null,
      };
    });
  }

  listTransactions(
    principal: Principal,
    bankingAccountId: string,
    query: {
      status?: BankTransactionStatus | undefined;
      search?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit: number;
      after?: string | undefined;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        const rows = await listBankTransactions(tx, {
          organizationId: ctx.organizationId,
          bankingAccountId,
          status: query.status,
          search: query.search,
          from: query.from,
          to: query.to,
          after: query.after ? decodeCursor(query.after) : undefined,
          limit: query.limit + 1,
        });
        const page = rows.slice(0, query.limit);
        const rules = await listBankRules(tx, ctx.organizationId, { activeOnly: true });
        return {
          items: await this.transactionViews(tx, ctx.organizationId, page, rules),
          nextCursor: rows.length > query.limit ? encodeCursor(page[page.length - 1]!) : null,
        };
      },
    );
  }

  /** Posted journal lines of the bank account that could be the transaction's other side. */
  suggestMatches(principal: Principal, transactionId: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const txn = await this.requireTransaction(tx, ctx.organizationId, transactionId);
        const account = await requireBankingAccount(tx, ctx.organizationId, txn.bankingAccountId);
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const candidates = await findMatchCandidates(tx, {
          organizationId: ctx.organizationId,
          ledgerAccountId: account.accountId,
          amount: txn.amount,
          inBase: txn.currencyCode === settings.baseCurrency,
          around: txn.txnDate,
          windowDays: 45,
          limit: 20,
        });
        return {
          items: candidates.map((c) => ({
            journalLineId: c.lineId,
            journalId: c.journalId,
            journalNumber: c.journalNumber,
            date: c.entryDate,
            description: c.description,
            reference: c.reference,
            amount: shownMoney(c.amount, txn.currencyCode),
            sourceModule: c.sourceModule,
            sourceType: c.sourceType,
            sourceId: c.sourceId,
          })),
        };
      },
    );
  }

  private async requireTransaction(
    tx: Transaction,
    organizationId: string,
    id: string,
    options: { forUpdate?: boolean } = {},
  ) {
    const txn = await getBankTransaction(tx, organizationId, id, options);
    if (!txn) throw new NotFoundError('Bank transaction not found.');
    return txn;
  }

  private async matchInTransaction(
    tx: Transaction,
    ctx: AuthorizationContext,
    txn: BankTransaction,
    account: BankingAccount,
    journalLineId: string,
    source: BankMatch['source'],
    origin: EventOrigin,
    auditAction = 'bank_transaction.matched',
  ) {
    if (txn.status !== 'UNMATCHED')
      throw invalidState('Only an unmatched transaction can be matched.');
    const line = await getJournalLineFacts(tx, ctx.organizationId, journalLineId);
    if (!line) throw new NotFoundError('Journal line not found.');
    if (line.accountId !== account.accountId) {
      throw new ValidationError([
        { path: 'journalLineId', message: 'This journal line is not on the bank account.' },
      ]);
    }
    const settings = await requireAccountingSettings(tx, ctx.organizationId);
    const candidates = await findMatchCandidates(tx, {
      organizationId: ctx.organizationId,
      ledgerAccountId: account.accountId,
      amount: txn.amount,
      inBase: txn.currencyCode === settings.baseCurrency,
      around: txn.txnDate,
      windowDays: 36500,
      limit: 5000,
    });
    if (!candidates.some((c) => c.lineId === journalLineId)) {
      throw new ValidationError([
        {
          path: 'journalLineId',
          message:
            'This journal line does not have the amount of the bank transaction, or it is already matched.',
        },
      ]);
    }
    const flipped = await setBankTransactionStatus(tx, ctx.organizationId, txn.id, 'UNMATCHED', {
      status: 'MATCHED',
    });
    if (!flipped) throw invalidState('Only an unmatched transaction can be matched.');
    const match = await insertBankMatch(tx, {
      organizationId: ctx.organizationId,
      bankingTransactionId: txn.id,
      journalId: line.journalId,
      journalLineId,
      source,
      matchedByUserId: ctx.userId,
      matchedAt: this.now,
    });
    await this.audit(tx, ctx, auditAction, RESOURCE_TRANSACTION, txn.id, origin, {
      journalId: line.journalId,
      journalLineId,
      amount: txn.amount,
    });
    return match;
  }

  match(
    principal: Principal,
    transactionId: string,
    input: { journalLineId: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsMatch },
      async (tx, ctx) => {
        const txn = await this.requireTransaction(tx, ctx.organizationId, transactionId, {
          forUpdate: true,
        });
        const account = await requireBankingAccount(tx, ctx.organizationId, txn.bankingAccountId);
        await this.matchInTransaction(tx, ctx, txn, account, input.journalLineId, 'manual', origin);
        return this.oneView(tx, ctx.organizationId, transactionId);
      },
    );
  }

  unmatch(principal: Principal, transactionId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsMatch },
      async (tx, ctx) => {
        const txn = await this.requireTransaction(tx, ctx.organizationId, transactionId, {
          forUpdate: true,
        });
        if (txn.status !== 'MATCHED') throw invalidState('The transaction is not matched.');
        if (await isReconciled(tx, ctx.organizationId, txn.id)) {
          throw invalidState('The transaction is reconciled; reopen the reconciliation first.');
        }
        const [match] = await getActiveMatches(tx, ctx.organizationId, [txn.id]);
        if (!match) throw invalidState('The transaction has no match.');
        if (match.source !== 'manual') {
          throw invalidState(
            match.source === 'entry'
              ? 'This transaction was categorized by a bank entry; void the entry instead.'
              : 'This match belongs to a transfer; void the transfer instead.',
          );
        }
        const now = this.now;
        await endMatch(tx, ctx.organizationId, match.id, ctx.userId, now);
        await setBankTransactionStatus(tx, ctx.organizationId, txn.id, 'MATCHED', {
          status: 'UNMATCHED',
        });
        await this.audit(
          tx,
          ctx,
          'bank_transaction.unmatched',
          RESOURCE_TRANSACTION,
          txn.id,
          origin,
          {
            journalId: match.journalId,
            journalLineId: match.journalLineId,
          },
        );
        return this.oneView(tx, ctx.organizationId, transactionId);
      },
    );
  }

  exclude(
    principal: Principal,
    transactionId: string,
    input: { reason: string },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsMatch },
      async (tx, ctx) => {
        const reason = input.reason.trim();
        if (!reason) {
          throw new ValidationError([
            { path: 'reason', message: 'Give a reason for excluding it.' },
          ]);
        }
        const now = this.now;
        const updated = await setBankTransactionStatus(
          tx,
          ctx.organizationId,
          transactionId,
          'UNMATCHED',
          {
            status: 'EXCLUDED',
            excludedReason: reason,
            excludedByUserId: ctx.userId,
            excludedAt: now,
          },
        );
        if (!updated) {
          await this.requireTransaction(tx, ctx.organizationId, transactionId);
          throw invalidState('Only an unmatched transaction can be excluded.');
        }
        await this.audit(
          tx,
          ctx,
          'bank_transaction.excluded',
          RESOURCE_TRANSACTION,
          transactionId,
          origin,
          {
            reason,
          },
        );
        return this.oneView(tx, ctx.organizationId, transactionId);
      },
    );
  }

  restore(principal: Principal, transactionId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsMatch },
      async (tx, ctx) => {
        const updated = await setBankTransactionStatus(
          tx,
          ctx.organizationId,
          transactionId,
          'EXCLUDED',
          {
            status: 'UNMATCHED',
            excludedReason: null,
            excludedByUserId: null,
            excludedAt: null,
          },
        );
        if (!updated) {
          await this.requireTransaction(tx, ctx.organizationId, transactionId);
          throw invalidState('Only an excluded transaction can be restored.');
        }
        await this.audit(
          tx,
          ctx,
          'bank_transaction.restored',
          RESOURCE_TRANSACTION,
          transactionId,
          origin,
          {},
        );
        return this.oneView(tx, ctx.organizationId, transactionId);
      },
    );
  }

  /**
   * Matches every unmatched transaction that has exactly one posted journal line with the same
   * amount within a few days. Anything ambiguous is left for a person.
   */
  autoMatch(principal: Principal, bankingAccountId: string, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsMatch },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId, {
          forUpdate: true,
        });
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const unmatched = await listBankTransactions(tx, {
          organizationId: ctx.organizationId,
          bankingAccountId,
          status: 'UNMATCHED',
          limit: 1000,
        });
        let matched = 0;
        const taken = new Set<string>();
        for (const txn of unmatched) {
          const candidates = (
            await findMatchCandidates(tx, {
              organizationId: ctx.organizationId,
              ledgerAccountId: account.accountId,
              amount: txn.amount,
              inBase: txn.currencyCode === settings.baseCurrency,
              around: txn.txnDate,
              windowDays: AUTO_MATCH_WINDOW_DAYS,
              limit: 3,
            })
          ).filter((c) => !taken.has(c.lineId));
          if (candidates.length !== 1) continue;
          taken.add(candidates[0]!.lineId);
          await this.matchInTransaction(
            tx,
            ctx,
            txn,
            account,
            candidates[0]!.lineId,
            'manual',
            origin,
            'bank_transaction.auto_matched',
          );
          matched += 1;
        }
        return { matched, remaining: unmatched.length - matched };
      },
    );
  }

  private async oneView(tx: Transaction, organizationId: string, id: string) {
    const txn = await this.requireTransaction(tx, organizationId, id);
    const rules = await listBankRules(tx, organizationId, { activeOnly: true });
    return (await this.transactionViews(tx, organizationId, [txn], rules))[0]!;
  }

  getTransaction(principal: Principal, id: string) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      (tx, ctx) => this.oneView(tx, ctx.organizationId, id),
    );
  }

  // ---------------------------------------------------------------------------
  // Register (the bank account's journal lines, matched or not)
  // ---------------------------------------------------------------------------

  register(
    principal: Principal,
    bankingAccountId: string,
    query: {
      from?: string | undefined;
      to?: string | undefined;
      unmatchedOnly?: boolean | undefined;
      limit: number;
      offset: number;
    },
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => {
        const account = await requireBankingAccount(tx, ctx.organizationId, bankingAccountId);
        const settings = await requireAccountingSettings(tx, ctx.organizationId);
        const lines = await listRegisterLines(tx, {
          organizationId: ctx.organizationId,
          ledgerAccountId: account.accountId,
          inBase: account.currencyCode === settings.baseCurrency,
          from: query.from,
          to: query.to,
          unmatchedOnly: query.unmatchedOnly,
          limit: query.limit + 1,
          offset: query.offset,
        });
        const c = account.currencyCode;
        return {
          items: lines.slice(0, query.limit).map((l) => ({
            journalLineId: l.lineId,
            journalId: l.journalId,
            journalNumber: l.journalNumber,
            date: l.entryDate,
            description: l.description,
            reference: l.reference,
            amount: shownMoney(l.amount, c),
            runningBalance: shownMoney(l.runningBalance, c),
            sourceModule: l.sourceModule,
            sourceType: l.sourceType,
            sourceId: l.sourceId,
            matchedTransactionId: l.matchedTransactionId,
          })),
          hasMore: lines.length > query.limit,
        };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------

  private ruleView(rule: BankRule) {
    return {
      id: rule.id,
      name: rule.name,
      bankingAccountId: rule.bankingAccountId,
      priority: rule.priority,
      direction: rule.direction,
      descriptionContains: rule.descriptionContains,
      minAmount: rule.minAmount === null ? null : decimal(rule.minAmount).toFixed(),
      maxAmount: rule.maxAmount === null ? null : decimal(rule.maxAmount).toFixed(),
      categoryAccountId: rule.categoryAccountId,
      memo: rule.memo,
      status: rule.status,
      version: rule.version,
    };
  }

  listRules(principal: Principal) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.TransactionsView, readOnlySnapshot: true },
      async (tx, ctx) => ({
        items: (await listBankRules(tx, ctx.organizationId)).map((r) => this.ruleView(r)),
      }),
    );
  }

  private async ruleValues(tx: Transaction, organizationId: string, input: BankRuleInput) {
    const issues: ValidationIssue[] = [];
    const problem = categoryAccountProblem(
      await getAccount(tx, organizationId, input.categoryAccountId),
    );
    if (problem) issues.push({ path: 'categoryAccountId', message: problem });
    if (input.bankingAccountId) {
      if (!(await getBankingAccount(tx, organizationId, input.bankingAccountId))) {
        issues.push({ path: 'bankingAccountId', message: 'Bank account not found.' });
      }
    }
    const description = input.descriptionContains?.trim() || null;
    const direction = input.direction ?? 'any';
    if (
      !description &&
      !present(input.minAmount) &&
      !present(input.maxAmount) &&
      direction === 'any'
    ) {
      issues.push({
        path: 'descriptionContains',
        message: 'Give at least one condition for the rule.',
      });
    }
    if (
      present(input.minAmount) &&
      present(input.maxAmount) &&
      decimal(input.minAmount).gt(input.maxAmount)
    ) {
      issues.push({ path: 'minAmount', message: 'The smallest amount is above the largest.' });
    }
    if (issues.length) throw new ValidationError(issues);
    return {
      name: input.name.trim(),
      bankingAccountId: input.bankingAccountId ?? null,
      priority: input.priority ?? 100,
      direction,
      descriptionContains: description,
      minAmount: present(input.minAmount) ? decimal(input.minAmount).toFixed(4) : null,
      maxAmount: present(input.maxAmount) ? decimal(input.maxAmount).toFixed(4) : null,
      categoryAccountId: input.categoryAccountId,
      memo: input.memo?.trim() ?? '',
    };
  }

  createRule(principal: Principal, input: BankRuleInput, origin: EventOrigin) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.RulesManage },
      async (tx, ctx) => {
        if ((await listBankRules(tx, ctx.organizationId)).length >= MAX_RULES) {
          throw new ValidationError([
            { path: 'name', message: `At most ${MAX_RULES} rules are supported.` },
          ]);
        }
        const now = this.now;
        const rule = await insertBankRule(tx, {
          organizationId: ctx.organizationId,
          ...(await this.ruleValues(tx, ctx.organizationId, input)),
          createdByUserId: ctx.userId,
          createdAt: now,
          updatedAt: now,
        });
        await this.audit(tx, ctx, 'bank_rule.created', RESOURCE_RULE, rule.id, origin, {
          name: rule.name,
        });
        return this.ruleView(rule);
      },
    );
  }

  updateRule(
    principal: Principal,
    id: string,
    input: BankRuleInput & { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.RulesManage },
      async (tx, ctx) => {
        if (!(await getBankRule(tx, ctx.organizationId, id)))
          throw new NotFoundError('Rule not found.');
        const updated = await updateBankRule(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: {
            ...(await this.ruleValues(tx, ctx.organizationId, input)),
            updatedByUserId: ctx.userId,
            updatedAt: this.now,
          },
        });
        if (!updated) throw versionConflict('rule');
        await this.audit(tx, ctx, 'bank_rule.updated', RESOURCE_RULE, id, origin, {
          name: updated.name,
        });
        return this.ruleView(updated);
      },
    );
  }

  setRuleStatus(
    principal: Principal,
    id: string,
    status: 'ACTIVE' | 'ARCHIVED',
    input: { version: number },
    origin: EventOrigin,
  ) {
    return withOrganization(
      this.deps,
      principal,
      { permission: BankingPermissions.RulesManage },
      async (tx, ctx) => {
        if (!(await getBankRule(tx, ctx.organizationId, id)))
          throw new NotFoundError('Rule not found.');
        const updated = await updateBankRule(tx, {
          organizationId: ctx.organizationId,
          id,
          version: input.version,
          set: { status, updatedByUserId: ctx.userId, updatedAt: this.now },
        });
        if (!updated) throw versionConflict('rule');
        await this.audit(
          tx,
          ctx,
          status === 'ARCHIVED' ? 'bank_rule.archived' : 'bank_rule.restored',
          RESOURCE_RULE,
          id,
          origin,
          {},
        );
        return this.ruleView(updated);
      },
    );
  }
}
