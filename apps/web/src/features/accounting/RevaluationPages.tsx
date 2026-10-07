import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import type { ApprovalRequestSummary } from './types';
import { AccountingPage, useOrgKey } from './shared';

/**
 * Foreign-currency revaluation (Phase 4B-10; ADR 0004 P4-52, Decision 9): preview the calculation
 * at a date, post it, or submit it for approval when a policy applies; the approved run is posted
 * separately and must equal the approved calculation. A posted run is cancelled with a reason.
 * The server authorizes and validates everything; this page only guides.
 */

const REVALUATION_POST_ACTION = 'accounting.revaluation.post';

type RunStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'POSTED' | 'REVERSED';

interface RunSummary {
  id: string;
  status: RunStatus;
  method: string;
  revaluationDate: string;
  reversalDate: string | null;
  baseCurrency: string;
  version: number;
  netAdjustment: string;
  totalGain: string;
  totalLoss: string;
  lineCount: number;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversalReason: string | null;
  approvalRequestId: string | null;
}

interface RunLine {
  lineNumber: number;
  exposureKind: 'ACCOUNT' | 'DOCUMENT';
  accountId: string;
  currency: string;
  document: { module: string; type: string; id: string } | null;
  foreignBalance: string;
  carryingBase: string;
  rate: string;
  rateDate: string;
  rateSource: string;
  revaluedBase: string;
  adjustment: string;
}

interface RunDetail extends RunSummary {
  journalCount: number;
  lines: RunLine[];
  journals: {
    journalId: string;
    number: string | null;
    currency: string;
    role: string;
    status: string;
    entryDate: string | null;
  }[];
  approval?: {
    required: boolean;
    requestId: string | null;
    requestStatus: 'pending' | 'approved' | 'rejected' | 'withdrawn' | null;
    readyToIssue: boolean;
    approvalOutdated: boolean;
    appliedSteps: { order: number; name: string; requiredApprovals: number }[];
  };
}

interface Preview {
  approvalRequired: boolean;
  revaluationDate: string;
  reversalDate: string;
  errors: { path: string; message: string }[];
  warnings: { path: string; message: string }[];
  lines: {
    lineNumber: number;
    exposureKind: 'ACCOUNT' | 'DOCUMENT';
    accountCode: string;
    currency: string;
    foreignBalance: string;
    carryingBase: string;
    rate: string;
    revaluedBase: string;
    adjustment: string;
  }[];
  totals: { gain: string; loss: string; net: string };
}

const STATUS_LABEL: Record<RunStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Awaiting approval',
  POSTED: 'Posted',
  REVERSED: 'Cancelled',
};

function StatusLabel({ status }: { status: RunStatus }) {
  return <span className={`badge badge--${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span>;
}

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// List, preview and post
// ---------------------------------------------------------------------------

export function RevaluationsPage() {
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canPost = usePermission(Permission.JournalsPost);
  const [date, setDate] = useState(today());
  const runs = useQuery({
    queryKey: ['revaluations', org],
    queryFn: () => api.get<RunSummary[]>('/accounting/revaluations'),
  });
  const preview = useApiMutation((revaluationDate: string) =>
    api.post<Preview>('/accounting/revaluations/preview', { revaluationDate }),
  );
  const sensitive = useSensitiveAction();
  const post = useApiMutation((revaluationDate: string) =>
    sensitive(() => api.post<RunDetail>('/accounting/revaluations', { revaluationDate })),
  );
  const submit = useApiMutation((revaluationDate: string) =>
    api.post<RunDetail>('/accounting/revaluations/submit', { revaluationDate }),
  );
  const opened = (run: RunDetail) => {
    void queryClient.invalidateQueries({ queryKey: ['revaluations', org] });
    void navigate(`/accounting/revaluations/${run.id}`);
  };
  const result = preview.data;
  const blocked = result ? result.errors.length > 0 : true;
  return (
    <AccountingPage>
      <PageHeader
        title="Revaluation"
        description="Revalue foreign-currency balances and open documents at a closing rate. Each run posts a base-only journal and its reversal the next day."
      />
      <Card title="New revaluation">
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            preview.mutate(date);
          }}
        >
          <TextField
            label="Revaluation date"
            type="date"
            value={date}
            required
            onChange={(e) => setDate(e.target.value)}
          />
          <Button type="submit" busy={preview.isPending}>
            Preview
          </Button>
        </form>
        <ErrorAlert error={preview.error ?? post.error ?? submit.error} />
        {result ? (
          <>
            {result.errors.map((issue) => (
              <Alert key={`${issue.path}-${issue.message}`} tone="error">
                {issue.message}
              </Alert>
            ))}
            {result.warnings.map((issue) => (
              <Alert key={`${issue.path}-${issue.message}`} tone="info">
                {issue.message}
              </Alert>
            ))}
            {result.lines.length === 0 && result.errors.length === 0 ? (
              <p className="muted">Nothing to revalue at {result.revaluationDate}.</p>
            ) : null}
            {result.lines.length > 0 ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Currency</th>
                    <th className="num">Foreign balance</th>
                    <th className="num">Carrying ({runs.data?.[0]?.baseCurrency ?? 'base'})</th>
                    <th className="num">Rate</th>
                    <th className="num">Revalued</th>
                    <th className="num">Adjustment</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((l) => (
                    <tr key={l.lineNumber}>
                      <td>
                        {l.accountCode}
                        {l.exposureKind === 'DOCUMENT' ? ' (documents)' : ''}
                      </td>
                      <td>{l.currency}</td>
                      <td className="num">{formatAmount(l.foreignBalance, l.currency)}</td>
                      <td className="num">{l.carryingBase}</td>
                      <td className="num">{l.rate}</td>
                      <td className="num">{l.revaluedBase}</td>
                      <td className="num">{l.adjustment}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <p>
              Gain {result.totals.gain} · Loss {result.totals.loss} · Net {result.totals.net}
            </p>
            {canPost && !blocked && result.lines.length > 0 ? (
              <p className="actions">
                {result.approvalRequired ? (
                  <Button
                    busy={submit.isPending}
                    onClick={() => submit.mutate(result.revaluationDate, { onSuccess: opened })}
                  >
                    Submit for approval
                  </Button>
                ) : (
                  <Button
                    busy={post.isPending}
                    onClick={() => post.mutate(result.revaluationDate, { onSuccess: opened })}
                  >
                    Post revaluation
                  </Button>
                )}
              </p>
            ) : null}
          </>
        ) : null}
      </Card>
      <Card title="Revaluation runs">
        {runs.isPending ? (
          <Spinner label="Loading" />
        ) : runs.isError ? (
          <ErrorAlert error={runs.error} />
        ) : runs.data.length === 0 ? (
          <p className="muted">No revaluations yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Gain</th>
                <th className="num">Loss</th>
                <th className="num">Net</th>
                <th className="num">Lines</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/accounting/revaluations/${r.id}`}>{r.revaluationDate}</Link>
                  </td>
                  <td>
                    <StatusLabel status={r.status} />
                  </td>
                  <td className="num">{r.totalGain}</td>
                  <td className="num">{r.totalLoss}</td>
                  <td className="num">{r.netAdjustment}</td>
                  <td className="num">{r.lineCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </AccountingPage>
  );
}

