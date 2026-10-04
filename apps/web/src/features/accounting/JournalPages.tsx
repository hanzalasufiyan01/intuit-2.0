import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { AppliedSteps, describeFacts } from '../approvals/conditions';
import { useSensitiveAction } from '../../auth/reauth';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { AttachmentsCard } from '../files/AttachmentsCard';
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

/** Subledger modules whose journals are reversed only by voiding their documents (E2, P4-09). */
const SUBLEDGER_LABELS: Record<string, string> = { sales: 'Sales', purchases: 'Purchases' };
/** FX and revaluation system journals are never reversed generically (Decision 80). */
const FX_SYSTEM_TYPES = ['realized_fx', 'revaluation', 'revaluation_reversal'];

/**
 * Why the generic reversal does not apply to a journal (the server refuses these with 409
 * SYSTEM_JOURNAL; this only avoids offering an action that cannot succeed), or null.
 */
export function genericReversalBlock(journal: JournalDetail): string | null {
  const owner =
    (journal.sourceModule ? SUBLEDGER_LABELS[journal.sourceModule] : undefined) ??
    (journal.sourceDocument ? SUBLEDGER_LABELS[journal.sourceDocument.module] : undefined);
  if (owner) {
    return `This journal belongs to ${owner}; it is reversed by voiding its document there, not here.`;
  }
  if (
    journal.source === 'system' &&
    journal.sourceType &&
    FX_SYSTEM_TYPES.includes(journal.sourceType)
  ) {
    return 'This FX system journal is corrected through its FX process, not reversed here.';
  }
  return null;
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
    editDraft: usePermission(Permission.JournalsEditDraft),
  };
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // L-9: only imported drafts that were never submitted can be discarded (kept, never deleted).
  const discardable =
    journal.status === 'DRAFT' &&
    journal.sourceModule === 'data_exchange' &&
    !journal.submittedAt &&
    can.editDraft;
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
      (pending &&
        (journal.approval === null
          ? !journal.approvalRequiredForPosting
          : journal.approval.status === 'approved')));

  return (
    <Card title="Actions">
      <ErrorAlert
        error={
          act.error?.issues.length
            ? new Error(
                act.error.issues
                  .map((i) => {
                    const line = /^lines\.(\d+)/.exec(i.path);
                    return line ? `Line ${Number(line[1]) + 1}: ${i.message}` : i.message;
                  })
                  .join(' '),
              )
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
        {discardable ? (
          confirmDiscard ? (
            <>
              <Button variant="secondary" busy={act.isPending} onClick={() => run('discard')}>
                Confirm discard
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
              Discard imported draft
            </Button>
          )
        ) : null}
        {journal.status === 'POSTED' && can.reverse && genericReversalBlock(journal) === null ? (
          <Button
            variant="secondary"
            onClick={() => setReverseForm({ ...reverseForm, open: true })}
          >
            Reverse…
          </Button>
        ) : null}
      </div>
      {journal.status === 'POSTED' && can.reverse && genericReversalBlock(journal) !== null ? (
        <p className="muted">{genericReversalBlock(journal)}</p>
      ) : null}
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
            {j.sourceModule ? ` (${j.sourceModule} ${j.sourceType ?? ''} ${j.sourceId ?? ''})` : ''}
          </p>
          {j.sourceDocument ? (
            <p className="muted">
              {j.sourceDocument.relation === 'reversal'
                ? 'Reverses the posting of '
                : 'Posted from '}
              <Link to={j.sourceDocument.path}>{j.sourceDocument.label}</Link>.
            </p>
          ) : j.sourceType === 'opening_balance' && j.sourceId ? (
            <p className="muted">
              Posted from{' '}
              <Link to={`/accounting/opening-balances/${j.sourceId}`}>
                an opening balance batch
              </Link>
              ; it is reversed only with the whole batch.
            </p>
          ) : null}
          {j.sourceModule === 'data_exchange' && j.sourceId ? (
            <p className="muted">
              Imported from <Link to={`/imports/${j.sourceId}`}>an import</Link>.
            </p>
          ) : null}
          {j.status === 'DISCARDED' ? (
            <Alert tone="info">
              This imported draft was discarded
              {j.discardedAt ? ` on ${new Date(j.discardedAt).toLocaleString()}` : ''}. It is kept
              for the record and can no longer change.
            </Alert>
          ) : null}
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
          {(j.status === 'DRAFT' || j.status === 'PENDING_APPROVAL') && !j.approval ? (
            <div className="approval-requirement" data-testid="approval-requirement">
              <p>
                {j.approvalRequiredForPosting
                  ? 'Approval is required before posting'
                  : 'No approval is required to post this journal'}{' '}
                <span className="muted">({describeFacts(j.approvalFacts)})</span>
              </p>
              <AppliedSteps steps={j.approvalSteps} baseCurrency={j.approvalFacts.baseCurrency} />
            </div>
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
                  <th>Dimensions</th>
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
                    <td>
                      {l.description}
                      {l.kind === 'base_only' ? <span className="muted"> (base only)</span> : null}
                    </td>
                    <td>
                      {(l.dimensions ?? []).map((d) => (
                        <span key={d.dimensionTypeId} className="badge">
                          {d.typeName}: {d.valueName}
                        </span>
                      ))}
                    </td>
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
        {/* S5-20: attach at any status; remove only while the journal is a draft. */}
        <AttachmentsCard
          linkType="journal"
          linkId={j.id}
          canChange={canEdit}
          canRemove={canEdit && j.status === 'DRAFT'}
          removeNote="Attachments stay with the journal once it leaves draft."
        />
      </AccountingPage>
    </>
  );
}
