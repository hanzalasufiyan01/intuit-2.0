import { sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import { AppError } from '../../domain/errors.js';
import { decimal, minorUnits } from '../../domain/money.js';
import { AccountingPermissions } from '../../modules/accounting/index.js';
import { PurchasesPermissions } from '../../modules/purchases/index.js';
import { SalesPermissions } from '../../modules/sales/index.js';
import { hasPermission, type AuthorizationContext } from '../authorization.js';
import type { UnavailableFigure, VerifiedFigure } from './types.js';

/** The slice of the report services this module needs. */
export interface SummarySources {
  reports: {
    /** Enforces accounting.reports.view itself. */
    profitAndLossInTransaction(
      tx: Transaction,
      ctx: AuthorizationContext,
      input: { includeZero: boolean; currencyView: 'base' },
    ): Promise<{
      baseCurrency: string;
      columns: { label: string }[];
      sections: { key: string; total: string[] }[];
      summary: { netProfit: string[] };
    }>;
  };
  arReports: {
    /** Does not check permissions: the caller must (done below). */
    agingInTransaction(
      tx: Transaction,
      organizationId: string,
      input: { asOf: string },
    ): Promise<{ baseCurrency: string; totals: Record<string, string> }>;
  };
  apReports: {
    /** Does not check permissions: the caller must (done below). */
    agingInTransaction(
      tx: Transaction,
      organizationId: string,
      input: { asOf: string },
    ): Promise<{ baseCurrency: string; totals: Record<string, string> }>;
  };
}

export type SummaryKind = VerifiedFigure['id'];

// A question asks for the person's own numbers only with a possessive or "how much" cue, so a
// concept question ("what is accounts receivable?") never pulls figures from the books.
const OWN_DATA_CUE =
  /\b(my|our|we|us|i)\b|\bhow much\b|\bthis (year|month|quarter)\b|\boutstanding\b|\bcurrent(ly)?\b|\bright now\b|\bto date\b|\bso far\b|\btotal\b/i;

const INTENTS: { kind: SummaryKind; pattern: RegExp }[] = [
  {
    kind: 'receivables',
    pattern:
      /\b(receivables?|owed to (me|us)|customers? owe|unpaid invoices?|overdue invoices?|outstanding invoices?|who owes (me|us))\b/i,
  },
  {
    kind: 'payables',
    pattern:
      /\b(payables?|(we|i) owe|owed to vendors?|unpaid bills?|overdue bills?|outstanding bills?|bills? (due|to pay))\b/i,
  },
  {
    kind: 'profit_and_loss',
    pattern:
      /\b(net (profit|income)|profit|loss|revenue|income|expenses?|how (am i|are we) doing|p ?& ?l|profit and loss)\b/i,
  },
];

/** Which summaries a question asks for. Pure and deterministic; nothing is read here. */
export function detectSummaryKinds(question: string): SummaryKind[] {
  if (!OWN_DATA_CUE.test(question)) return [];
  return INTENTS.filter((i) => i.pattern.test(question)).map((i) => i.kind);
}

const TITLES: Record<SummaryKind, string> = {
  receivables: 'Receivables (what customers owe)',
  payables: 'Payables (what you owe vendors)',
  profit_and_loss: 'Profit and loss (current fiscal year to date)',
};

export interface SummaryOutcome {
  figures: VerifiedFigure[];
  unavailable: UnavailableFigure[];
}

const AGING_LABELS: [string, string][] = [
  ['current', 'Not yet due'],
  ['days1to30', '1–30 days overdue'],
  ['days31to60', '31–60 days overdue'],
  ['days61to90', '61–90 days overdue'],
  ['over90', 'Over 90 days overdue'],
  ['credit', 'Unapplied credits'],
  ['total', 'Total'],
];

/**
 * One display convention for every figure: the currency's own decimal places (as the reports and
 * documents use), thousands separators, a minus sign for negatives, and no currency symbol (the
 * currency code travels beside it). The exact value stays in `amount`.
 */
export function formatDisplay(amount: string, currency: string): string {
  const [whole, fraction] = decimal(amount).toFixed(minorUnits(currency)).split('.');
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

const row = (label: string, amount: string, currency: string) => ({
  label,
  amount,
  display: formatDisplay(amount, currency),
  currency,
});

function agingRows(totals: Record<string, string>, currency: string) {
  return AGING_LABELS.filter(([key]) => totals[key] !== undefined).map(([key, label]) =>
    row(label, totals[key]!, currency),
  );
}

// A report may fail for reasons that say nothing about security: accounting is not set up yet
// (409), a missing fiscal year (404), a bad range (400/422), or the database could not run the
// query. Only those are turned into "not available". Everything else (permission, authentication,
// MFA, rate limit, row-level-security and other privilege errors, and plain bugs) is rethrown.
const RECOVERABLE_APP_STATUSES = new Set([400, 404, 409, 422]);

/** The PostgreSQL error code of a failed query, whether or not the driver wrapped the error. */
function databaseCode(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isRecoverableReportFailure(error: unknown): boolean {
  if (error instanceof AppError) return RECOVERABLE_APP_STATUSES.has(error.status);
  const code = databaseCode(error);
  if (code === undefined) return false;
  // 42501 insufficient_privilege (row-level security raises it too), 28xxx invalid authorization,
  // 0Lxxx invalid grantor: never swallowed.
  return code !== '42501' && !code.startsWith('28') && !code.startsWith('0L');
}

async function readFigure(
  kind: SummaryKind,
  sources: SummarySources,
  tx: Transaction,
  ctx: AuthorizationContext,
  today: string,
): Promise<VerifiedFigure | null> {
  const title = TITLES[kind];
  if (kind === 'receivables') {
    const r = await sources.arReports.agingInTransaction(tx, ctx.organizationId, { asOf: today });
    return {
      id: kind,
      title,
      rows: agingRows(r.totals, r.baseCurrency),
      period: `as of ${today}`,
      source: 'Sales > Reports',
    };
  }
  if (kind === 'payables') {
    const r = await sources.apReports.agingInTransaction(tx, ctx.organizationId, { asOf: today });
    return {
      id: kind,
      title,
      rows: agingRows(r.totals, r.baseCurrency),
      period: `as of ${today}`,
      source: 'Purchases > Reports',
    };
  }
  const r = await sources.reports.profitAndLossInTransaction(tx, ctx, {
    includeZero: false,
    currencyView: 'base',
  });
  const revenue = r.sections.find((section) => section.key === 'revenue')?.total[0];
  const net = r.summary.netProfit[0];
  if (revenue === undefined || net === undefined) return null;
  return {
    id: kind,
    title,
    rows: [row('Revenue', revenue, r.baseCurrency), row('Net profit', net, r.baseCurrency)],
    period: r.columns[0]?.label ?? 'current fiscal year to date',
    source: 'Accounting > Profit & Loss',
  };
}

/**
 * Reads the requested figures through the existing report services, inside the caller's
 * transaction and with their authorization context. A figure the member may not see, or that cannot
 * be produced, is reported as unavailable; it is never estimated or filled in. Only aggregate
 * totals leave this function (no names, no document numbers).
 *
 * Each figure is read under its own savepoint. A PostgreSQL error aborts the whole transaction
 * unless it is rolled back to a savepoint, and the caller still has to write its audit event in the
 * same transaction, so a recoverable failure of one figure must not poison the others or the audit
 * write. Security failures are not recovered: they propagate and the transaction ends.
 */
export async function buildSummaries(
  kinds: readonly SummaryKind[],
  sources: SummarySources,
  tx: Transaction,
  ctx: AuthorizationContext,
  today: string,
): Promise<SummaryOutcome> {
  const figures: VerifiedFigure[] = [];
  const unavailable: UnavailableFigure[] = [];
  for (const kind of kinds) {
    const title = TITLES[kind];
    const permission =
      kind === 'receivables'
        ? SalesPermissions.ReportsView
        : kind === 'payables'
          ? PurchasesPermissions.ReportsView
          : AccountingPermissions.ReportsView;
    if (!hasPermission(ctx, permission)) {
      unavailable.push({ id: kind, title, reason: 'no_permission' });
      continue;
    }
    await tx.execute(sql`SAVEPOINT assistant_figure`);
    try {
      const figure = await readFigure(kind, sources, tx, ctx, today);
      await tx.execute(sql`RELEASE SAVEPOINT assistant_figure`);
      if (figure) figures.push(figure);
      else unavailable.push({ id: kind, title, reason: 'not_available' });
    } catch (error) {
      if (!isRecoverableReportFailure(error)) throw error;
      // The reason is not exposed: the answer simply says the figure is not available.
      await tx.execute(sql`ROLLBACK TO SAVEPOINT assistant_figure`);
      await tx.execute(sql`RELEASE SAVEPOINT assistant_figure`);
      unavailable.push({ id: kind, title, reason: 'not_available' });
    }
  }
  return { figures, unavailable };
}
