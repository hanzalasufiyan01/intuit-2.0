import { Navigate, NavLink, Outlet } from 'react-router';
import { LocaleProvider, useT } from '../../i18n/i18n';
import { Can, Permission, useAnyPermission, usePermission } from '../../permissions/permissions';
import { CATALOG_MANAGE_PERMISSIONS } from '../sales/SalesSection';

/** Any of these shows the Purchases area in the navigation (UX only; the server decides). */
export const PURCHASES_VIEW_PERMISSIONS = [
  Permission.VendorsView,
  // Phase 4A-5: bills.
  Permission.BillsView,
  // Phase 4B-1: vendor credits and debit notes.
  Permission.VendorCreditsView,
  // Phase 4B-2: vendor payments.
  Permission.VendorPaymentsView,
  // Phase 4B-5: AP reports.
  Permission.PurchasesReportsView,
  // Phase 4A-4: Purchases settings (P4-39) and the shared catalog (P4-06).
  Permission.PurchasesSettingsManage,
  ...CATALOG_MANAGE_PERMISSIONS,
] as const;

/** The Purchases area: its pages render inside the locale (and text-direction) provider (D13). */
export function PurchasesSection() {
  return (
    <LocaleProvider locale="en">
      <Outlet />
    </LocaleProvider>
  );
}

/** Opens the first Purchases page the user may see. */
export function PurchasesHome() {
  const canBills = usePermission(Permission.BillsView);
  const canVendors = usePermission(Permission.VendorsView);
  const canCredits = usePermission(Permission.VendorCreditsView);
  const canPayments = usePermission(Permission.VendorPaymentsView);
  const canReports = usePermission(Permission.PurchasesReportsView);
  const canSettings = usePermission(Permission.PurchasesSettingsManage);
  const canCatalog = useAnyPermission(CATALOG_MANAGE_PERMISSIONS);
  if (canBills) return <Navigate to="bills" replace />;
  if (canCredits) return <Navigate to="vendor-credits" replace />;
  if (canPayments) return <Navigate to="payments" replace />;
  if (canVendors) return <Navigate to="vendors" replace />;
  if (canReports) return <Navigate to="reports" replace />;
  if (canSettings) return <Navigate to="settings" replace />;
  if (canCatalog) return <Navigate to="/sales/items" replace />;
  return <Navigate to="vendors" replace />;
}

/** Purchases sub-navigation; every link is permission-aware (UX only; the server decides). */
export function PurchasesNav() {
  const t = useT();
  const canCatalog = useAnyPermission(CATALOG_MANAGE_PERMISSIONS);
  return (
    <nav className="subnav" aria-label={t('purchases.nav.label')}>
      <Can permission={Permission.BillsView}>
        <NavLink to="/purchases/bills">{t('purchases.nav.bills')}</NavLink>
      </Can>
      <Can permission={Permission.VendorCreditsView}>
        <NavLink to="/purchases/vendor-credits">{t('purchases.nav.vendorCredits')}</NavLink>
      </Can>
      <Can permission={Permission.VendorPaymentsView}>
        <NavLink to="/purchases/payments">{t('purchases.nav.payments')}</NavLink>
      </Can>
      <Can permission={Permission.VendorPaymentsCreate}>
        <NavLink to="/purchases/pay-bills">{t('purchases.nav.payBills')}</NavLink>
      </Can>
      <Can permission={Permission.VendorPaymentsView}>
        <NavLink to="/purchases/refunds">{t('purchases.nav.refunds')}</NavLink>
      </Can>
      <Can permission={Permission.VendorsView}>
        <NavLink to="/purchases/vendors">{t('purchases.nav.vendors')}</NavLink>
      </Can>
      <Can permission={Permission.PurchasesReportsView}>
        <NavLink to="/purchases/reports">{t('purchases.nav.reports')}</NavLink>
      </Can>
      {/* The items catalog is shared with Sales (P4-05); one page serves both. */}
      {canCatalog ? <NavLink to="/sales/items">{t('purchases.nav.items')}</NavLink> : null}
      <Can permission={Permission.PurchasesSettingsManage}>
        <NavLink to="/purchases/settings">{t('purchases.nav.settings')}</NavLink>
      </Can>
    </nav>
  );
}
