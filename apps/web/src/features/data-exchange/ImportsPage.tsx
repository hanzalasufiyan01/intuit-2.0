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
  useImportCatalog,
  useOrg,
  type DateFormat,
  type DecimalSeparator,
  type ImportBatch,
  type ImportDomainKey,
} from './api';
import { useT } from '../../i18n/i18n';

/** Import history and the start of a new import (S6-44). */
export function ImportsPage() {
  const t = useT();
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
      <PageHeader title={t('imports.title')} description={t('imports.description')} />
      <Card title={t('imports.new')}>
        {catalog.isPending ? (
          <Spinner label={t('imports.loadingTypes')} />
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
              <label htmlFor="import-domain">{t('imports.what')}</label>
              <select
                id="import-domain"
                value={domain}
                onChange={(e) => setDomain(e.target.value as ImportDomainKey)}
              >
                <option value="">{t('common.choose')}</option>
                {catalog.data.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="import-date-format">{t('imports.dates')}</label>
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
              <label htmlFor="import-decimal">{t('imports.decimal')}</label>
              <select
                id="import-decimal"
                value={decimalSeparator}
                onChange={(e) => setDecimalSeparator(e.target.value as DecimalSeparator)}
              >
                <option value=".">{t('imports.point')}</option>
                <option value=",">{t('imports.comma')}</option>
              </select>
            </div>
            <div className="actions">
              <Button type="submit" disabled={!domain} busy={create.isPending}>
                {t('imports.start')}
              </Button>
            </div>
          </form>
        ) : (
          <p className="muted">{t('imports.noPermission')}</p>
        )}
        <ErrorAlert error={create.error ?? catalog.error} />
        <p className="muted">{t('imports.limits')}</p>
      </Card>
      <Card title={t('imports.recent')}>
        {history.isPending ? (
          <Spinner label={t('imports.loading')} />
        ) : history.isError ? (
          <ErrorAlert error={history.error} />
        ) : history.data.length === 0 ? (
          <p className="muted">{t('imports.none')}</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('imports.started')}</th>
                  <th>{t('imports.type')}</th>
                  <th>{t('imports.file')}</th>
                  <th>{t('imports.status')}</th>
                  <th>{t('imports.rows')}</th>
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
                        {t(`imports.status.${b.status}`)}
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
