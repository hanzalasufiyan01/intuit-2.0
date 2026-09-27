import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { AccountingPage, journalLabel, StatusBadge, useOrgKey } from './shared';
import type { Journal, Period } from './types';

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
  if (journals.length === 0) return <p className="muted">None.</p>;
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
  const org = useOrgKey();
  const dashboard = useQuery({
    queryKey: ['accounting-dashboard', org],
    queryFn: () => api.get<Dashboard>('/accounting/dashboard'),
  });

  return (
    <>
      <PageHeader
        title="Accounting"
        description="General ledger foundation for this organization."
      />
      <AccountingPage>
        {dashboard.isPending ? (
          <Spinner label="Loading accounting dashboard" />
        ) : dashboard.isError ? (
          <ErrorAlert error={dashboard.error} />
        ) : (
          <>
            <div className="grid">
              <Card title="Current fiscal year">
                <p>
                  {dashboard.data.fiscalYear
                    ? dashboard.data.fiscalYear.name
                    : 'No fiscal year covers today.'}
                </p>
                <p className="muted">Base currency: {dashboard.data.baseCurrency}</p>
              </Card>
              <Card title="Current period">
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
                  <p className="muted">No period.</p>
                )}
              </Card>
              {dashboard.data.journals ? (
                <Card title="Workload">
                  <p>
                    <Link to="/accounting/journals/drafts">
                      {dashboard.data.journals.draftCount} draft(s)
                    </Link>
                    <br />
                    <Link to="/accounting/journals/approvals">
                      {dashboard.data.journals.pendingApprovalCount} pending approval
                    </Link>
                  </p>
                </Card>
              ) : null}
            </div>
            {dashboard.data.journals ? (
              <>
                <Card title="Pending approvals">
                  <JournalList journals={dashboard.data.journals.pendingApprovals} />
                </Card>
                <Card title="Draft journals">
                  <JournalList journals={dashboard.data.journals.drafts} />
                </Card>
                <Card title="Recent posted activity">
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
