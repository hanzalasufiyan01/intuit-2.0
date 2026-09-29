import type { Decimal } from 'decimal.js';
import { decimal } from '../../domain/money.js';
import type { AccountSubtype, AccountType, ReportAccount } from '../accounting/index.js';

/**
 * Shared, pure building blocks of the financial statements (S3-04): decimal helpers, natural
 * signs, hierarchy roll-up, integrity checks and the flat export-ready row model. No database
 * access: inputs are the accounting module's aggregated balances.
 */

export const AMOUNT_SCALE = 4;
export const ZERO = decimal(0);
export const d = (value: string | Decimal) => (typeof value === 'string' ? decimal(value) : value);
/** Amounts leave the engine as fixed-scale decimal strings; no rounding occurs (S3-22). */
export const fmt = (value: Decimal) => value.toFixed(AMOUNT_SCALE);

export type CurrencyView = 'base' | 'base_and_account';

export const isProfitAndLoss = (type: AccountType) => type === 'REVENUE' || type === 'EXPENSE';

/**
 * Natural sign (S3-10): assets and expenses are debit-positive; liabilities, equity and revenue
 * are credit-positive. Contra and abnormal balances stay negative; nothing is reclassified.
 */
export function naturalSign(type: AccountType): 1 | -1 {
  return type === 'ASSET' || type === 'EXPENSE' ? 1 : -1;
}
export const natural = (type: AccountType, net: Decimal) =>
  naturalSign(type) === 1 ? net : net.negated();

// ---------------------------------------------------------------------------
// Drill-down (S3-19)
// ---------------------------------------------------------------------------

export type Drill =
  | {
      kind: 'ledger';
      accountId: string;
      fromDate: string | null;
      toDate: string;
      openingBasis: 'cumulative' | 'fiscal_year';
    }
  | { kind: 'profit_and_loss'; from: string | null; to: string };

// ---------------------------------------------------------------------------
// Integrity (S3-17)
// ---------------------------------------------------------------------------

export interface IntegrityCheck {
  name: string;
  status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
  left: string;
  right: string;
  difference: string;
}

export interface Integrity {
  status: 'BALANCED' | 'OUT_OF_BALANCE' | 'NOT_APPLICABLE';
  checks: IntegrityCheck[];
}

/** A balancing check is NOT_APPLICABLE for tagged (dimension-filtered) activity (S3-16). */
export function check(
  name: string,
  left: Decimal,
  right: Decimal,
  options: { notApplicable?: boolean } = {},
): IntegrityCheck {
  const difference = left.minus(right);
  return {
    name,
    status: options.notApplicable ? 'NOT_APPLICABLE' : difference.isZero() ? 'PASS' : 'FAIL',
    left: fmt(left),
    right: fmt(right),
    difference: fmt(difference),
  };
}

export function integrityOf(checks: IntegrityCheck[]): Integrity {
  const status = checks.some((c) => c.status === 'FAIL')
    ? 'OUT_OF_BALANCE'
    : checks.some((c) => c.status === 'NOT_APPLICABLE')
      ? 'NOT_APPLICABLE'
      : 'BALANCED';
  return { status, checks };
}

export interface ReportWarning {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Hierarchy (S3-24)
// ---------------------------------------------------------------------------

export interface ChartNode {
  account: ReportAccount;
  depth: number;
  children: ChartNode[];
}

/** The chart as a tree ordered by code; depth is the depth in the full chart. */
export function buildChart(accounts: readonly ReportAccount[]): ChartNode[] {
  const nodes = new Map(
    accounts.map((a) => [a.id, { account: a, depth: 0, children: [] } as ChartNode]),
  );
  const roots: ChartNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.account.parentId ? nodes.get(node.account.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortAndDepth = (list: ChartNode[], depth: number) => {
    list.sort((a, b) => a.account.code.localeCompare(b.account.code));
    for (const n of list) {
      n.depth = depth;
      sortAndDepth(n.children, depth + 1);
    }
  };
  sortAndDepth(roots, 0);
  return roots;
}

export function leavesUnder(node: ChartNode): ReportAccount[] {
  if (node.children.length === 0) return [node.account];
  return node.children.flatMap(leavesUnder);
}

export interface RolledUp<T> {
  node: ChartNode;
  value: T;
  /** A parent whose other descendants belong elsewhere (a section-partial subtotal). */
  partial: boolean;
}

/**
 * Keeps only the branches of the chart that contain at least one selected leaf and returns
 * them depth-first (parents before children). A parent's value is the sum of its selected
 * descendant leaves (S3-24); parents never carry postings of their own.
 */
export function pruneAndRollUp<T>(
  roots: readonly ChartNode[],
  selected: ReadonlySet<string>,
  leafValue: (account: ReportAccount) => T,
  add: (a: T, b: T) => T,
  /**
   * Leaves that belong to the section (visible or hidden as zero). A parent is `partial` only
   * when some descendant belongs to ANOTHER section. Defaults to `selected`.
   */
  members: ReadonlySet<string> = selected,
): RolledUp<T>[] {
  const visit = (node: ChartNode): { value: T; rows: RolledUp<T>[] } | undefined => {
    if (node.children.length === 0) {
      if (!selected.has(node.account.id)) return undefined;
      const value = leafValue(node.account);
      return { value, rows: [{ node, value, partial: false }] };
    }
    let total: T | undefined;
    const rows: RolledUp<T>[] = [];
    for (const child of node.children) {
      const result = visit(child);
      if (!result) continue;
      total = total === undefined ? result.value : add(total, result.value);
      rows.push(...result.rows);
    }
    if (total === undefined) return undefined;
    const leaves = leavesUnder(node);
    const inside = leaves.filter((l) => members.has(l.id)).length;
    return {
      value: total,
      rows: [{ node, value: total, partial: inside < leaves.length }, ...rows],
    };
  };
  return roots.flatMap((root) => visit(root)?.rows ?? []);
}

// ---------------------------------------------------------------------------
// Export-ready rows (S3-20)
// ---------------------------------------------------------------------------

/** Flat, format-neutral rows shared by the UI and future CSV/XLSX/PDF writers. */
export interface ExportRow {
  rowType: 'account' | 'computed' | 'subtotal' | 'total' | 'section';
  section: string | null;
  level: number;
  code: string | null;
  name: string;
  values: Record<string, string | null>;
}

export type Subtype = AccountSubtype | null;
