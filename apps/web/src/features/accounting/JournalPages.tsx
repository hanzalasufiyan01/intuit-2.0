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
import { useT, type MessageKey, type Translate } from '../../i18n/i18n';

export function NewJournalPage() {
  const t = useT();
  return (
    <>
      <PageHeader
        title={t('accounting.journalPages.newJournal')}
        description={t('accounting.journalPages.draftsMayBeIncompletePosting')}
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
const SUBLEDGER_LABELS: Record<string, MessageKey> = {
  sales: 'accounting.journalPages.subledger.sales',
  purchases: 'accounting.journalPages.subledger.purchases',
};
/** FX and revaluation system journals are never reversed generically (Decision 80). */
const FX_SYSTEM_TYPES = ['realized_fx', 'revaluation', 'revaluation_reversal'];

/**
 * Why the generic reversal does not apply to a journal (the server refuses these with 409
 * SYSTEM_JOURNAL; this only avoids offering an action that cannot succeed), or null.
 */
export function genericReversalBlock(journal: JournalDetail, t: Translate): string | null {
  const owner =
    (journal.sourceModule ? SUBLEDGER_LABELS[journal.sourceModule] : undefined) ??
    (journal.sourceDocument ? SUBLEDGER_LABELS[journal.sourceDocument.module] : undefined);
  if (owner) {
    return t('accounting.journalPages.reversalBlockedOwner', { owner: t(owner) });
  }
  if (
    journal.source === 'system' &&
    journal.sourceType &&
    FX_SYSTEM_TYPES.includes(journal.sourceType)
  ) {
    return t('accounting.journalPages.reversalBlockedFx');
  }
  return null;
}

/** Workflow actions offered only when both the state and the user's permissions allow them. */
function JournalActions({ journal }: { journal: JournalDetail }) {
  const t = useT();
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
    <Card title={t('common.actions')}>
      <ErrorAlert
        error={
          act.error?.issues.length
            ? new Error(
                act.error.issues
                  .map((i) => {
                    const line = /^lines\.(\d+)/.exec(i.path);
                    return line
                      ? t('accounting.journalPages.lineIssue', {
                          line: Number(line[1]) + 1,
                          message: i.message,
                        })
                      : i.message;
                  })
                  .join(' '),
              )
            : act.error
        }
      />
      <div className="actions">
        {journal.status === 'DRAFT' && can.submit ? (
          <Button busy={act.isPending} onClick={() => run('submit')}>
            {t('accounting.journalPages.submit')}
          </Button>
        ) : null}
        {canPostNow ? (
          <Button busy={act.isPending} onClick={() => run('post', undefined, true)}>
            {t('accounting.journalPages.post')}
          </Button>
        ) : null}
        {pending && can.submit ? (
          <Button variant="secondary" onClick={() => run('withdraw')}>
            {t('accounting.journalPages.withdrawToDraft')}
          </Button>
        ) : null}
        {discardable ? (
          confirmDiscard ? (
            <>
              <Button variant="secondary" busy={act.isPending} onClick={() => run('discard')}>
                {t('accounting.journalPages.confirmDiscard')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
                {t('accounting.journalPages.keep')}
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmDiscard(true)}>
              {t('accounting.journalPages.discardImportedDraft')}
            </Button>
          )
        ) : null}
        {journal.status === 'POSTED' && can.reverse && genericReversalBlock(journal, t) === null ? (
          <Button
            variant="secondary"
            onClick={() => setReverseForm({ ...reverseForm, open: true })}
          >
            {t('accounting.journalPages.reverse')}
          </Button>
        ) : null}
      </div>
      {journal.status === 'POSTED' && can.reverse && genericReversalBlock(journal, t) !== null ? (
        <p className="muted">{genericReversalBlock(journal, t)}</p>
      ) : null}
      {needsApproval && can.approve ? (
        isOwnWork ? (
          <p className="muted">{t('accounting.journalPages.youPreparedOrSubmittedThis')}</p>
        ) : (
          <div className="form form--inline">
            <TextField
              label={t('accounting.journalPages.comment')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button busy={act.isPending} onClick={() => run('approve', comment ? { comment } : {})}>
              {t('accounting.journalPages.approve')}
            </Button>
            <Button variant="secondary" onClick={() => run('reject', comment ? { comment } : {})}>
              {t('accounting.journalPages.reject')}
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
            label={t('accounting.journalPages.reason')}
            value={reverseForm.reason}
            onChange={(e) => setReverseForm({ ...reverseForm, reason: e.target.value })}
          />
          <TextField
            label={t('accounting.journalPages.reversalDate')}
            type="date"
            value={reverseForm.reversalDate}
            onChange={(e) => setReverseForm({ ...reverseForm, reversalDate: e.target.value })}
            hint={t('accounting.journalPages.defaultsToTheOriginalDate')}
          />
          <Button type="submit" busy={act.isPending}>
            {t('accounting.journalPages.reverseJournal')}
          </Button>
        </form>
      ) : null}
    </Card>
  );
}

export function JournalDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const journal = useJournal(id);
  const accounts = useAccounts();
  const canEdit = usePermission(Permission.JournalsEditDraft);
  const [editing, setEditing] = useState(false);
  const queryClient = useQueryClient();
  const accountName = (accountId: string | null) => {
    const a = accounts.data?.find((x) => x.id === accountId);
    return a
      ? `${a.code} ${a.name}`
      : accountId
        ? t('accounting.journalPages.unknownAccount')
        : t('accounting.journalPages.noAccount');
  };

  if (journal.isPending) return <Spinner label={t('accounting.journalPages.loadingJournal')} />;
  if (journal.isError) return <ErrorAlert error={journal.error} />;
  const j = journal.data;

  return (
    <>
      <PageHeader title={journalLabel(j)} description={j.description || undefined} />
      <AccountingPage>
        <Card>
          <p>
            <StatusBadge status={j.status} />{' '}
            {t('accounting.journalPages.source', {
              entryDate: j.entryDate,
              currency: j.currency,
              value: j.exchangeRate
                ? t('accounting.journalPages.rate', {
                    exchangeRate: j.exchangeRate,
                    exchangeRateSource: j.exchangeRateSource,
                  })
                : '',
              value2: j.reference
                ? t('accounting.journalPages.ref', { reference: j.reference })
                : '',
              source: j.source,
              value3: j.sourceModule
                ? ` (${j.sourceModule} ${j.sourceType ?? ''} ${j.sourceId ?? ''})`
                : '',
            })}
          </p>
          {j.sourceDocument ? (
            <p className="muted">
              {j.sourceDocument.relation === 'reversal'
                ? t('accounting.journalPages.reversesThePostingOf')
                : t('accounting.journalPages.postedFrom')}
              <Link to={j.sourceDocument.path}>{j.sourceDocument.label}</Link>.
            </p>
          ) : j.sourceType === 'opening_balance' && j.sourceId ? (
            <p className="muted">
              {t('accounting.journalPages.postedFrom2')}{' '}
              <Link to={`/accounting/opening-balances/${j.sourceId}`}>
                {t('accounting.journalPages.anOpeningBalanceBatch')}
              </Link>
              {t('accounting.journalPages.itIsReversedOnlyWith')}
            </p>
          ) : null}
          {j.sourceModule === 'data_exchange' && j.sourceId ? (
            <p className="muted">
              {t('accounting.journalPages.importedFrom')}{' '}
              <Link to={`/imports/${j.sourceId}`}>{t('accounting.journalPages.anImport')}</Link>.
            </p>
          ) : null}
          {j.status === 'DISCARDED' ? (
            <Alert tone="info">
              {t('accounting.journalPages.thisImportedDraftWasDiscarded', {
                value: j.discardedAt
                  ? t('accounting.journalPages.on', {
                      value: new Date(j.discardedAt).toLocaleString(),
                    })
                  : '',
              })}
            </Alert>
          ) : null}
          {j.reversedByJournalId ? (
            <Alert tone="info">
              {t('accounting.journalPages.reversedBy')}{' '}
              <Link to={`/accounting/journals/${j.reversedByJournalId}`}>
                {t('accounting.journalPages.thisJournal')}
              </Link>
              : {j.reversalReason}
            </Alert>
          ) : null}
          {j.reversesJournalId ? (
            <Alert tone="info">
              {t('accounting.journalPages.reverses')}{' '}
              <Link to={`/accounting/journals/${j.reversesJournalId}`}>
                {t('accounting.journalPages.thisJournal')}
              </Link>
              : {j.reversalReason}
            </Alert>
          ) : null}
          {j.approval ? (
            <p className="muted">
              {t('accounting.journalPages.approval', {
                status: j.approval.status,
                value: j.approval.steps
                  .map((s) => `${s.name} ${s.approvals}/${s.requiredApprovals}`)
                  .join(', '),
              })}
            </p>
          ) : null}
          {(j.status === 'DRAFT' || j.status === 'PENDING_APPROVAL') && !j.approval ? (
            <div className="approval-requirement" data-testid="approval-requirement">
              <p>
                {j.approvalRequiredForPosting
                  ? t('accounting.journalPages.approvalIsRequiredBeforePosting')
                  : t('accounting.journalPages.noApprovalIsRequiredTo')}{' '}
                <span className="muted">({describeFacts(j.approvalFacts, t)})</span>
              </p>
              <AppliedSteps steps={j.approvalSteps} baseCurrency={j.approvalFacts.baseCurrency} />
            </div>
          ) : null}
        </Card>
        {editing && j.status === 'DRAFT' ? (
          <Card title={t('accounting.journalPages.editDraft')}>
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
            title={t('accounting.journalPages.lines')}
            actions={
              j.status === 'DRAFT' && canEdit ? (
                <Button variant="secondary" onClick={() => setEditing(true)}>
                  {t('accounting.journalPages.editDraft')}
                </Button>
              ) : null
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('accounting.journalPages.account')}</th>
                  <th>{t('accounting.journalPages.description')}</th>
                  <th>{t('accounting.journalPages.dimensions')}</th>
                  <th>{t('accounting.journalPages.debit')}</th>
                  <th>{t('accounting.journalPages.credit')}</th>
                  {j.baseCurrency ? (
                    <th>
                      {t('accounting.journalPages.baseDebit', { baseCurrency: j.baseCurrency })}
                    </th>
                  ) : null}
                  {j.baseCurrency ? (
                    <th>
                      {t('accounting.journalPages.baseCredit', { baseCurrency: j.baseCurrency })}
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {j.lines.map((l) => (
                  <tr key={l.lineNumber}>
                    <td>{l.lineNumber}</td>
                    <td>{accountName(l.accountId)}</td>
                    <td>
                      {l.description}
                      {l.kind === 'base_only' ? (
                        <span className="muted"> {t('accounting.journalPages.baseOnly')}</span>
                      ) : null}
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
          removeNote={t('accounting.journalPages.attachmentsStayWithTheJournal')}
        />
      </AccountingPage>
    </>
  );
}
