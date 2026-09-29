import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import {
  formatDateTime,
  STATUS_LABELS,
  useImportCatalog,
  useOrg,
  type DateFormat,
  type DecimalSeparator,
  type ImportBatch,
  type ImportDomainKey,
} from './api';

/** Import history and the start of a new import (S6-44). */
export function ImportsPage() {
  const org = useOrg();
  const navigate = useNavigate();
  const catalog = useImportCatalog();
  const history = useQuery({
    queryKey: ['imports', org],
    queryFn: () => api.get<ImportBatch[]>('/imports?limit=50'),
  });
  // Other pages may preselect a domain (e.g. opening balances: ?domain=opening_balances).
  const [searchParams] = useSearchParams();
  const [domain, setDomain] = useState<ImportDomainKey | ''>(
    (searchParams.get('domain') as ImportDomainKey | null) ?? '',
  );
  const [dateFormat, setDateFormat] = useState<DateFormat>('YYYY-MM-DD');
  const [decimalSeparator, setDecimalSeparator] = useState<DecimalSeparator>('.');
  const create = useApiMutation(() =>
    api.post<ImportBatch>('/imports', { domain, options: { dateFormat, decimalSeparator } }),
  );

  return (
    <>
      <PageHeader
        title="Import"
        description="Bring in accounts, contacts, dimension values, exchange rates and draft journals from CSV files."
      />
      <Card title="New import">
        {catalog.isPending ? (
          <Spinner label="Loading import types" />
        ) : catalog.data?.length ? (
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(undefined, {
                onSuccess: (batch) => void navigate(`/imports/${batch.id}`),
              });
            }}
          >
            <div className="field">
              <label htmlFor="import-domain">What to import</label>
              <select
                id="import-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value as ImportDomainKey)}
              >
                <option value="">Choose…</option>
                {catalog.data.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="import-date-format">Dates in the file</label>
              <select
                id="import-date-format"
                value={dateFormat}
                onChange={(e) => setDateFormat(e.target.value as DateFormat)}
              >
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="import-decimal">Decimal separator</label>
              <select
                id="import-decimal"
                value={decimalSeparator}
                onChange={(e) => setDecimalSeparator(e.target.value as DecimalSeparator)}
              >
                <option value=".">Point (1,234.56)</option>
                <option value=",">Comma (1.234,56)</option>
              </select>
            </div>
            <div className="actions">
              <Button type="submit" disabled={!domain} busy={create.isPending}>
                Start import
              </Button>
            </div>
          </form>
        ) : (
          <p className="muted">You don't have permission to import anything here.</p>
        )}
        <ErrorAlert error={create.error ?? catalog.error} />
        <p className="muted">
          Files are CSV (UTF-8), up to 25 MB and 25,000 rows. Every row is checked before anything
          is imported, and an import either completes fully or not at all.
        </p>
      </Card>
      <Card title="Recent imports">
        {history.isPending ? (
          <Spinner label="Loading imports" />
        ) : history.isError ? (
          <ErrorAlert error={history.error} />
        ) : history.data.length === 0 ? (
          <p className="muted">No imports yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Type</th>
                  <th>File</th>
                  <th>Status</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((b) => (
                  <tr key={b.id}>
                    <td>
                      <Link to={`/imports/${b.id}`}>{formatDateTime(b.createdAt)}</Link>
                    </td>
                    <td>{b.domainLabel}</td>
                    <td>{b.fileName ?? '—'}</td>
                    <td>
                      <span className={`badge badge--import-${b.status}`}>
                        {STATUS_LABELS[b.status]}
                      </span>
                    </td>
                    <td>{b.counts.total || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
