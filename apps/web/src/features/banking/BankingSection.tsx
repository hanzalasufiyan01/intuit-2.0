import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { Can, Permission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import type { BankAccount } from './types';
import { useT } from '../../i18n/i18n';

/** Any of these shows the Banking area in the navigation (UX only; the server decides). */
export const BANKING_VIEW_PERMISSIONS = [
  Permission.BankingTransactionsView,
  Permission.BankingAccountsManage,
] as const;

export function useOrgKey(): string {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function useBankAccounts() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['banking-accounts', org],
    queryFn: () => api.get<{ items: BankAccount[] }>('/banking/accounts'),
  });
}

function BankingNav() {
  const t = useT();
  return (
    <nav className="subnav" aria-label={t('banking.nav.label')}>
      <NavLink to="/banking" end>
        {t('banking.nav.accounts')}
      </NavLink>
      <Can permission={Permission.BankingTransactionsView}>
        <NavLink to="/banking/transfers">{t('banking.nav.transfers')}</NavLink>
        <NavLink to="/banking/rules">{t('banking.nav.rules')}</NavLink>
        <NavLink to="/banking/petty-cash">{t('banking.nav.pettyCash')}</NavLink>
      </Can>
    </nav>
  );
}

/** The Banking area: bank accounts, statements, transfers and rules. */
export function BankingSection() {
  return (
    <>
      <BankingNav />
      <Outlet />
    </>
  );
}
