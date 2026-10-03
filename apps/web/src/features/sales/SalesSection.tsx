import { Outlet } from 'react-router';
import { LocaleProvider } from '../../i18n/i18n';
import { Permission } from '../../permissions/permissions';

/** Any of these shows the Sales area in the navigation (UX only; the server decides). */
export const SALES_VIEW_PERMISSIONS = [
  Permission.InvoicesView,
  Permission.CreditNotesView,
  Permission.ReceiptsView,
  Permission.CustomersView,
  Permission.SalesReportsView,
  Permission.SalesItemsManage,
  Permission.SalesSettingsManage,
] as const;

/** Who may read Sales settings (mirrors the server's SETTINGS_VIEW_PERMISSIONS). */
export const SALES_SETTINGS_VIEW_PERMISSIONS = [
  Permission.SalesSettingsManage,
  Permission.InvoicesView,
  Permission.InvoicesCreate,
  Permission.CreditNotesCreate,
  Permission.ReceiptsCreate,
] as const;

/** Who may read tax codes (mirrors the server's TAX_VIEW_PERMISSIONS). */
export const TAX_CODES_VIEW_PERMISSIONS = [
  Permission.TaxCodesManage,
  Permission.SalesSettingsManage,
  Permission.SalesItemsManage,
  Permission.CatalogItemsManage, // ADR 0004 P4-06
  Permission.PurchasesSettingsManage, // ADR 0004 P4-07
  Permission.InvoicesView,
  Permission.InvoicesCreate,
  Permission.CreditNotesView,
] as const;

/** Who may change the shared items catalog: the neutral key, or the superseded Sales key (P4-06). */
export const CATALOG_MANAGE_PERMISSIONS = [
  Permission.CatalogItemsManage,
  Permission.SalesItemsManage,
] as const;

/** Who may open the items catalog (mirrors the server's item view rule). */
export const CATALOG_VIEW_PERMISSIONS = [
  Permission.InvoicesView,
  ...CATALOG_MANAGE_PERMISSIONS,
] as const;

/** The Sales area: its pages render inside the locale (and text-direction) provider (D13). */
export function SalesSection() {
  return (
    <LocaleProvider locale="en">
      <Outlet />
    </LocaleProvider>
  );
}
