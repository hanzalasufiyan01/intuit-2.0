import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ExportButton } from '../data-exchange/ExportButton';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { Permission, usePermission } from '../../permissions/permissions';
import { Alert } from '../../shared/ui/Alert';
import { AccountingPage, useAccounts, useDimensions, useOrgKey } from './shared';
import type { LedgerResult } from './types';

/** General Ledger: a view over posted journal lines (base-currency balances). */
export function LedgerPage() {
  const org = useOrgKey();
  const accounts = useAccounts();
  const canViewDimensions = usePermission(Permission.DimensionsView);
  const dimensions = useDimensions(canViewDimensions);
  // Drill-down from a report arrives with its filters in the URL (S3-19).
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState({
    accountId: searchParams.get('accountId') ?? '',
    fromDate: searchParams.get('fromDate') ?? '',
    toDate: searchParams.get('toDate') ?? '',
  });
  const openingBasis = searchParams.get('openingBasis') === 'fiscal_year' ? 'fiscal_year' : '';
  // Dimension type id -> value id chosen here; values from the URL apply to their own type
  // until changed, so there is never more than one value per type.
  const urlValueIds = (searchParams.get('dimensionValueIds') ?? '').split(',').filter(Boolean);
  const [chosen, setDimensionFilter] = useState<Record<string, string>>({});
  const dimensionFilter: Record<string, string> = dimensions.data
    ? Object.fromEntries(
        dimensions.data.map((type) => [
          type.id,
          chosen[type.id] ?? type.values.find((v) => urlValueIds.includes(v.id))?.id ?? '',
        ]),
      )
    : {};
  const dimensionValueIds = dimensions.data
    ? Object.values(dimensionFilter).filter(Boolean).join(',')
    : urlValueIds.join(',');
  const params = new URLSearchParams(
    Object.entries({ ...filter, dimensionValueIds, openingBasis }).filter(([, v]) => v),
  );
  const ledger = useQuery({
    queryKey: ['accounting-ledger', org, params.toString()],
    queryFn: () => api.get<LedgerResult>(`/accounting/ledger?${params.toString()}`),
  });
  const base = ledger.data?.baseCurrency ?? '';

  return (
    <>
      <PageHeader
        title="General Ledger"
        description="Only posted journals affect the ledger. Parent accounts roll up their children."
      />
      <AccountingPage>
        <p className="actions">
          <ExportButton domain="general_ledger" params={Object.fromEntries(params)} />
        </p>
        <Card>
          <div className="form form--inline">
            <div className="field">
              <label htmlFor="ledger-account">Account</label>
              <select
                id="ledger-account"
                value={filter.accountId}
                onChange={(e) => setFilter({ ...filter, accountId: e.target.value })}
              >
                <option value="">All accounts</option>
                {(accounts.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </select>
            </div>
            <TextField
              label="From"
              type="date"
              value={filter.fromDate}
              onChange={(e) => setFilter({ ...filter, fromDate: e.target.value })}
            />
            <TextField
              label="To"
              type="date"
              value={filter.toDate}
              onChange={(e) => setFilter({ ...filter, toDate: e.target.value })}
            />
            {(dimensions.data ?? []).map((type) => (
              <div className="field" key={type.id}>
                <label htmlFor={`ledger-dimension-${type.id}`}>{type.name}</label>
                <select
                  id={`ledger-dimension-${type.id}`}
                  value={dimensionFilter[type.id] ?? ''}
                  onChange={(e) => setDimensionFilter({ ...chosen, [type.id]: e.target.value })}
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
          </div>
        </Card>
        <Card>
          {ledger.isPending ? (
            <Spinner label="Loading ledger" />
          ) : ledger.isError ? (
            <ErrorAlert error={ledger.error} />
          ) : (
            <>
              {ledger.data.taggedActivityOnly ? (
                <Alert tone="info">
                  Tagged activity only:{' '}
                  {(ledger.data.dimensionFilter ?? [])
                    .map((d) => `${d.typeName} = ${d.valueName}`)
                    .join(', ')}
                  . Untagged lines are excluded, so balances are not complete account balances.
                </Alert>
              ) : null}
              {ledger.data.openingBalance !== null ? (
                <p>
                  Opening balance:{' '}
                  <strong>
                    {formatAmount(ledger.data.openingBalance, base)} {base}
                  </strong>
                </p>
              ) : null}
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Journal</th>
                    <th>Account</th>
                    <th>Description</th>
                    <th>Transaction</th>
                    <th>Debit ({base})</th>
                    <th>Credit ({base})</th>
                    {filter.accountId ? <th>Balance</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.rows.map((r) => (
                    <tr key={`${r.journalId}-${r.lineNumber}`}>
                      <td>{r.entryDate}</td>
                      <td>
                        <Link to={`/accounting/journals/${r.journalId}`}>
                          JE-{String(r.journalNumber).padStart(6, '0')}
                        </Link>
                      </td>
                      <td>
                        {r.accountCode} {r.accountName}
                      </td>
                      <td>{r.journalDescription}</td>
                      <td className="muted">
                        {formatAmount(r.debit ?? r.credit, r.currency)} {r.currency}
                      </td>
                      <td>{formatAmount(r.baseDebit, base)}</td>
                      <td>{formatAmount(r.baseCredit, base)}</td>
                      {filter.accountId ? <td>{formatAmount(r.runningBalance, base)}</td> : null}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={5}>Totals</th>
                    <th>{formatAmount(ledger.data.totals.baseDebit, base)}</th>
                    <th>{formatAmount(ledger.data.totals.baseCredit, base)}</th>
                    {filter.accountId ? <th /> : null}
                  </tr>
                </tfoot>
              </table>
              {ledger.data.truncated ? (
                <p className="muted">Showing the first rows only; narrow the date range.</p>
              ) : null}
            </>
          )}
        </Card>
      </AccountingPage>
    </>
  );
}