// ---------------------------------------------------------------------------
// Detail and lifecycle
// ---------------------------------------------------------------------------

export function RevaluationDetailPage() {
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canPost = usePermission(Permission.JournalsPost);
  const canCancel = usePermission(Permission.JournalsReverse);
  const canApprove = usePermission(Permission.JournalsApprove);
  const run = useQuery({
    queryKey: ['revaluation', org, id],
    queryFn: () => api.get<RunDetail>(`/accounting/revaluations/${id}`),
  });
  const requests = useQuery({
    queryKey: ['approval-requests', org],
    queryFn: () => api.get<ApprovalRequestSummary[]>('/approvals/requests'),
    enabled: canApprove,
  });
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const refresh = (data?: RunDetail) => {
    if (data) queryClient.setQueryData(['revaluation', org, id], data);
    void queryClient.invalidateQueries({ queryKey: ['revaluation', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['revaluations', org] });
    void queryClient.invalidateQueries({ queryKey: ['approval-requests', org] });
  };
  const postApproved = useApiMutation(() =>
    sensitive(() =>
      api.post<RunDetail>(`/accounting/revaluations/${id}/post`, { version: run.data!.version }),
    ),
  );
  const withdraw = useApiMutation(() =>
    api.post(`/accounting/revaluations/${id}/withdraw`, { version: run.data!.version }),
  );
  const cancel = useApiMutation(() =>
    sensitive(() =>
      api.post<RunDetail>(`/accounting/revaluations/${id}/cancel`, {
        version: run.data!.version,
        reason: reason.trim(),
      }),
    ),
  );
  const decide = useApiMutation((input: { requestId: string; decision: 'approve' | 'reject' }) =>
    sensitive(() =>
      api.post(`/approvals/requests/${input.requestId}/${input.decision}`, {
        ...(input.decision === 'reject' ? { comment: comment.trim() } : {}),
      }),
    ),
  );

  if (run.isPending) return <Spinner label="Loading" />;
  if (run.isError) return <ErrorAlert error={run.error} />;
  const r = run.data;
  const request = (requests.data ?? []).find(
    (q) => q.actionKey === REVALUATION_POST_ACTION && q.subjectId === r.id,
  );
  const conflict =
    [postApproved.error, withdraw.error, cancel.error].find(
      (e) => e instanceof ApiError && e.code === 'VERSION_CONFLICT',
    ) !== undefined;
  return (
    <AccountingPage>
      <PageHeader
        title={`Revaluation at ${r.revaluationDate}`}
        description={`Reversal on ${r.reversalDate ?? ''}`}
      />
      <ErrorAlert error={postApproved.error ?? withdraw.error ?? cancel.error ?? decide.error} />
      {conflict ? (
        <Alert tone="info">
          This run was changed by someone else.{' '}
          <Button variant="ghost" onClick={() => void run.refetch()}>
            Reload
          </Button>
        </Alert>
      ) : null}
      <Card title="Summary" actions={<StatusLabel status={r.status} />}>
        <dl className="facts">
          <dt>Gain</dt>
          <dd>
            {r.totalGain} {r.baseCurrency}
          </dd>
          <dt>Loss</dt>
          <dd>
            {r.totalLoss} {r.baseCurrency}
          </dd>
          <dt>Net adjustment</dt>
          <dd>
            {r.netAdjustment} {r.baseCurrency}
          </dd>
          {r.reversalReason ? (
            <>
              <dt>Cancelled because</dt>
              <dd>{r.reversalReason}</dd>
            </>
          ) : null}
        </dl>
        {r.status === 'PENDING_APPROVAL' ? (
          <>
            <p>
              {r.approval?.readyToIssue
                ? 'Approved. Posting repeats the calculation and must give the same result.'
                : 'Waiting for approval before it can be posted.'}
            </p>
            <div className="actions">
              {canPost ? (
                <Button
                  disabled={!r.approval?.readyToIssue}
                  busy={postApproved.isPending}
                  onClick={() => postApproved.mutate(undefined, { onSuccess: refresh })}
                >
                  Post revaluation
                </Button>
              ) : null}
              {canPost ? (
                <Button
                  variant="secondary"
                  busy={withdraw.isPending}
                  onClick={() =>
                    withdraw.mutate(undefined, {
                      onSuccess: () => {
                        refresh();
                        void navigate('/accounting/revaluations');
                      },
                    })
                  }
                >
                  Withdraw
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </Card>

      {r.status === 'PENDING_APPROVAL' && request?.canDecide ? (
        <Card title="Your approval">
          {rejecting ? (
            <form
              className="form form--inline"
              onSubmit={(e) => {
                e.preventDefault();
                decide.mutate(
                  { requestId: request.id, decision: 'reject' },
                  {
                    onSuccess: () => {
                      refresh();
                      void navigate('/accounting/revaluations');
                    },
                  },
                );
              }}
            >
              <TextField
                label="Reason for rejecting"
                value={comment}
                required
                onChange={(e) => setComment(e.target.value)}
              />
              <Button type="submit" variant="secondary" busy={decide.isPending}>
                Reject
              </Button>
            </form>
          ) : (
            <p className="actions">
              <Button
                busy={decide.isPending}
                onClick={() =>
                  decide.mutate(
                    { requestId: request.id, decision: 'approve' },
                    { onSuccess: () => refresh() },
                  )
                }
              >
                Approve
              </Button>
              <Button variant="ghost" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            </p>
          )}
        </Card>
      ) : null}

      <Card title="Exposures">
        {r.lines.length === 0 ? (
          <p className="muted">Nothing needed revaluing.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Exposure</th>
                <th>Currency</th>
                <th className="num">Foreign balance</th>
                <th className="num">Carrying</th>
                <th className="num">Rate</th>
                <th className="num">Revalued</th>
                <th className="num">Adjustment</th>
              </tr>
            </thead>
            <tbody>
              {r.lines.map((l) => (
                <tr key={l.lineNumber}>
                  <td>{l.lineNumber}</td>
                  <td>
                    {l.document ? `${l.document.module} ${l.document.type}` : 'Account balance'}
                  </td>
                  <td>{l.currency}</td>
                  <td className="num">{formatAmount(l.foreignBalance, l.currency)}</td>
                  <td className="num">{l.carryingBase}</td>
                  <td className="num">
                    {l.rate} ({l.rateDate})
                  </td>
                  <td className="num">{l.revaluedBase}</td>
                  <td className="num">{l.adjustment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {r.journals.length > 0 ? (
        <Card title="Journals">
          <table className="table">
            <thead>
              <tr>
                <th>Journal</th>
                <th>Role</th>
                <th>Currency</th>
                <th>Date</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {r.journals.map((j) => (
                <tr key={j.journalId}>
                  <td>
                    <Link to={`/accounting/journals/${j.journalId}`}>{j.number ?? 'Journal'}</Link>
                  </td>
                  <td>{j.role.toLowerCase().replace('_', ' ')}</td>
                  <td>{j.currency}</td>
                  <td>{j.entryDate}</td>
                  <td>{j.status.toLowerCase()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {r.status === 'POSTED' && canCancel ? (
        <Card title="Cancel this revaluation">
          <p className="muted">
            Reverses the revaluation and its scheduled reversal. Both dates must be in open periods.
          </p>
          <form
            className="form form--inline"
            onSubmit={(e) => {
              e.preventDefault();
              cancel.mutate(undefined, { onSuccess: refresh });
            }}
          >
            <TextField
              label="Reason"
              value={reason}
              required
              onChange={(e) => setReason(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={cancel.isPending}>
              Cancel revaluation
            </Button>
          </form>
        </Card>
      ) : null}
    </AccountingPage>
  );
}
