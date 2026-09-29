import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import type { Transaction } from '../../database/client.js';
import { decimal, parseAmount, RATE_SCALE } from '../../domain/money.js';
import { addDays, type AccountFacts, type RuleIssue } from './rules.js';
import {
  accountingJournalEntries,
  accountingOpeningBalanceBatches,
  accountingOpeningBalanceLines,
  accountingSettings,
  type OpeningBatchStatus,
  type OpeningLineDimension,
} from './schema.js';
import type { SystemJournalLineInput } from './system-journals.js';

/**
 * Opening balances / conversion balances (Decisions 14, 27, 68, 69; S8-01 to S8-20). Owned by the
 * accounting module: a batch of balances is posted as one system journal per currency through
 * the existing system-journal path, each balanced against the designated Opening Balance Equity
 * account. Data access plus pure planning rules; no posting happens here.
 */
export type OpeningBatch = typeof accountingOpeningBalanceBatches.$inferSelect;
export type OpeningLine = typeof accountingOpeningBalanceLines.$inferSelect;

/** Journal source reference of opening journals (S8-20): the authoritative batch relationship. */
export const OPENING_SOURCE = { module: 'accounting', type: 'opening_balance' } as const;

/** S8-07: shown when an opening line targets receivables. */
export const AR_OPENING_MESSAGE =
  'Accounts receivable cannot be given an opening balance here. Customer balances are brought in ' +
  'as opening invoices in the Sales module (Phase 3B), which keeps the customer subledger in ' +
  'balance with the control account.';
export const CONTROL_OPENING_MESSAGE =
  'Control accounts are maintained through their subledger and cannot take an opening balance here.';
/** S8-07 final ruling: opening balances need an explicitly classified account; none is inferred. */
export const UNCLASSIFIED_OPENING_MESSAGE =
  'This account has no subtype. Classify it under Chart of accounts before entering an opening ' +
  'balance; the classification is never inferred.';

/** S8-04: the opening journals are dated the day before the conversion date. */
export function openingDateFor(conversionDate: string): string {
  return addDays(conversionDate, -1);
}

// ---------------------------------------------------------------------------
// Data access (tenant RLS applies; callers set the organization context)
// ---------------------------------------------------------------------------

export async function setConversionDate(
  tx: Transaction,
  organizationId: string,
  conversionDate: string | null,
): Promise<void> {
  await tx
    .update(accountingSettings)
    .set({ conversionDate })
    .where(eq(accountingSettings.organizationId, organizationId));
}

