import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert } from '../../shared/ui/Alert';
import type { Account, DimensionType, JournalStatus, SetupState } from './types';

export function useOrgKey(): string {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function useAccountingSetup() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['accounting-setup', org],
    queryFn: () => api.get<SetupState>('/accounting/setup'),
  });
}

export function useAccounts(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['accounting-accounts', org],
    queryFn: () => api.get<Account[]>('/accounting/accounts'),
    enabled,
  });
}

export function useDimensions(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['accounting-dimensions', org],
    queryFn: () => api.get<DimensionType[]>('/accounting/dimensions'),
    enabled,
  });
}

/**
 * Required dimension types for a line's account (Decision 84): active required types whose
 * account-classification scope contains the account's type or subtype. Display only: the
 * server enforces this at submission and posting, and nothing is assigned automatically.
 */
export function requiredTypesFor(
  account: Pick<Account, 'type' | 'subtype'> | undefined,
  types: readonly DimensionType[],
): DimensionType[] {
  if (!account) return [];
  return types.filter(
    (t) =>
      t.status === 'ACTIVE' &&
      t.isRequired &&
      (t.scope.accountTypes.includes(account.type) ||
        (account.subtype !== null &&
          account.subtype !== undefined &&
          t.scope.accountSubtypes.includes(account.subtype))),
  );
}

/** Sub-navigation for the Accounting area; every link is permission-aware. */
export function AccountingNav() {
  return (
    <nav className="subnav" aria-label="Accounting">
      <NavLink to="/accounting" end>
        Dashboard
      </NavLink>
      <Can permission={Permission.AccountsView}>
        <NavLink to="/accounting/accounts">Chart of Accounts</NavLink>
        <NavLink to="/accounting/designations">System Accounts</NavLink>
      </Can>
      <Can permission={Permission.DimensionsView}>
        <NavLink to="/accounting/dimensions">Dimensions</NavLink>
      </Can>
      <Can permission={Permission.JournalsView}>
        <NavLink to="/accounting/journals" end>
          Journals
        </NavLink>
        <NavLink to="/accounting/journals/drafts">Drafts</NavLink>
        <NavLink to="/accounting/journals/approvals">Approval Queue</NavLink>
        <NavLink to="/accounting/journals/posted">Posted</NavLink>
        <NavLink to="/accounting/opening-balances">Opening Balances</NavLink>
      </Can>
      <Can permission={Permission.PeriodsView}>
        <NavLink to="/accounting/fiscal-years">Fiscal Years</NavLink>
        <NavLink to="/accounting/periods">Periods</NavLink>
      </Can>
      <Can permission={Permission.LedgerView}>
        <NavLink to="/accounting/ledger">General Ledger</NavLink>
      </Can>
      <Can permission={Permission.ReportsView}>
        <NavLink to="/accounting/reports/trial-balance">Trial Balance</NavLink>
        <NavLink to="/accounting/reports/profit-and-loss">Profit &amp; Loss</NavLink>
        <NavLink to="/accounting/reports/balance-sheet">Balance Sheet</NavLink>
      </Can>
      <Can permission={Permission.AccountingSetup}>
        <NavLink to="/accounting/setup">Setup</NavLink>
      </Can>
    </nav>
  );
}

/** Wraps accounting pages: sub-navigation plus a setup prompt when accounting is not set up. */
export function AccountingPage({ children }: { children: ReactNode }) {
  const setup = useAccountingSetup();
  const canSetUp = usePermission(Permission.AccountingSetup);
  return (
    <>
      <AccountingNav />
      {setup.data && !setup.data.isSetUp ? (
        <Alert tone="info">
          Accounting has not been set up for this organization.{' '}
          {canSetUp ? (
            <Link to="/accounting/setup">Set it up now</Link>
          ) : (
            'Ask an administrator to set it up.'
          )}
        </Alert>
      ) : (
        children
      )}
    </>
  );
}

const STATUS_LABELS: Record<JournalStatus, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  POSTED: 'Posted',
  REVERSED: 'Reversed',
  DISCARDED: 'Discarded',
};

export function StatusBadge({
  status,
}: {
  status: JournalStatus | 'OPEN' | 'CLOSED' | 'ACTIVE' | 'ARCHIVED';
}) {
  const label =
    status in STATUS_LABELS ? STATUS_LABELS[status as JournalStatus] : status.toLowerCase();
  return <span className={`badge badge--${status.toLowerCase()}`}>{label}</span>;
}

export function journalLabel(journal: { number: number | null; id: string }): string {
  return journal.number !== null
    ? `JE-${String(journal.number).padStart(6, '0')}`
    : `Draft ${journal.id.slice(0, 8)}`;
}
