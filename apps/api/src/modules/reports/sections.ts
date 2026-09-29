import type { Decimal } from 'decimal.js';
import type { AccountSubtype, AccountType, ReportAccount } from '../accounting/index.js';
import {
  buildChart,
  fmt,
  pruneAndRollUp,
  ZERO,
  type CurrencyView,
  type Drill,
  type ExportRow,
} from './engine.js';

/**
 * Multi-column sectioned statements (P&L, Balance Sheet). Each column is one aggregation of the
 * ledger; rows obey the same hierarchy, sign, currency and dimension rules in every column.
 */

export interface StatementColumn {
  key: 'current' | 'comparison';
  label: string;
  accounts: readonly ReportAccount[];
}

export interface StatementRow {
  rowType: 'account' | 'computed';
  key: string;
  accountId: string | null;
  code: string | null;
  name: string;
  accountType: AccountType | null;
  subtype: AccountSubtype | null;
  level: number;
  isLeaf: boolean;
  archived: boolean;
  /** Parent subtotal covering only this section's descendants (S3-11). */
  partial: boolean;
  /** One natural-sign base amount per column. */
  amounts: string[];
  /** Account-currency amounts for foreign-currency leaves (S3-15); never rolled up. */
  accountCurrency: { code: string; amounts: string[] } | null;
  drills: (Drill | null)[];
}

export interface StatementSection {
  key: string;
  label: string;
  rows: StatementRow[];
  total: string[];
}

export interface SectionSpec {
  key: string;
  label: string;
  /** Leaf accounts belonging to the section. */
  includes: (account: ReportAccount) => boolean;
  /** Always emitted, even when empty. */
  alwaysShow: boolean;
}

export interface SectionContext {
  columns: readonly StatementColumn[];
  baseCurrency: string;
  includeZero: boolean;
  currencyView: CurrencyView;
  /** Natural-sign base figure of a leaf in one column. */
  leafAmount: (account: ReportAccount) => Decimal;
  /** Natural-sign account-currency figure of a leaf in one column. */
  leafTxnAmount: (account: ReportAccount) => Decimal;
  drill: (account: ReportAccount, columnIndex: number) => Drill | null;
}

/** The chart used for rows: current column's accounts plus any only present in the comparison. */
export function mergedChart(columns: readonly StatementColumn[]): ReportAccount[] {
  const byId = new Map<string, ReportAccount>();
  for (const column of columns)
    for (const a of column.accounts) if (!byId.has(a.id)) byId.set(a.id, a);
  return [...byId.values()];
}

export function buildSections(specs: readonly SectionSpec[], ctx: SectionContext) {
  const chartAccounts = mergedChart(ctx.columns);
  const chart = buildChart(chartAccounts);
  const lookups = ctx.columns.map((c) => new Map(c.accounts.map((a) => [a.id, a])));
  const perColumn = (account: ReportAccount, f: (a: ReportAccount) => Decimal) =>
    lookups.map((lookup) => {
      const a = lookup.get(account.id);
      return a ? f(a) : ZERO;
    });
  const addColumns = (x: Decimal[], y: Decimal[]) => x.map((v, i) => v.plus(y[i]!));
  const leaves = chartAccounts.filter((a) => a.isLeaf);

  return specs
    .map((spec) => {
      const members = leaves.filter(spec.includes);
      const visible = new Set(
        members
          .filter((a) => ctx.includeZero || perColumn(a, ctx.leafAmount).some((v) => !v.isZero()))
          .map((a) => a.id),
      );
      const rows: StatementRow[] = pruneAndRollUp(
        chart,
        visible,
        (a) => perColumn(a, ctx.leafAmount),
        addColumns,
        new Set(members.map((a) => a.id)),
      ).map(({ node, value, partial }) => {
        const a = node.account;
        const foreign =
          ctx.currencyView === 'base_and_account' &&
          a.isLeaf &&
          a.currencyCode !== ctx.baseCurrency;
        return {
          rowType: 'account',
          key: `${spec.key}:${a.id}`,
          accountId: a.id,
          code: a.code,
          name: a.name,
          accountType: a.accountType,
          subtype: a.subtype,
          level: node.depth,
          isLeaf: a.isLeaf,
          archived: a.status === 'ARCHIVED',
          partial,
          amounts: value.map(fmt),
          accountCurrency: foreign
            ? { code: a.currencyCode, amounts: perColumn(a, ctx.leafTxnAmount).map(fmt) }
            : null,
          drills: ctx.columns.map((_, i) => ctx.drill(a, i)),
        };
      });
      const total = members
        .filter((a) => visible.has(a.id))
        .reduce(
          (acc, a) => addColumns(acc, perColumn(a, ctx.leafAmount)),
          ctx.columns.map(() => ZERO),
        );
      return { spec, rows, total };
    })
    .filter((s) => s.spec.alwaysShow || s.rows.length > 0);
}

export function sectionView(s: {
  spec: SectionSpec;
  rows: StatementRow[];
  total: Decimal[];
}): StatementSection {
  return { key: s.spec.key, label: s.spec.label, rows: s.rows, total: s.total.map(fmt) };
}

export function sectionExportRows(
  sections: readonly StatementSection[],
  columnKeys: readonly string[],
): ExportRow[] {
  const values = (amounts: readonly string[]) =>
    Object.fromEntries(columnKeys.map((k, i) => [k, amounts[i] ?? null]));
  return sections.flatMap((section) => [
    {
      rowType: 'section' as const,
      section: section.key,
      level: 0,
      code: null,
      name: section.label,
      values: {},
    },
    ...section.rows.map((r) => ({
      rowType: r.rowType,
      section: section.key,
      level: r.level,
      code: r.code,
      name: r.name,
      values: values(r.amounts),
    })),
    {
      rowType: 'subtotal' as const,
      section: section.key,
      level: 0,
      code: null,
      name: `Total ${section.label}`,
      values: values(section.total),
    },
  ]);
}