export async function getOpeningBatch(
  tx: Transaction,
  organizationId: string,
  batchId: string,
  options: { forUpdate?: boolean } = {},
): Promise<OpeningBatch | undefined> {
  const query = tx
    .select()
    .from(accountingOpeningBalanceBatches)
    .where(
      and(
        eq(accountingOpeningBalanceBatches.organizationId, organizationId),
        eq(accountingOpeningBalanceBatches.id, batchId),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

/** The organization's open batch (DRAFT, PENDING_APPROVAL or POSTED), if any. */
export async function findOpenOpeningBatch(
  tx: Transaction,
  organizationId: string,
  options: { forUpdate?: boolean } = {},
): Promise<OpeningBatch | undefined> {
  const query = tx
    .select()
    .from(accountingOpeningBalanceBatches)
    .where(
      and(
        eq(accountingOpeningBalanceBatches.organizationId, organizationId),
        inArray(accountingOpeningBalanceBatches.status, ['DRAFT', 'PENDING_APPROVAL', 'POSTED']),
      ),
    )
    .limit(1);
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listOpeningBatches(
  tx: Transaction,
  organizationId: string,
): Promise<OpeningBatch[]> {
  return tx
    .select()
    .from(accountingOpeningBalanceBatches)
    .where(eq(accountingOpeningBalanceBatches.organizationId, organizationId))
    .orderBy(desc(accountingOpeningBalanceBatches.createdAt));
}

export async function insertOpeningBatch(
  tx: Transaction,
  input: {
    organizationId: string;
    conversionDate: string;
    notes: string;
    userId: string;
    now: Date;
  },
): Promise<OpeningBatch | undefined> {
  const [row] = await tx
    .insert(accountingOpeningBalanceBatches)
    .values({
      organizationId: input.organizationId,
      conversionDate: input.conversionDate,
      openingDate: openingDateFor(input.conversionDate),
      notes: input.notes,
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedByUserId: input.userId,
      updatedAt: input.now,
    })
    // The one-open-batch unique index decides races (S8-03).
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Updates a batch only if it is still in `from` (and at `version`, when given), bumping the
 * version. Returns the updated row, or undefined when the batch changed meanwhile.
 */
export async function updateOpeningBatch(
  tx: Transaction,
  input: {
    organizationId: string;
    batchId: string;
    from: OpeningBatchStatus;
    version?: number;
    set: Partial<Omit<OpeningBatch, 'id' | 'organizationId' | 'version' | 'createdAt'>>;
  },
): Promise<OpeningBatch | undefined> {
  const conditions = [
    eq(accountingOpeningBalanceBatches.organizationId, input.organizationId),
    eq(accountingOpeningBalanceBatches.id, input.batchId),
    eq(accountingOpeningBalanceBatches.status, input.from),
  ];
  if (input.version !== undefined) {
    conditions.push(eq(accountingOpeningBalanceBatches.version, input.version));
  }
  const [row] = await tx
    .update(accountingOpeningBalanceBatches)
    .set({ ...input.set, version: sql`${accountingOpeningBalanceBatches.version} + 1` })
    .where(and(...conditions))
    .returning();
  return row;
}

export async function deleteDraftOpeningBatch(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<boolean> {
  const rows = await tx
    .delete(accountingOpeningBalanceBatches)
    .where(
      and(
        eq(accountingOpeningBalanceBatches.organizationId, organizationId),
        eq(accountingOpeningBalanceBatches.id, batchId),
        eq(accountingOpeningBalanceBatches.status, 'DRAFT'),
      ),
    )
    .returning({ id: accountingOpeningBalanceBatches.id });
  return rows.length > 0;
}

export async function listOpeningLines(
  tx: Transaction,
  organizationId: string,
  batchId: string,
): Promise<OpeningLine[]> {
  return tx
    .select()
    .from(accountingOpeningBalanceLines)
    .where(
      and(
        eq(accountingOpeningBalanceLines.organizationId, organizationId),
        eq(accountingOpeningBalanceLines.batchId, batchId),
      ),
    )
    .orderBy(asc(accountingOpeningBalanceLines.lineNumber));
}

export interface OpeningLineInput {
  accountId: string;
  description: string;
  debit: string | null;
  credit: string | null;
  baseAmount: string | null;
  dimensions: OpeningLineDimension[];
}

/** Replaces a draft's lines (the database refuses this for any other status). */
export async function replaceOpeningLines(
  tx: Transaction,
  input: { organizationId: string; batchId: string; lines: readonly OpeningLineInput[] },
): Promise<OpeningLine[]> {
  await tx
    .delete(accountingOpeningBalanceLines)
    .where(
      and(
        eq(accountingOpeningBalanceLines.organizationId, input.organizationId),
        eq(accountingOpeningBalanceLines.batchId, input.batchId),
      ),
    );
  if (input.lines.length === 0) return [];
  return tx
    .insert(accountingOpeningBalanceLines)
    .values(
      input.lines.map((line, i) => ({
        organizationId: input.organizationId,
        batchId: input.batchId,
        lineNumber: i + 1,
        accountId: line.accountId,
        description: line.description,
        debit: line.debit,
        credit: line.credit,
        baseAmount: line.baseAmount,
        dimensions: line.dimensions,
      })),
    )
    .returning();
}

/** The journals posted for a batch, found by their source reference (S8-20). */
export async function listOpeningJournals(
  tx: Transaction,
  organizationId: string,
  batchId: string,
) {
  return tx
    .select()
    .from(accountingJournalEntries)
    .where(
      and(
        eq(accountingJournalEntries.organizationId, organizationId),
        eq(accountingJournalEntries.sourceModule, OPENING_SOURCE.module),
        eq(accountingJournalEntries.sourceType, OPENING_SOURCE.type),
        eq(accountingJournalEntries.sourceId, batchId),
      ),
    )
    .orderBy(asc(accountingJournalEntries.createdAt));
}

// ---------------------------------------------------------------------------
// Pure rules: line checks and the per-currency journal plan
// ---------------------------------------------------------------------------

export interface OpeningAccount extends AccountFacts {
  code: string;
  name: string;
}

export interface PlanLine extends OpeningLineInput {
  /** Position in the batch (1-based), used in messages. */
  lineNumber: number;
}

/**
 * Line-level rules (S8-05, S8-06, S8-07, S8-08): a known active leaf account that is not a
 * control, receivable or Opening Balance Equity account; P&L accounts only when allowed; exactly
 * one positive side in the account's currency precision; a base amount only on foreign-currency
 * accounts, in base-currency precision.
 */
export function openingLineIssues(
  line: PlanLine,
  path: string,
  context: {
    account: OpeningAccount | undefined;
    baseCurrency: string;
    obeAccountId: string | null;
    profitAndLossAllowed: boolean;
    profitAndLossReason: string;
  },
): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const { account } = context;
  if (!account) return [{ path: `${path}.accountId`, message: 'Unknown account.' }];
  if (account.status !== 'ACTIVE') {
    issues.push({ path: `${path}.accountId`, message: `${account.code} is archived.` });
  }
  if (!account.isLeaf) {
    issues.push({
      path: `${path}.accountId`,
      message: `${account.code} is a parent account; enter balances on its sub-accounts.`,
    });
  }
  if (account.isControlAccount) {
    issues.push({ path: `${path}.accountId`, message: CONTROL_OPENING_MESSAGE });
  } else if (!account.subtype) {
    issues.push({ path: `${path}.accountId`, message: UNCLASSIFIED_OPENING_MESSAGE });
  } else if (account.subtype === 'ACCOUNTS_RECEIVABLE') {
    issues.push({ path: `${path}.accountId`, message: AR_OPENING_MESSAGE });
  }
  if (context.obeAccountId !== null && account.id === context.obeAccountId) {
    issues.push({
      path: `${path}.accountId`,
      message: 'Opening Balance Equity is calculated automatically; do not enter a balance for it.',
    });
  }
  if (
    (account.accountType === 'REVENUE' || account.accountType === 'EXPENSE') &&
    !context.profitAndLossAllowed
  ) {
    issues.push({ path: `${path}.accountId`, message: context.profitAndLossReason });
  }
  const currency = account.currencyCode ?? context.baseCurrency;
  const sides = [line.debit, line.credit].filter((v) => v !== null);
  if (sides.length !== 1) {
    issues.push({ path, message: 'Enter either a debit or a credit on each line.' });
  }
  for (const side of ['debit', 'credit'] as const) {
    const value = line[side];
    if (value === null) continue;
    const parsed = parseAmount(value, currency);
    if (!parsed.ok) {
      issues.push({
        path: `${path}.${side}`,
        message:
          parsed.problem === 'not_positive'
            ? 'Amounts must be positive; use the other column instead of a negative amount.'
            : parsed.problem === 'too_many_decimals'
              ? `${currency} amounts allow at most the currency's minor-unit decimals.`
              : 'Amounts must be decimal strings, e.g. "125.50".',
      });
    }
  }
  if (line.baseAmount !== null) {
    if (currency === context.baseCurrency) {
      issues.push({
        path: `${path}.baseAmount`,
        message: 'A base amount is only entered for foreign-currency accounts.',
      });
    } else {
      const parsed = parseAmount(line.baseAmount, context.baseCurrency);
      if (!parsed.ok) {
        issues.push({
          path: `${path}.baseAmount`,
          message: `Base amounts are positive ${context.baseCurrency} amounts.`,
        });
      }
    }
  }
  return issues;
}

export interface PlannedJournal {
  currency: string;
  /** 'base' for the base currency, 'table' from the rate table, 'explicit' from carrying values. */
  rateSource: 'base' | 'table' | 'explicit';
  /** The rate used (table) or the effective rate implied by the carrying values (explicit). */
  rate: string;
  lines: SystemJournalLineInput[];
  /** The generated Opening Balance Equity line, if the currency's balances do not net to zero. */
  obe: { side: 'debit' | 'credit'; amount: string; baseAmount: string | null } | null;
  totals: { debit: string; credit: string; baseDebit: string | null; baseCredit: string | null };
  accountLines: number;
}

export interface OpeningPlan {
  issues: RuleIssue[];
  journals: PlannedJournal[];
}

/**
 * Plans one system journal per currency (Decision 68), base currency first (S8-10): the account
 * lines plus one generated Opening Balance Equity line for the net difference (S8-05). Foreign
 * base amounts come from the rate table at the opening date, or from explicit carrying values
 * given on every line of that currency (all-or-none, S8-06). A currency may carry at most
 * `maxLines - 1` account lines, keeping one line for the balance (S8-19).
 */
export function planOpeningJournals(input: {
  baseCurrency: string;
  lines: readonly PlanLine[];
  accounts: ReadonlyMap<string, OpeningAccount>;
  obeAccountId: string;
  tableRates: ReadonlyMap<string, string | null>;
  openingDate: string;
  maxLines: number;
}): OpeningPlan {
  const issues: RuleIssue[] = [];
  if (input.lines.length === 0) {
    return {
      issues: [{ path: 'lines', message: 'Enter at least one opening balance.' }],
      journals: [],
    };
  }
  const byCurrency = new Map<string, PlanLine[]>();
  for (const line of input.lines) {
    const account = input.accounts.get(line.accountId);
    const currency = account?.currencyCode ?? input.baseCurrency;
    byCurrency.set(currency, [...(byCurrency.get(currency) ?? []), line]);
  }
  const currencies = [...byCurrency.keys()].sort((a, b) =>
    a === input.baseCurrency ? -1 : b === input.baseCurrency ? 1 : a.localeCompare(b),
  );
  const journals: PlannedJournal[] = [];
  for (const currency of currencies) {
    const lines = byCurrency.get(currency)!;
    const path = `currencies.${currency}`;
    if (lines.length > input.maxLines - 1) {
      issues.push({
        path,
        message:
          `${currency} has ${lines.length} opening lines; one opening journal holds at most ` +
          `${input.maxLines - 1} account lines plus the Opening Balance Equity line. Combine ` +
          'balances into fewer accounts, or enter them after the conversion as ordinary journals.',
      });
      continue;
    }
    const isBase = currency === input.baseCurrency;
    const withBase = lines.filter((l) => l.baseAmount !== null).length;
    const explicit = !isBase && withBase > 0;
    if (explicit && withBase !== lines.length) {
      issues.push({
        path,
        message: `Enter a base amount on every ${currency} line, or on none (then the rate table is used).`,
      });
      continue;
    }
    const tableRate = input.tableRates.get(currency) ?? null;
    if (!isBase && !explicit && tableRate === null) {
      issues.push({
        path,
        message:
          `No ${currency} rate is recorded on or before ${input.openingDate}. Record a rate, ` +
          `or enter a base amount on every ${currency} line.`,
      });
      continue;
    }
    let debit = decimal(0);
    let credit = decimal(0);
    let baseDebit = decimal(0);
    let baseCredit = decimal(0);
    const journalLines: SystemJournalLineInput[] = lines.map((l) => {
      const base = l.baseAmount === null ? null : decimal(l.baseAmount);
      if (l.debit !== null) {
        debit = debit.plus(l.debit);
        if (base) baseDebit = baseDebit.plus(base);
      } else if (l.credit !== null) {
        credit = credit.plus(l.credit);
        if (base) baseCredit = baseCredit.plus(base);
      }
      return {
        accountId: l.accountId,
        description: l.description,
        kind: 'normal',
        debit: l.debit,
        credit: l.credit,
        baseDebit: explicit && l.debit !== null ? l.baseAmount : null,
        baseCredit: explicit && l.credit !== null ? l.baseAmount : null,
        dimensions: l.dimensions,
      };
    });
    const net = debit.minus(credit);
    const baseNet = baseDebit.minus(baseCredit);
    let obe: PlannedJournal['obe'] = null;
    if (!net.isZero()) {
      const side = net.gt(0) ? 'credit' : 'debit';
      let obeBase: Decimal | null = null;
      if (explicit) {
        // The balancing line sits on the same side in both currencies.
        obeBase = side === 'credit' ? baseNet : baseNet.negated();
        if (obeBase.lte(0)) {
          issues.push({
            path,
            message: `The ${currency} base amounts do not follow the ${currency} amounts; check them.`,
          });
          continue;
        }
      }
      obe = {
        side,
        amount: net.abs().toFixed(),
        baseAmount: obeBase === null ? null : obeBase.toFixed(),
      };
      journalLines.push({
        accountId: input.obeAccountId,
        description: 'Opening Balance Equity (calculated)',
        kind: 'normal',
        debit: side === 'debit' ? obe.amount : null,
        credit: side === 'credit' ? obe.amount : null,
        baseDebit: side === 'debit' ? obe.baseAmount : null,
        baseCredit: side === 'credit' ? obe.baseAmount : null,
        dimensions: [],
      });
    } else if (explicit && !baseNet.isZero()) {
      issues.push({
        path,
        message:
          `The ${currency} amounts balance but their base amounts do not; the difference cannot ` +
          'be booked without a base-only line. Check the base amounts.',
      });
      continue;
    }
    if (journalLines.length < 2) {
      issues.push({ path, message: `${currency} needs at least two lines to form a journal.` });
      continue;
    }
    const totalDebit = debit.plus(obe?.side === 'debit' ? obe.amount : 0);
    const totalCredit = credit.plus(obe?.side === 'credit' ? obe.amount : 0);
    const totalBaseDebit = explicit
      ? baseDebit.plus(obe?.side === 'debit' && obe.baseAmount ? obe.baseAmount : 0)
      : null;
    const totalBaseCredit = explicit
      ? baseCredit.plus(obe?.side === 'credit' && obe.baseAmount ? obe.baseAmount : 0)
      : null;
    journals.push({
      currency,
      rateSource: isBase ? 'base' : explicit ? 'explicit' : 'table',
      rate: isBase
        ? '1'
        : explicit
          ? totalBaseDebit!
              .div(totalDebit)
              .toDecimalPlaces(RATE_SCALE, Decimal.ROUND_HALF_UP)
              .toFixed()
          : tableRate!,
      lines: journalLines,
      obe,
      totals: {
        debit: totalDebit.toFixed(),
        credit: totalCredit.toFixed(),
        baseDebit: totalBaseDebit?.toFixed() ?? null,
        baseCredit: totalBaseCredit?.toFixed() ?? null,
      },
      accountLines: lines.length,
    });
  }
  return { issues, journals };
}

/** Per-currency totals of the entered balances (no rates), for the read-only view. */
export function openingTotals(
  lines: readonly { accountId: string; debit: string | null; credit: string | null }[],
  accounts: ReadonlyMap<string, { currencyCode?: string }>,
  baseCurrency: string,
) {
  const totals = new Map<string, { debit: Decimal; credit: Decimal; lines: number }>();
  for (const line of lines) {
    const currency = accounts.get(line.accountId)?.currencyCode ?? baseCurrency;
    const t = totals.get(currency) ?? { debit: decimal(0), credit: decimal(0), lines: 0 };
    if (line.debit !== null) t.debit = t.debit.plus(line.debit);
    if (line.credit !== null) t.credit = t.credit.plus(line.credit);
    t.lines += 1;
    totals.set(currency, t);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a === baseCurrency ? -1 : b === baseCurrency ? 1 : a.localeCompare(b)))
    .map(([currency, t]) => {
      const net = t.debit.minus(t.credit);
      return {
        currency,
        lines: t.lines,
        debit: t.debit.toFixed(),
        credit: t.credit.toFixed(),
        openingBalanceEquity: net.isZero()
          ? null
          : {
              side: net.gt(0) ? ('credit' as const) : ('debit' as const),
              amount: net.abs().toFixed(),
            },
      };
    });
}
