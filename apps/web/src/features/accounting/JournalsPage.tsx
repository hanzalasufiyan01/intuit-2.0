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

export type JournalView = 'all' | 'drafts' | 'approvals' | 'posted';

const VIEWS: Record<
  JournalView,
  { title: string; statuses: JournalStatus[] | null; description: string }
> = {
  all: { title: 'Journals', statuses: null, description: 'All journals in this organization.' },
  drafts: {
    title: 'Draft Journals',
    statuses: ['DRAFT'],
    description: 'Journals still being prepared.',
  },
  approvals: {
    title: 'Approval Queue',
    statuses: ['PENDING_APPROVAL'],
    description: 'Submitted journals waiting for approval or posting.',
  },
  posted: {
    title: 'Posted Journals',
    statuses: ['POSTED', 'REVERSED'],
    description: 'Posted journals are immutable; corrections use reversals.',
  },
};

/** Journal approval requests, with the facts and steps that made approval required (S10). */
function JournalApprovalRequests() {
  const org = useOrgKey();
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
  });
  const journals = (requests.data ?? []).filter((r) => r.actionKey === 'accounting.journal.post');
  if (journals.length === 0) return null;
  return (
    <Card title="Why these journals need approval">
      <table className="table">
        <thead>
          <tr>
            <th>Journal</th>
            <th>Document</th>
            <th>Steps that apply</th>
            <th>Progress</th>
          </tr>
        </thead>
        <tbody>
          {journals.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/accounting/journals/${r.subjectId}`}>Open journal</Link>
              </td>
              <td>{describeFacts(r.facts)}</td>
              <td>
                <AppliedSteps steps={r.appliedSteps} baseCurrency={r.facts?.baseCurrency ?? null} />
              </td>
              <td>
                {r.progress
                  .map((s) => `${s.name}: ${s.approvals}/${s.requiredApprovals}`)
                  .join(', ')}
                {r.canDecide ? '' : ' (you are not an eligible approver)'}
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
    <Card title="Other approval requests">
      <ErrorAlert error={decide.error} />
      <table className="table">
        <thead>
          <tr>
            <th>Request</th>
            <th>Reason</th>
            <th>Document</th>
            <th>Steps that apply</th>
            <th>Progress</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {others.map((r) => (
            <tr key={r.id}>
              <td>
                {r.actionKey === 'accounting.period.reopen' ? (
                  'Reopen accounting period'
                ) : r.actionKey === 'accounting.opening_balance.post' ? (
                  <Link to={`/accounting/opening-balances/${r.subjectId}`}>
                    Post opening balances
                  </Link>
                ) : (
                  r.actionKey
                )}
              </td>
              <td>{r.reason}</td>
              <td>{describeFacts(r.facts)}</td>
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
                      Approve
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
                      Reject
                    </Button>
                  </>
                ) : (
                  <span className="muted">Not eligible</span>
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
      <PageHeader title={config.title} description={config.description} />
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
              New journal
            </Link>
          </p>
        </Can>
        {view === 'approvals' && canApprove ? <JournalApprovalRequests /> : null}
        {view === 'approvals' && canApprove ? <OtherApprovalRequests /> : null}
        <Card>
          {journals.isPending ? (
            <Spinner label="Loading journals" />
          ) : journals.isError ? (
            <ErrorAlert error={journals.error} />
          ) : journals.data.length === 0 ? (
            <p className="muted">No journals.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Journal</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Amount</th>
                  <th>Status</th>
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
