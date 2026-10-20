import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { Can, Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { Alert } from '../../shared/ui/Alert';
import type { Account, DimensionType, JournalStatus, SetupState } from './types';
import { useT } from '../../i18n/i18n';

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
  const t = useT();
  return (
    <nav className="subnav" aria-label={t('acct.nav.label')}>
      <NavLink to="/accounting" end>
        {t('acct.nav.dashboard')}
      </NavLink>
      <Can permission={Permission.AccountsView}>
        <NavLink to="/accounting/accounts">{t('acct.nav.accounts')}</NavLink>
        <NavLink to="/accounting/designations">{t('acct.nav.designations')}</NavLink>
      </Can>
      <Can permission={Permission.DimensionsView}>
        <NavLink to="/accounting/dimensions">{t('acct.nav.dimensions')}</NavLink>
      </Can>
      <Can permission={Permission.JournalsView}>
        <NavLink to="/accounting/journals" end>
          {t('acct.nav.journals')}
        </NavLink>
        <NavLink to="/accounting/journals/drafts">{t('acct.nav.drafts')}</NavLink>
        <NavLink to="/accounting/journals/approvals">{t('acct.nav.approvals')}</NavLink>
        <NavLink to="/accounting/journals/posted">{t('acct.nav.posted')}</NavLink>
        <NavLink to="/accounting/opening-balances">{t('acct.nav.openingBalances')}</NavLink>
        <NavLink to="/accounting/revaluations">{t('acct.nav.revaluation')}</NavLink>
      </Can>
      <Can permission={Permission.PeriodsView}>
        <NavLink to="/accounting/fiscal-years">{t('acct.nav.fiscalYears')}</NavLink>
        <NavLink to="/accounting/periods">{t('acct.nav.periods')}</NavLink>
      </Can>
      <Can permission={Permission.LedgerView}>
        <NavLink to="/accounting/ledger">{t('acct.nav.ledger')}</NavLink>
      </Can>
      <Can permission={Permission.ReportsView}>
        <NavLink to="/accounting/reports/trial-balance">{t('acct.nav.trialBalance')}</NavLink>
        <NavLink to="/accounting/reports/profit-and-loss">{t('acct.nav.profitAndLoss')}</NavLink>
        <NavLink to="/accounting/reports/profit-and-loss-cash-basis">
          {t('acct.nav.plCash')}
        </NavLink>
        <Can permission={Permission.DimensionsView}>
          <NavLink to="/accounting/reports/profit-and-loss-by-dimension">
            {t('acct.nav.plByDimension')}
          </NavLink>
        </Can>
        <NavLink to="/accounting/reports/expense-trend">{t('acct.nav.expenseTrend')}</NavLink>
        <NavLink to="/accounting/reports/balance-sheet">{t('acct.nav.balanceSheet')}</NavLink>
        <NavLink to="/accounting/reports/cash-flow">{t('acct.nav.cashFlow')}</NavLink>
        <NavLink to="/accounting/reports/changes-in-equity">
          {t('acct.nav.changesInEquity')}
        </NavLink>
      </Can>
      <Can permission={Permission.SalesReportsView}>
        <NavLink to="/accounting/reports/sales-by-dimension">
          {t('acct.nav.salesByDimension')}
        </NavLink>
        <NavLink to="/accounting/reports/tax-liability">{t('acct.nav.taxLiability')}</NavLink>
      </Can>
      <Can permission={Permission.AccountingSetup}>
        <NavLink to="/accounting/setup">{t('acct.nav.setup')}</NavLink>
      </Can>
    </nav>
  );
}

/** Wraps accounting pages: sub-navigation plus a setup prompt when accounting is not set up. */
export function AccountingPage({ children }: { children: ReactNode }) {
  const t = useT();
  const setup = useAccountingSetup();
  const canSetUp = usePermission(Permission.AccountingSetup);
  return (
    <>
      <AccountingNav />
      {setup.data && !setup.data.isSetUp ? (
        <Alert tone="info">
          {t('acct.notSetUp')}{' '}
          {canSetUp ? <Link to="/accounting/setup">{t('acct.setItUp')}</Link> : t('acct.askAdmin')}
        </Alert>
      ) : (
        children
      )}
    </>
  );
}

export function StatusBadge({
  status,
}: {
  status: JournalStatus | 'OPEN' | 'CLOSED' | 'ACTIVE' | 'ARCHIVED';
}) {
  const t = useT();
  const journalStatuses = ['DRAFT', 'PENDING_APPROVAL', 'POSTED', 'REVERSED', 'DISCARDED'];
  const label = journalStatuses.includes(status)
    ? t(`acct.status.${status as JournalStatus}`)
    : status.toLowerCase();
  return <span className={`badge badge--${status.toLowerCase()}`}>{label}</span>;
}

export function journalLabel(journal: { number: number | null; id: string }): string {
  return journal.number !== null
    ? `JE-${String(journal.number).padStart(6, '0')}`
    : `Draft ${journal.id.slice(0, 8)}`;
}
