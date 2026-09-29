import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, type ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { TextField } from '../../shared/ui/TextField';
import { useDimensions, useOrgKey } from '../accounting/shared';
import type { FiscalYear, Period } from '../accounting/types';
import type { DimensionFilterEntry, Drill, Integrity, ReportWarning } from './types';

export type ReportKind = 'trial-balance' | 'profit-and-loss' | 'balance-sheet';

/** Report filters live in the URL, so drill-down links and reloads keep them. */
export function useReportQuery<T>(kind: ReportKind) {
  const org = useOrgKey();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.toString();
  const result = useQuery<T, ApiError>({
    queryKey: ['report', kind, org, query],
    queryFn: () => api.get<T>(`/accounting/reports/${kind}${query ? `?${query}` : ''}`),
    retry: false,
  });
  return { result, searchParams, setSearchParams };
}

const FIELDS: Record<ReportKind, string[]> = {
  'trial-balance': ['from', 'to', 'periodId', 'fiscalYearId'],
  'profit-and-loss': [
    'from',
    'to',
    'periodId',
    'fiscalYearId',
    'compare',
    'compareFrom',
    'compareTo',
  ],
  'balance-sheet': ['asOf', 'periodId', 'fiscalYearId', 'compare', 'compareAsOf'],
};

export function ReportFilters({
  kind,
  searchParams,
  onApply,
}: {
  kind: ReportKind;
  searchParams: URLSearchParams;
  onApply: (params: URLSearchParams) => void;
}) {
  const org = useOrgKey();
  const canViewPeriods = usePermission(Permission.PeriodsView);
  const canViewDimensions = usePermission(Permission.DimensionsView);
  const dimensions = useDimensions(canViewDimensions);
  const fiscalYears = useQuery({
    queryKey: ['accounting-fiscal-years', org],
    queryFn: () => api.get<FiscalYear[]>('/accounting/fiscal-years'),
    enabled: canViewPeriods,
  });
  const periods = useQuery({
    queryKey: ['accounting-periods', org],
    queryFn: () => api.get<Period[]>('/accounting/periods'),
    enabled: canViewPeriods,
  });
  const initial = Object.fromEntries(
    [...FIELDS[kind], 'includeZero', 'currencyView', 'dimensionValueIds'].map((k) => [
      k,
      searchParams.get(k) ?? '',
    ]),
  );
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [dims, setDims] = useState<Record<string, string>>(() => {
    const selected = (searchParams.get('dimensionValueIds') ?? '').split(',').filter(Boolean);
    const map: Record<string, string> = {};
    for (const type of dimensions.data ?? []) {
      const v = type.values.find((x) => selected.includes(x.id));
      if (v) map[type.id] = v.id;
    }
    return map;
  });
  const set = (key: string, value: string) => setForm({ ...form, [key]: value });

  const apply = (event: FormEvent) => {
    event.preventDefault();
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (v && k !== 'dimensionValueIds') next.set(k, v);
    }
    const values = Object.values(dims).filter(Boolean);
    if (values.length) next.set('dimensionValueIds', values.join(','));
    onApply(next);
  };

  const dateField = (key: string, label: string) => (
    <TextField
      key={key}
      label={label}
      type="date"
      value={form[key] ?? ''}
      onChange={(e) => set(key, e.target.value)}
    />
  );
  const usesRange = kind !== 'balance-sheet';

  return (
    <form className="form form--inline" onSubmit={apply} aria-label="Report filters">
      {usesRange ? [dateField('from', 'From'), dateField('to', 'To')] : dateField('asOf', 'As of')}
      {canViewPeriods ? (
        <>
          <div className="field">
            <label htmlFor={`${kind}-fy`}>Fiscal year</label>
            <select
              id={`${kind}-fy`}
              value={form.fiscalYearId ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  fiscalYearId: e.target.value,
                  periodId: '',
                  from: '',
                  to: '',
                  asOf: '',
                })
              }
            >
              <option value="">(dates)</option>
              {(fiscalYears.data ?? []).map((fy) => (
                <option key={fy.id} value={fy.id}>
                  {fy.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${kind}-period`}>Period</label>
            <select
              id={`${kind}-period`}
              value={form.periodId ?? ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  periodId: e.target.value,
                  fiscalYearId: '',
                  from: '',
                  to: '',
                  asOf: '',
                })
              }
            >
              <option value="">(dates)</option>
              {(periods.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </>
      ) : null}
      {kind !== 'trial-balance' ? (
        <div className="field">
          <label htmlFor={`${kind}-compare`}>Compare with</label>
          <select
            id={`${kind}-compare`}
            value={form.compare ?? ''}
            onChange={(e) => set('compare', e.target.value)}
          >
            <option value="">No comparison</option>
            <option value="previous_period">Previous period</option>
            <option value="previous_year">Previous year</option>
            <option value="custom">Custom</option>
          </select>
        </div>
      ) : null}
      {form.compare === 'custom'
        ? kind === 'balance-sheet'
          ? dateField('compareAsOf', 'Compare as of')
          : [dateField('compareFrom', 'Compare from'), dateField('compareTo', 'Compare to')]
        : null}
      {(dimensions.data ?? [])
        .filter((t) => t.status === 'ACTIVE' || dims[t.id])
        .map((type) => (
          <div className="field" key={type.id}>
            <label htmlFor={`${kind}-dim-${type.id}`}>{type.name}</label>
            <select
              id={`${kind}-dim-${type.id}`}
              value={dims[type.id] ?? ''}
              onChange={(e) => setDims({ ...dims, [type.id]: e.target.value })}
            >
              <option value="">All</option>
              {type.values.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        ))}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.includeZero === 'true'}
          onChange={(e) => set('includeZero', e.target.checked ? 'true' : '')}
        />{' '}
        Include zero balances
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={form.currencyView === 'base_and_account'}
          onChange={(e) => set('currencyView', e.target.checked ? 'base_and_account' : '')}
        />{' '}
        Show account currency
      </label>
      <Button type="submit">Run report</Button>
    </form>
  );
}

export function IntegrityPanel({
  integrity,
  currency,
}: {
  integrity: Integrity;
  currency: string;
}) {
  if (integrity.status === 'BALANCED') {
    return (
      <Alert tone="success">
        <span data-testid="integrity">Balanced</span> — all integrity checks pass.
      </Alert>
    );
  }
  if (integrity.status === 'NOT_APPLICABLE') {
    return (
      <Alert tone="info">
        <span data-testid="integrity">Balancing checks not applicable</span>: tagged activity only
        is not expected to balance.
      </Alert>
    );
  }
  return (
    <Alert>
      <span data-testid="integrity">Out of balance</span>. The ledger data is shown unchanged;
      contact support.
      <ul>
        {integrity.checks
          .filter((c) => c.status === 'FAIL')
          .map((c) => (
            <li key={c.name}>
              {c.name.replaceAll('_', ' ')}: difference {formatAmount(c.difference, currency)}
            </li>
          ))}
      </ul>
    </Alert>
  );
}

export function ReportNotices({
  warnings,
  taggedActivityOnly,
  dimensionFilter,
}: {
  warnings: ReportWarning[];
  taggedActivityOnly: boolean;
  dimensionFilter: DimensionFilterEntry[];
}) {
  return (
    <>
      {taggedActivityOnly ? (
        <Alert tone="info">
          Tagged activity only:{' '}
          {dimensionFilter.map((d) => `${d.typeName} = ${d.valueName}`).join(', ')}. Untagged
          activity is excluded.
        </Alert>
      ) : null}
      {warnings.map((w) => (
        <Alert key={w.code} tone="info">
          {w.message}
        </Alert>
      ))}
    </>
  );
}

/** Expand/collapse for depth-first rows with levels. */
export function useCollapse() {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const visible = <R extends { key: string; level: number }>(rows: readonly R[]) => {
    const out: R[] = [];
    let hideBelow: number | null = null;
    for (const row of rows) {
      if (hideBelow !== null && row.level > hideBelow) continue;
      hideBelow = collapsed.has(row.key) ? row.level : null;
      out.push(row);
    }
    return out;
  };
  return {
    collapsed,
    toggle,
    visible,
    collapseAll: (keys: string[]) => setCollapsed(new Set(keys)),
    expandAll: () => setCollapsed(new Set()),
  };
}

/** Drill-down link (S3-19); the server authorizes every level again. */
export function DrillLink({
  drill,
  dimensionValueIds,
  children,
}: {
  drill: Drill | null;
  dimensionValueIds: string | null;
  children: ReactNode;
}) {
  const canViewLedger = usePermission(Permission.LedgerView);
  if (!drill) return <>{children}</>;
  if (drill.kind === 'ledger') {
    if (!canViewLedger) return <>{children}</>;
    const params = new URLSearchParams({ accountId: drill.accountId, toDate: drill.toDate });
    if (drill.fromDate) params.set('fromDate', drill.fromDate);
    if (drill.openingBasis === 'fiscal_year') params.set('openingBasis', 'fiscal_year');
    if (dimensionValueIds) params.set('dimensionValueIds', dimensionValueIds);
    return <Link to={`/accounting/ledger?${params.toString()}`}>{children}</Link>;
  }
  const params = new URLSearchParams({ from: drill.from ?? '1900-01-01', to: drill.to });
  if (dimensionValueIds) params.set('dimensionValueIds', dimensionValueIds);
  return <Link to={`/accounting/reports/profit-and-loss?${params.toString()}`}>{children}</Link>;
}

export function ReportError({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <Alert>
      {error.message}
      {error.code === 'DESIGNATION_REQUIRED' ? (
        <>
          {' '}
          <Link to="/accounting/designations">Designate system accounts</Link>
        </>
      ) : null}
    </Alert>
  );
}
