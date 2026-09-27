import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { JournalEditor } from './JournalEditor';
import { AccountingPage, journalLabel, StatusBadge, useAccounts, useOrgKey } from './shared';
import type { JournalDetail } from './types';

export function NewJournalPage() {
  return (
    <>
      <PageHeader
        title="New journal"
        description="Drafts may be incomplete; posting requires a balanced double entry."
      />
      <AccountingPage>
        <Card>
          <JournalEditor />
        </Card>
      </AccountingPage>
    </>
  );
}

function useJournal(id: string) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['accounting-journal', org, id],
    queryFn: () => api.get<JournalDetail>(`/accounting/journals/${id}`),
  });
}

/** Workflow actions offered only when both the state and the user's permissions allow them. */
function JournalActions({ journal }: { journal: JournalDetail }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const sensitive = useSensitiveAction();
  const { session } = useAuth();
  const userId = session?.user.id;
  const can = {
    submit: usePermission(Permission.JournalsSubmit),
    approve: usePermission(Permission.JournalsApprove),
    post: usePermission(Permission.JournalsPost),
    reverse: usePermission(Permission.JournalsReverse),
  };
  const [comment, setComment] = useState('');
  const [reverseForm, setReverseForm] = useState({ open: false, reason: '', reversalDate: '' });
  const act = useApiMutation((input: { action: string; body?: object; sensitive?: boolean }) => {
    const call = () =>
      api.post<unknown>(`/accounting/journals/${journal.id}/${input.action}`, input.body ?? {});
    return input.sensitive ? sensitive(call) : call();
  });
  const run = (action: string, body?: object, isSensitive = false) =>
    act.mutate(
      { action, ...(body ? { body } : {}), sensitive: isSensitive },
      {
        onSuccess: (result) => {
          void queryClient.invalidateQueries();
          const reversal = (result as { reversal?: { id: string } }).reversal;
          if (reversal) void navigate(`/accounting/journals/${reversal.id}`);
        },
      },
    );

  const pending = journal.status === 'PENDING_APPROVAL';
  const needsApproval = journal.approval !== null && journal.approval.status === 'pending';
  const isOwnWork =
    userId !== undefined &&
    (journal.createdByUserId === userId || journal.submittedByUserId === userId);
  const canPostNow =
    can.post &&
    ((journal.status === 'DRAFT' && !journal.approvalRequiredForPosting) ||
      (pending && (journal.approval === null || journal.approval.status === 'approved')));

  return (
    <Card title="Actions">
      <ErrorAlert
        error={
          act.error?.issues.length
            ? new Error(act.error.issues.map((i) => i.message).join(' '))
            : act.error
        }
      />
      <div className="actions">
        {journal.status === 'DRAFT' && can.submit ? (
          <Button busy={act.isPending} onClick={() => run('submit')}>
            Submit
          </Button>
        ) : null}
        {canPostNow ? (
          <Button busy={act.isPending} onClick={() => run('post', undefined, true)}>
            Post
          </Button>
        ) : null}
        {pending && can.submit ? (
          <Button variant="secondary" onClick={() => run('withdraw')}>
            Withdraw to draft
          </Button>
        ) : null}
        {journal.status === 'POSTED' && can.reverse ? (
          <Button
            variant="secondary"
            onClick={() => setReverseForm({ ...reverseForm, open: true })}
          >
            Reverse…
          </Button>
        ) : null}
      </div>
      {needsApproval && can.approve ? (
        isOwnWork ? (
          <p className="muted">You prepared or submitted this journal, so you cannot approve it.</p>
        ) : (
          <div className="form form--inline">
            <TextField
              label="Comment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button busy={act.isPending} onClick={() => run('approve', comment ? { comment } : {})}>
              Approve
            </Button>
            <Button variant="secondary" onClick={() => run('reject', comment ? { comment } : {})}>
              Reject
            </Button>
          </div>
        )
      ) : null}
      {reverseForm.open ? (
        <form
          className="form form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            run(
              'reverse',
              {
                reason: reverseForm.reason,
                ...(reverseForm.reversalDate ? { reversalDate: reverseForm.reversalDate } : {}),
              },
              true,
            );
          }}
        >
          <TextField
            label="Reason"
            value={reverseForm.reason}
            onChange={(e) => setReverseForm({ ...reverseForm, reason: e.target.value })}
          />
          <TextField
            label="Reversal date"
            type="date"
            value={reverseForm.reversalDate}
            onChange={(e) => setReverseForm({ ...reverseForm, reversalDate: e.target.value })}
            hint="Defaults to the original date"
          />
          <Button type="submit" busy={act.isPending}>
            Reverse journal
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function JournalDetailPage() {
  const { id = '' } = useParams();
  const journal = useJournal(id);
  const accounts = useAccounts();
  const canEdit = usePermission(Permission.JournalsEditDraft);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const accountName = (accountId: string | null) => {
    const a = accounts.data?.find((x) => x.id === accountId);
    return a ? `${a.code} ${a.name}` : accountId ? 'Unknown account' : '(no account)';
  };

  if (journal.isPending) return <Spinner label="Loading journal" />;
  if (journal.isError) return <ErrorAlert error={journal.error} />;
  const j = journal.data;

  return (
    <>
      <PageHeader title={journalLabel(j)} description={j.description || undefined} />
      <AccountingPage>
        <Card>
          <p>
            <StatusBadge status={j.status} /> {j.entryDate} · {j.currency}
            {j.exchangeRate ? ` · rate ${j.exchangeRate} (${j.exchangeRateSource})` : ''}
            {j.reference ? ` · ref ${j.reference}` : ''} · source: {j.source}
          </p>
          {j.reversedByJournalId ? (
            <Alert tone="info">
              Reversed by{' '}
              <Link to={`/accounting/journals/${j.reversedByJournalId}`}>this journal</Link>:{' '}
              {j.reversalReason}
            </Alert>
          ) : null}
          {j.reversesJournalId ? (
            <Alert tone="info">
              Reverses <Link to={`/accounting/journals/${j.reversesJournalId}`}>this journal</Link>:{' '}
              {j.reversalReason}
            </Alert>
          ) : null}
          {j.approval ? (
            <p className="muted">
              Approval: {j.approval.status} —{' '}
              {j.approval.steps
                .map((s) => `${s.name} ${s.approvals}/${s.requiredApprovals}`)
                .join(', ')}
            </p>
          ) : null}
        </Card>
        {editing && j.status === 'DRAFT' ? (
          <Card title="Edit draft">
            <JournalEditor
              journal={j}
              onSaved={() => {
                setEditing(false);
                void queryClient.invalidateQueries();
              }}
            />
          </Card>
        ) : (
          <Card
            title="Lines"
            actions={
              j.status === 'DRAFT' && canEdit ? (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  Edit draft
                </Button>
              ) : null
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Account</th>
                  <th>Description</th>
                  <th>Debit</th>
                  <th>Credit</th>
                  {j.baseCurrency ? <th>Base debit ({j.baseCurrency})</th> : null}
                  {j.baseCurrency ? <th>Base credit ({j.baseCurrency})</th> : null}
                </tr>
              </thead>
              <tbody>
                {j.lines.map((l) => (
                  <tr key={l.lineNumber}>
                    <td>{l.lineNumber}</td>
                    <td>{accountName(l.accountId)}</td>
                    <td>{l.description}</td>
                    <td>{formatAmount(l.debit, j.currency)}</td>
                    <td>{formatAmount(l.credit, j.currency)}</td>
                    {j.baseCurrency ? <td>{formatAmount(l.baseDebit, j.baseCurrency)}</td> : null}
                    {j.baseCurrency ? <td>{formatAmount(l.baseCredit, j.baseCurrency)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
        <JournalActions journal={j} />
      </AccountingPage>
    </>
  );
}
