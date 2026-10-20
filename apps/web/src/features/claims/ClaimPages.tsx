import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { useSensitiveAction } from '../../auth/reauth';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api, ApiError } from '../../services/api-client';
import { formatAmount } from '../../shared/money';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useAccounts } from '../accounting/shared';
import { AttachmentsCard } from '../files/AttachmentsCard';
import { ClaimPolicyNotice, isClaimPolicyError } from './ClaimPolicyNotice';
import { useT, type MessageKey } from '../../i18n/i18n';

/**
 * Employee expense claims. A claim lists what an employee spent, with receipts; it is approved,
 * then posted as a bill from the employee as a vendor, and reimbursed with an ordinary vendor
 * payment. The server numbers, approves and posts; these pages only guide.
 */

export const CLAIM_VIEW_PERMISSIONS = [Permission.ExpenseClaimsView] as const;

type ClaimStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'POSTED' | 'CANCELLED' | 'VOID';

interface ClaimSummary {
  id: string;
  status: ClaimStatus;
  number: string | null;
  employeePartyId: string;
  employeeName: string | null;
  claimDate: string;
  currencyCode: string;
  total: string;
  billId: string | null;
  version: number;
}

interface ClaimDetail extends ClaimSummary {
  memo: string;
  cancelReason: string | null;
  voidReason: string | null;
  lines: {
    id: string;
    lineNo: number;
    expenseDate: string;
    description: string;
    accountId: string;
    amount: string;
  }[];
  receiptCount: number;
  bill: {
    id: string;
    number: string | null;
    status: string;
    total: string;
    amountDue: string | null;
    reimbursed: boolean;
  } | null;
  approval: { requestId: string; requestStatus: string } | null;
}

interface Settings {
  defaultExpenseAccountId: string | null;
  receiptRequiredOver: string | null;
  version: number;
}

const STATUS_LABEL: Record<ClaimStatus, MessageKey> = {
  DRAFT: 'claims.claimPages.status.DRAFT',
  PENDING_APPROVAL: 'claims.claimPages.status.PENDING_APPROVAL',
  APPROVED: 'claims.claimPages.status.APPROVED',
  POSTED: 'claims.claimPages.status.POSTED',
  CANCELLED: 'claims.claimPages.status.CANCELLED',
  VOID: 'claims.claimPages.status.VOID',
};

function StatusBadge({ status }: { status: ClaimStatus }) {
  const tone =
    status === 'POSTED' || status === 'APPROVED'
      ? 'posted'
      : status === 'PENDING_APPROVAL'
        ? 'pending_approval'
        : status === 'DRAFT'
          ? 'draft'
          : 'reversed';
  const t = useT();
  return <span className={`badge badge--${tone}`}>{t(STATUS_LABEL[status])}</span>;
}

const today = () => new Date().toISOString().slice(0, 10);

