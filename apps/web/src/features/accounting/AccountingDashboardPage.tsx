import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { AccountingPage, journalLabel, StatusBadge, useOrgKey } from './shared';
import type { Journal, Period } from './types';
import { useT } from '../../i18n/i18n';

interface Dashboard {
  isSetUp: boolean;
  baseCurrency?: string;
  fiscalYear?: { name: string; startDate: string; endDate: string } | null;
  period?: Period | null;
  journals?: {
    recent: Journal[];
    draftCount: number;
    drafts: Journal[];
    pendingApprovalCount: number;
    pendingApprovals: Journal[];
    recentPosted: Journal[];
  } | null;
}

function JournalList({ journals }: { journals: Journal[] }) {
  const t = useT();
  if (journals.length === 0) return <p className="muted">{t('acct.dash.none')}</p>;
  return (
    <ul className="plain-list">
      {journals.map((j) => (
        <li key={j.id}>
          <Link to={`/accounting/journals/${j.id}`}>{journalLabel(j)}</Link>{' '}
          <StatusBadge status={j.status} /> {j.entryDate ?? ''} {j.description}{' '}
          {j.totalDebit ? (
            <span className="muted">
              {formatAmount(j.totalDebit, j.currency)} {j.currency}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function AccountingDashboardPage() {
  const t = useT();
  const org = useOrgKey();
  const dashboard = useQuery({
    queryKey: ['accounting-dashboard', org],
    queryFn: () => api.get<Dashboard>('/accounting/dashboard'),
  });

  return (
    <>
      <PageHeader title={t('acct.dash.title')} description={t('acct.dash.description')} />
      <AccountingPage>
        {dashboard.isPending ? (
          <Spinner label={t('acct.dash.loading')} />
        ) : dashboard.isError ? (
          <ErrorAlert error={dashboard.error} />
        ) : (
          <>
            <div className="grid">
              <Card title={t('acct.dash.fiscalYear')}>
                <p>
                  {dashboard.data.fiscalYear
                    ? dashboard.data.fiscalYear.name
                    : t('acct.dash.noFiscalYear')}
                </p>
                <p className="muted">
                  {t('acct.dash.baseCurrency', { currency: dashboard.data.baseCurrency ?? '' })}
                </p>
              </Card>
              <Card title={t('acct.dash.period')}>
                {dashboard.data.period ? (
                  <p>
                    {dashboard.data.period.name}{' '}
                    <StatusBadge status={dashboard.data.period.status} />
                    <br />
                    <span className="muted">
                      {dashboard.data.period.startDate} – {dashboard.data.period.endDate}
                    </span>
                  </p>
                ) : (
                  <p className="muted">{t('acct.dash.noPeriod')}</p>
                )}
              </Card>
              {dashboard.data.journals ? (
                <Card title={t('acct.dash.workload')}>
                  <p>
                    <Link to="/accounting/journals/drafts">
                      {t('acct.dash.drafts', { count: dashboard.data.journals.draftCount })}
                    </Link>
                    <br />
                    <Link to="/accounting/journals/approvals">
                      {t('acct.dash.pending', {
                        count: dashboard.data.journals.pendingApprovalCount,
                      })}
                    </Link>
                  </p>
                </Card>
              ) : null}
            </div>
            {dashboard.data.journals ? (
              <>
                <Card title={t('acct.dash.pendingCard')}>
                  <JournalList journals={dashboard.data.journals.pendingApprovals} />
                </Card>
                <Card title={t('acct.dash.draftCard')}>
                  <JournalList journals={dashboard.data.journals.drafts} />
                </Card>
                <Card title={t('acct.dash.recentCard')}>
                  <JournalList journals={dashboard.data.journals.recentPosted} />
                </Card>
              </>
            ) : null}
          </>
        )}
      </AccountingPage>
    </>
  );
}
