import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { ExportButton } from '../data-exchange/ExportButton';
import { Spinner } from '../../shared/ui/Spinner';
import { AppliedSteps, describeFacts } from '../approvals/conditions';
import { AccountingPage, journalLabel, StatusBadge, useOrgKey } from './shared';
import type { ApprovalRequestSummary, Journal, JournalStatus } from './types';
import { useT, type MessageKey } from '../../i18n/i18n';

export type JournalView = 'all' | 'drafts' | 'approvals' | 'posted';

const VIEWS: Record<
  JournalView,
  { title: MessageKey; statuses: JournalStatus[] | null; description: MessageKey }
> = {
  all: {
    title: 'accounting.journalsPage.view.all.title',
    statuses: null,
    description: 'accounting.journalsPage.view.all.description',
  },
  drafts: {
    title: 'accounting.journalsPage.view.drafts.title',
    statuses: ['DRAFT'],
    description: 'accounting.journalsPage.view.drafts.description',
  },
  approvals: {
    title: 'accounting.journalsPage.view.approvals.title',
    statuses: ['PENDING_APPROVAL'],
    description: 'accounting.journalsPage.view.approvals.description',
  },
  posted: {
    title: 'accounting.journalsPage.view.posted.title',
    statuses: ['POSTED', 'REVERSED'],
    description: 'accounting.journalsPage.view.posted.description',
  },
};

/** Journal approval requests, with the facts and steps that made approval required (S10). */
function JournalApprovalRequests() {
  const t = useT();
  const org = useOrgKey();
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
  });
  const journals = (requests.data ?? []).filter((r) => r.actionKey === 'accounting.journal.post');
  if (journals.length === 0) return null;
  return (
    <Card title={t('accounting.journalsPage.whyTheseJournalsNeedApproval')}>
      <table className="table">
        <thead>
          <tr>
            <th>{t('accounting.journalsPage.journal')}</th>
            <th>{t('accounting.journalsPage.document')}</th>
            <th>{t('accounting.journalsPage.stepsThatApply')}</th>
            <th>{t('accounting.journalsPage.progress')}</th>
          </tr>
        </thead>
        <tbody>
          {journals.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/accounting/journals/${r.subjectId}`}>
                  {t('accounting.journalsPage.openJournal')}
                </Link>
              </td>
              <td>{describeFacts(r.facts, t)}</td>
              <td>
                <AppliedSteps steps={r.appliedSteps} baseCurrency={r.facts?.baseCurrency ?? null} />
              </td>
              <td>
                {r.progress
                  .map((s) => `${s.name}: ${s.approvals}/${s.requiredApprovals}`)
                  .join(', ')}
                {r.canDecide ? '' : t('accounting.journalsPage.youAreNotAnEligible')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Other approval requests (e.g. period reopening) the user can act on. */
function OtherApprovalRequests() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
  });
  const decide = useApiMutation((input: { id: string; decision: 'approve' | 'reject' }) =>
    sensitive(() => api.post(`/approvals/requests/${input.id}/${input.decision}`, {})),
  );
  const others = (requests.data ?? []).filter((r) => r.actionKey !== 'accounting.journal.post');
  if (others.length === 0) return null;
  return (
    <Card title={t('accounting.journalsPage.otherApprovalRequests')}>
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>{t('accounting.journalsPage.request')}</th>
            <th>{t('accounting.journalsPage.reason')}</th>
            <th>{t('accounting.journalsPage.document')}</th>
            <th>{t('accounting.journalsPage.stepsThatApply')}</th>
            <th>{t('accounting.journalsPage.progress')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {others.map((r) => (
            <tr key={r.id}>
              <td>
                {r.actionKey === 'accounting.period.reopen' ? (
                  t('accounting.journalsPage.reopenAccountingPeriod')
                ) : r.actionKey === 'accounting.opening_balance.post' ? (
                  <Link to={`/accounting/opening-balances/${r.subjectId}`}>
                    {t('accounting.journalsPage.postOpeningBalances')}
                  </Link>
                ) : (
                  r.actionKey
                )}
              </td>
              <td>{r.reason}</td>
              <td>{describeFacts(r.facts, t)}</td>
              <td>
                <AppliedSteps steps={r.appliedSteps} baseCurrency={r.facts?.baseCurrency ?? null} />
              </td>
              <td>
                {r.progress
                  .map((s) => `${s.name}: ${s.approvals}/${s.requiredApprovals}`)
                  .join(', ')}
              </td>
              <td className="actions">
                {r.canDecide ? (
                  <>
                    <Button
                      busy={decide.isPending}
                      onClick={() =>
                        decide.mutate(
                          { id: r.id, decision: 'approve' },
                          { onSuccess: () => void queryClient.invalidateQueries() },
                        )
                      }
                    >
                      {t('accounting.journalsPage.approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        decide.mutate(
                          { id: r.id, decision: 'reject' },
                          { onSuccess: () => void queryClient.invalidateQueries() },
                        )
                      }
                    >
                      {t('accounting.journalsPage.reject')}
                    </Button>
                  </>
                ) : (
                  <span className="muted">{t('accounting.journalsPage.notEligible')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function JournalsPage({ view }: { view: JournalView }) {
  const t = useT();
  const org = useOrgKey();
  const config = VIEWS[view];
  const canApprove = usePermission(Permission.JournalsApprove);
  const canViewDimensions = usePermission(Permission.DimensionsView);
  const journals = useQuery({
    queryKey: ['accounting-journals', org, view],
    queryFn: () =>
      api.get<Journal[]>(
        `/accounting/journals?limit=200${config.statuses ? `&status=${config.statuses.join(',')}` : ''}`,
      ),
  });

  return (
    <>
      <PageHeader title={t(config.title)} description={t(config.description)} />
      <AccountingPage>
        <p className="actions">
          <ExportButton
            domain="journals"
            params={{
              statuses: config.statuses ?? ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED'],
              includeDimensions: canViewDimensions,
            }}
          />
        </p>
        <Can permission={Permission.JournalsCreate}>
          <p>
            <Link className="btn btn--primary" to="/accounting/journals/new">
              {t('accounting.journalsPage.newJournal')}
            </Link>
          </p>
        </Can>
        {view === 'approvals' && canApprove ? <JournalApprovalRequests /> : null}
        {view === 'approvals' && canApprove ? <OtherApprovalRequests /> : null}
        <Card>
          {journals.isPending ? (
            <Spinner label={t('accounting.journalsPage.loadingJournals')} />
          ) : journals.isError ? (
            <ErrorAlert error={journals.error} />
          ) : journals.data.length === 0 ? (
            <p className="muted">{t('accounting.journalsPage.noJournals')}</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('accounting.journalsPage.journal')}</th>
                  <th>{t('accounting.journalsPage.date')}</th>
                  <th>{t('accounting.journalsPage.description')}</th>
                  <th>{t('accounting.journalsPage.amount')}</th>
                  <th>{t('accounting.journalsPage.status')}</th>
                </tr>
              </thead>
              <tbody>
                {journals.data.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/accounting/journals/${j.id}`}>{journalLabel(j)}</Link>
                    </td>
                    <td>{j.entryDate}</td>
                    <td>{j.description}</td>
                    <td>
                      {j.totalDebit
                        ? `${formatAmount(j.totalDebit, j.currency)} ${j.currency}`
                        : j.currency}
                    </td>
                    <td>
                      <StatusBadge status={j.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </AccountingPage>
    </>
  );
}