function useOrgKey() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function ClaimsSection() {
  const t = useT();
  return (
    <>
      <nav className="subnav" aria-label={t('claims.claimPages.expenseClaims')}>
        <NavLink to="/claims" end>
          {t('claims.claimPages.claims')}
        </NavLink>
        <Can permission={Permission.ExpenseClaimsView}>
          <NavLink to="/claims/by-claimant">{t('claims.claimPages.byClaimant')}</NavLink>
          <NavLink to="/claims/settings">{t('claims.claimPages.settings')}</NavLink>
        </Can>
      </nav>
      <Outlet />
    </>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export function ClaimsPage() {
  const t = useT();
  const org = useOrgKey();
  const canCreate = usePermission(Permission.ExpenseClaimsCreate);
  const [status, setStatus] = useState('');
  const query = new URLSearchParams({ limit: '100' });
  if (status) query.set('status', status);
  const list = useQuery({
    queryKey: ['claims', org, status],
    queryFn: () =>
      api.get<{ items: ClaimSummary[]; nextCursor: string | null }>(
        `/expense-claims?${query.toString()}`,
      ),
  });
  return (
    <>
      <PageHeader
        title={t('claims.claimPages.expenseClaims')}
        description={t('claims.claimPages.whatEmployeesSpentForThe')}
      />
      <Card
        actions={
          canCreate ? (
            <Link className="btn btn--primary" to="/claims/new">
              {t('claims.claimPages.newClaim')}
            </Link>
          ) : undefined
        }
      >
        <div className="field">
          <label htmlFor="claim-status">{t('claims.claimPages.status')}</label>
          <select id="claim-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t('common.all')}</option>
            {(Object.keys(STATUS_LABEL) as ClaimStatus[]).map((s) => (
              <option key={s} value={s}>
                {t(STATUS_LABEL[s])}
              </option>
            ))}
          </select>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <ErrorAlert error={list.error} />
        ) : list.data.items.length === 0 ? (
          <p className="muted">{t('claims.claimPages.noExpenseClaims')}</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('claims.claimPages.number')}</th>
                <th>{t('claims.claimPages.employee')}</th>
                <th>{t('claims.claimPages.date')}</th>
                <th className="num">{t('claims.claimPages.total')}</th>
                <th>{t('claims.claimPages.status')}</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    <Link to={`/claims/${c.id}`}>{c.number ?? t('claims.claimPages.draft')}</Link>
                  </td>
                  <td>{c.employeeName}</td>
                  <td>{c.claimDate}</td>
                  <td className="num">
                    {formatAmount(c.total, c.currencyCode)} {c.currencyCode}
                  </td>
                  <td>
                    <StatusBadge status={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// New claim
// ---------------------------------------------------------------------------

interface DraftLine {
  expenseDate: string;
  description: string;
  accountId: string;
  amount: string;
}

export function NewClaimPage() {
  const t = useT();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canSeeAccounts = usePermission(Permission.AccountsView);
  const accounts = useAccounts(canSeeAccounts);
  const employees = useQuery({
    queryKey: ['claim-employees', org],
    queryFn: () =>
      api.get<{ items: { id: string; displayName: string }[] }>(
        '/parties?role=employee&status=active&limit=200',
      ),
  });
  const [employeePartyId, setEmployeePartyId] = useState('');
  const [claimDate, setClaimDate] = useState(today());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([
    { expenseDate: today(), description: '', accountId: '', amount: '' },
  ]);
  const create = useApiMutation(() =>
    api.post<ClaimDetail>(
      '/expense-claims',
      {
        employeePartyId,
        claimDate,
        ...(memo.trim() ? { memo: memo.trim() } : {}),
        lines: lines.map((l) => ({
          expenseDate: l.expenseDate,
          description: l.description.trim(),
          ...(l.accountId ? { accountId: l.accountId } : {}),
          amount: l.amount.trim(),
        })),
      },
      { idempotencyKey: crypto.randomUUID() },
    ),
  );
  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines(lines.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(undefined, {
      onSuccess: (claim) => {
        void queryClient.invalidateQueries({ queryKey: ['claims', org] });
        void navigate(`/claims/${claim.id}`);
      },
    });
  };
  const usable = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount,
  );
  const error = create.error instanceof ApiError ? create.error : null;
  return (
    <>
      <PageHeader title={t('claims.claimPages.newExpenseClaim')} />
      <p>
        <Link to="/claims">{t('claims.claimPages.expenseClaims2')}</Link>
      </p>
      <Card>
        <form onSubmit={submit}>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="claim-employee">{t('claims.claimPages.employee')}</label>
              <select
                id="claim-employee"
                value={employeePartyId}
                required
                onChange={(e) => setEmployeePartyId(e.target.value)}
              >
                <option value="">{t('common.choose')}</option>
                {(employees.data?.items ?? []).map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
              </select>
              {error?.fieldError('employeePartyId') ? (
                <small className="field__error" role="alert">
                  {error.fieldError('employeePartyId')}
                </small>
              ) : null}
            </div>
            <TextField
              label={t('claims.claimPages.claimDate')}
              type="date"
              value={claimDate}
              required
              onChange={(e) => setClaimDate(e.target.value)}
              error={error?.fieldError('claimDate')}
            />
            <TextField
              label={t('claims.claimPages.memo')}
              value={memo}
              maxLength={2000}
              onChange={(e) => setMemo(e.target.value)}
            />
          </div>
          <table className="table table--editor">
            <thead>
              <tr>
                <th>{t('claims.claimPages.date')}</th>
                <th>{t('claims.claimPages.description')}</th>
                <th>{t('claims.claimPages.account')}</th>
                <th className="num">{t('claims.claimPages.amount')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td>
                    <input
                      aria-label={t('claims.claimPages.dateLine', { value: i + 1 })}
                      type="date"
                      value={line.expenseDate}
                      onChange={(e) => setLine(i, { expenseDate: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={t('claims.claimPages.descriptionLine', { value: i + 1 })}
                      value={line.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={t('claims.claimPages.accountLine', { value: i + 1 })}
                      value={line.accountId}
                      onChange={(e) => setLine(i, { accountId: e.target.value })}
                    >
                      <option value="">{t('claims.claimPages.default')}</option>
                      {usable.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <input
                      aria-label={t('claims.claimPages.amountLine', { value: i + 1 })}
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => setLine(i, { amount: e.target.value })}
                    />
                  </td>
                  <td>
                    {lines.length > 1 ? (
                      <Button
                        variant="ghost"
                        onClick={() => setLines(lines.filter((_, x) => x !== i))}
                      >
                        {t('common.remove')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <Button
              variant="secondary"
              onClick={() =>
                setLines([
                  ...lines,
                  { expenseDate: today(), description: '', accountId: '', amount: '' },
                ])
              }
            >
              {t('claims.claimPages.addALine')}
            </Button>{' '}
            <Button type="submit" busy={create.isPending}>
              {t('claims.claimPages.saveDraft')}
            </Button>
          </p>
          {create.isError ? <ErrorAlert error={create.error} /> : null}
        </form>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function ClaimDetailPage() {
  const t = useT();
  const { id = '' } = useParams();
  const org = useOrgKey();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sensitive = useSensitiveAction();
  const canCreate = usePermission(Permission.ExpenseClaimsCreate);
  const canPost = usePermission(Permission.ExpenseClaimsPost);
  const canVoid = usePermission(Permission.ExpenseClaimsVoid);
  const claim = useQuery({
    queryKey: ['claim', org, id],
    queryFn: () => api.get<ClaimDetail>(`/expense-claims/${id}`),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['claim', org, id] });
    void queryClient.invalidateQueries({ queryKey: ['claims', org] });
  };
  const act = useApiMutation((input: { path: string; body: object }) =>
    api.post<ClaimDetail>(`/expense-claims/${id}/${input.path}`, input.body),
  );
  const voidClaim = useApiMutation((c: ClaimDetail) => {
    const reason = window.prompt(t('claims.claimPages.whyIsThisClaimVoided'));
    if (!reason?.trim()) return Promise.resolve(null);
    return sensitive(() =>
      api.post(`/expense-claims/${id}/void`, { version: c.version, reason: reason.trim() }),
    );
  });
  const del = useApiMutation((c: ClaimDetail) =>
    api.delete(`/expense-claims/${id}?version=${c.version}`),
  );
  if (claim.isPending) return <Spinner />;
  if (claim.isError) return <ErrorAlert error={claim.error} />;
  const c = claim.data;
  const run = (path: string, body: object) => act.mutate({ path, body }, { onSuccess: refresh });
  const policyError = isClaimPolicyError(act.error) ? act.error : null;
  const error = (policyError ? null : act.error) ?? voidClaim.error ?? del.error;
  return (
    <>
      <PageHeader
        title={
          c.number
            ? t('claims.claimPages.expenseClaim', { number: c.number })
            : t('claims.claimPages.expenseClaimDraft')
        }
        description={`${c.employeeName ?? ''} · ${c.claimDate} · ${formatAmount(c.total, c.currencyCode)} ${c.currencyCode}`}
      />
      <p>
        <Link to="/claims">{t('claims.claimPages.expenseClaims2')}</Link>{' '}
        <StatusBadge status={c.status} />
      </p>
      {error ? <ErrorAlert error={error} /> : null}
      {policyError && c.status === 'DRAFT' ? (
        <ClaimPolicyNotice
          error={policyError}
          busy={act.isPending}
          onConfirm={(policyReason) => run('submit', { version: c.version, policyReason })}
        />
      ) : null}
      {c.status === 'PENDING_APPROVAL' ? (
        <Alert tone="info">{t('claims.claimPages.waitingForApprovalUnderThe')}</Alert>
      ) : null}
      {c.bill ? (
        <Alert tone="info">
          {t('claims.claimPages.bill')}{' '}
          <Link to={`/purchases/bills/${c.bill.id}`}>
            {c.bill.number ?? t('claims.claimPages.draft2')}
          </Link>{' '}
          ({c.bill.status.toLowerCase()}).{' '}
          {c.bill.reimbursed
            ? t('claims.claimPages.reimbursed')
            : c.bill.amountDue !== null && c.status === 'POSTED'
              ? t('claims.claimPages.stillToReimbursePayIt', {
                  value: formatAmount(c.bill.amountDue, c.currencyCode),
                })
              : t('claims.claimPages.itIsNotPostedYet')}
        </Alert>
      ) : null}
      <Card
        title={t('claims.claimPages.expenses')}
        actions={
          <span>
            {canCreate && c.status === 'DRAFT' ? (
              <>
                <Button busy={act.isPending} onClick={() => run('submit', { version: c.version })}>
                  {t('claims.claimPages.submit')}
                </Button>{' '}
                <Button
                  variant="ghost"
                  onClick={() =>
                    del.mutate(c, {
                      onSuccess: () => {
                        refresh();
                        void navigate('/claims');
                      },
                    })
                  }
                >
                  {t('common.delete')}
                </Button>
              </>
            ) : null}
            {canCreate && c.status === 'PENDING_APPROVAL' ? (
              <Button variant="secondary" onClick={() => run('withdraw', { version: c.version })}>
                {t('claims.claimPages.withdraw')}
              </Button>
            ) : null}
            {canPost && c.status === 'APPROVED' ? (
              <Button busy={act.isPending} onClick={() => run('post', { version: c.version })}>
                {c.bill
                  ? t('claims.claimPages.finishPosting')
                  : t('claims.claimPages.postForReimbursement')}
              </Button>
            ) : null}
            {canCreate && c.status === 'APPROVED' && !c.bill ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const reason = window.prompt(t('claims.claimPages.whyIsThisClaimCancelled'));
                  if (reason?.trim()) run('cancel', { version: c.version, reason: reason.trim() });
                }}
              >
                {t('claims.claimPages.cancelClaim')}
              </Button>
            ) : null}
            {canVoid && c.status === 'POSTED' ? (
              <Button
                variant="ghost"
                busy={voidClaim.isPending}
                onClick={() => voidClaim.mutate(c, { onSuccess: refresh })}
              >
                {t('claims.claimPages.voidClaim')}
              </Button>
            ) : null}
          </span>
        }
      >
        <table className="table">
          <thead>
            <tr>
              <th>{t('claims.claimPages.date')}</th>
              <th>{t('claims.claimPages.description')}</th>
              <th className="num">{t('claims.claimPages.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {c.lines.map((l) => (
              <tr key={l.id}>
                <td>{l.expenseDate}</td>
                <td>{l.description}</td>
                <td className="num">{formatAmount(l.amount, c.currencyCode)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th colSpan={2}>{t('claims.claimPages.total')}</th>
              <th className="num">{formatAmount(c.total, c.currencyCode)}</th>
            </tr>
          </tfoot>
        </table>
        {c.memo ? <p>{c.memo}</p> : null}
      </Card>
      <AttachmentsCard
        linkType="expense_claim"
        linkId={id}
        canChange={canCreate && (c.status === 'DRAFT' || c.status === 'PENDING_APPROVAL')}
        canRemove={canCreate && c.status === 'DRAFT'}
        removeNote={t('claims.claimPages.receiptsCannotBeRemovedOnce')}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function ClaimSettingsPage() {
  const t = useT();
  const org = useOrgKey();
  const queryClient = useQueryClient();
  const canManage = usePermission(Permission.ExpenseClaimsSettingsManage);
  const accounts = useAccounts(usePermission(Permission.AccountsView));
  const settings = useQuery({
    queryKey: ['claim-settings', org],
    queryFn: () => api.get<Settings>('/expense-claims/settings'),
  });
  const [account, setAccount] = useState<string | null>(null);
  const [threshold, setThreshold] = useState<string | null>(null);
  const save = useApiMutation((s: Settings) =>
    api.put<Settings>('/expense-claims/settings', {
      version: s.version,
      defaultExpenseAccountId: account === null ? s.defaultExpenseAccountId : account || null,
      receiptRequiredOver: threshold === null ? s.receiptRequiredOver : threshold.trim() || null,
    }),
  );
  if (settings.isPending) return <Spinner />;
  if (settings.isError) return <ErrorAlert error={settings.error} />;
  const s = settings.data;
  const options = (accounts.data ?? []).filter(
    (a) => a.status === 'ACTIVE' && a.isLeaf && !a.isControlAccount,
  );
  return (
    <>
      <PageHeader title={t('claims.claimPages.expenseClaimSettings')} />
      <Card>
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate(s, {
              onSuccess: () => {
                setAccount(null);
                setThreshold(null);
                void queryClient.invalidateQueries({ queryKey: ['claim-settings', org] });
              },
            });
          }}
        >
          <div className="field">
            <label htmlFor="claim-default-account">
              {t('claims.claimPages.defaultExpenseAccount')}
            </label>
            <select
              id="claim-default-account"
              value={account ?? s.defaultExpenseAccountId ?? ''}
              disabled={!canManage}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">{t('common.none')}</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </select>
          </div>
          <TextField
            label={t('claims.claimPages.receiptRequiredForLinesOf')}
            value={threshold ?? s.receiptRequiredOver ?? ''}
            disabled={!canManage}
            inputMode="decimal"
            hint={t('claims.claimPages.leaveEmptyToNeverRequire')}
            onChange={(e) => setThreshold(e.target.value)}
          />
          {canManage ? (
            <div>
              <Button type="submit" busy={save.isPending}>
                {t('common.save')}
              </Button>
            </div>
          ) : null}
        </form>
        {save.isError ? <ErrorAlert error={save.error} /> : null}
      </Card>
    </>
  );
}
