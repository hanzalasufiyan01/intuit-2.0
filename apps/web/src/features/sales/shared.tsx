import { useQuery } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { useT, type MessageKey, type Translate } from '../../i18n/i18n';
import { Badge, type BadgeTone } from '../../shared/ui/Badge';
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
      <Can permission={Permission.ReceiptsView}>
        <NavLink to="/sales/refunds">Refunds</NavLink>
      </Can>
      <Can permission={Permission.QuotesView}>
        <NavLink to="/sales/quotes">Quotes</NavLink>
      </Can>
      <Can permission={Permission.RecurringInvoicesView}>
        <NavLink to="/sales/recurring">Recurring</NavLink>
      </Can>
      <Can permission={Permission.SalesOrdersView}>
        <NavLink to="/sales/orders">Orders</NavLink>
      </Can>
      <Can permission={Permission.PaymentRemindersView}>
        <NavLink to="/sales/reminders">Reminders</NavLink>
      </Can>
      <Can permission={Permission.PaymentsView}>
        <NavLink to="/sales/online-payments">Online payments</NavLink>
      </Can>
      <Can permission={Permission.CustomersView}>
        <NavLink to="/sales/customers">{t('sales.nav.customers')}</NavLink>
      </Can>
      {canItems ? <NavLink to="/sales/items">{t('sales.nav.items')}</NavLink> : null}
      <Can permission={Permission.CustomersView}>
        <NavLink to="/sales/classification">Groups and categories</NavLink>
      </Can>
      <Can permission={Permission.SalesReportsView}>
        <NavLink to="/sales/reports">{t('sales.nav.reports')}</NavLink>
        <NavLink to="/sales/trend">Sales trend</NavLink>
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

/** The statuses this badge knows: each states its label and its tone, so the colour is explicit. */
const STATUS_BADGES = {
  DRAFT: { key: 'sales.status.draft', tone: 'neutral' },
  PENDING_APPROVAL: { key: 'sales.status.pendingApproval', tone: 'warning' },
  ISSUED: { key: 'sales.status.issued', tone: 'success' },
  VOID: { key: 'sales.status.void', tone: 'danger' },
  RECORDED: { key: 'sales.status.recorded', tone: 'success' },
  POSTED: { key: 'sales.status.posted', tone: 'success' },
  ACTIVE: { key: 'sales.status.active', tone: 'success' },
  ARCHIVED: { key: 'sales.status.archived', tone: 'neutral' },
} satisfies Record<string, { key: MessageKey; tone: BadgeTone }>;

/** Every status the shared badge colours explicitly. */
export type KnownStatus = keyof typeof STATUS_BADGES;

/** The translated label of a status for running text; one the shared badge does not know is shown as it came. */
export function statusLabel(t: Translate, status: string): string {
  return Object.hasOwn(STATUS_BADGES, status)
    ? t(STATUS_BADGES[status as keyof typeof STATUS_BADGES].key)
    : status;
}

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const known = Object.hasOwn(STATUS_BADGES, status)
    ? STATUS_BADGES[status as keyof typeof STATUS_BADGES]
    : null;
  // Every status the callers can pass is in the map. Anything else (a status added on the server
  // before the UI knows it) is shown as it came, in the neutral tone, never mis-coloured.
  if (!known) return <Badge tone="neutral">{status}</Badge>;
  return <Badge tone={known.tone}>{t(known.key)}</Badge>;
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
