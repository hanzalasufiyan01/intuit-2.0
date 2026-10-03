import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { useT, type MessageKey } from '../../i18n/i18n';
import { Can, Permission, useAnyPermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import {
  CATALOG_VIEW_PERMISSIONS,
  SALES_SETTINGS_VIEW_PERMISSIONS,
  TAX_CODES_VIEW_PERMISSIONS,
} from './SalesSection';
import type { CustomerSummary, Item, Page, SalesSettings, TaxCode } from './types';

export function useOrgKey(): string {
  return useAuth().activeOrganization?.id ?? 'none';
}

/** Sales sub-navigation; every link is permission-aware (UX only; the server decides). */
export function SalesNav() {
  const t = useT();
  const canItems = useAnyPermission(CATALOG_VIEW_PERMISSIONS);
  const canSettings = useAnyPermission(SALES_SETTINGS_VIEW_PERMISSIONS);
  const canTax = useAnyPermission(TAX_CODES_VIEW_PERMISSIONS);
  return (
    <nav className="subnav" aria-label={t('sales.nav.label')}>
      <Can permission={Permission.InvoicesView}>
        <NavLink to="/sales/invoices">{t('sales.nav.invoices')}</NavLink>
      </Can>
      <Can permission={Permission.CreditNotesView}>
        <NavLink to="/sales/credit-notes">{t('sales.nav.creditNotes')}</NavLink>
      </Can>
      <Can permission={Permission.ReceiptsView}>
        <NavLink to="/sales/receipts">{t('sales.nav.receipts')}</NavLink>
      </Can>
      <Can permission={Permission.CustomersView}>
        <NavLink to="/sales/customers">{t('sales.nav.customers')}</NavLink>
      </Can>
      {canItems ? <NavLink to="/sales/items">{t('sales.nav.items')}</NavLink> : null}
      <Can permission={Permission.SalesReportsView}>
        <NavLink to="/sales/reports">{t('sales.nav.reports')}</NavLink>
      </Can>
      {canSettings ? <NavLink to="/sales/settings">{t('sales.nav.settings')}</NavLink> : null}
      {canTax ? <NavLink to="/sales/tax-codes">{t('sales.nav.taxCodes')}</NavLink> : null}
    </nav>
  );
}

export function useSalesSettings() {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['sales-settings', org],
    queryFn: () => api.get<SalesSettings>('/sales/settings'),
  });
}

export function useTaxCodes(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['tax-codes', org],
    queryFn: () => api.get<TaxCode[]>('/tax/codes'),
    enabled,
  });
}

/** Active customers for pickers (first 200 by name). */
export function useCustomerOptions(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['customer-options', org],
    queryFn: () => api.get<Page<CustomerSummary>>('/customers?limit=200&status=active'),
    enabled,
  });
}

/** Active items for line pickers (first 200 by name). */
export function useItemOptions(enabled = true) {
  const org = useOrgKey();
  return useQuery({
    queryKey: ['item-options', org],
    queryFn: () => api.get<Page<Item>>('/sales/items?limit=200&status=active'),
    enabled,
  });
}

const STATUS_KEYS: Record<string, MessageKey> = {
  DRAFT: 'sales.status.draft',
  PENDING_APPROVAL: 'sales.status.pendingApproval',
  ISSUED: 'sales.status.issued',
  VOID: 'sales.status.void',
  RECORDED: 'sales.status.recorded',
  ACTIVE: 'sales.status.active',
  ARCHIVED: 'sales.status.archived',
};

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const key = STATUS_KEYS[status];
  return <span className={`badge badge--${status.toLowerCase()}`}>{key ? t(key) : status}</span>;
}

/** Turns blank text into null for the API (optional fields). */
export const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

/** Reads an API error code that Issue / Record may return, as a translated hint. */
export function issueHint(code: string | undefined): MessageKey | null {
  switch (code) {
    case 'APPROVAL_REQUIRED':
      return 'sales.error.approvalRequired';
    case 'EXCHANGE_RATE_REQUIRED':
      return 'sales.error.rateRequired';
    case 'PERIOD_CLOSED':
    case 'PERIOD_NOT_FOUND':
      return 'sales.error.period';
    case 'DESIGNATION_REQUIRED':
      return 'sales.error.designation';
    default:
      return null;
  }
}
