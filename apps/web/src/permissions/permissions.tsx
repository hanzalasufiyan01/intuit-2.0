import type { ReactNode } from 'react';
import { useAuth } from '../auth/auth-context';

/** Permission keys (mirrors the server catalog). */
export const Permission = {
  OrganizationRead: 'organization.read',
  OrganizationUpdate: 'organization.update',
  MembersRead: 'members.read',
  MembersInvite: 'members.invite',
  MembersManage: 'members.manage',
  RolesRead: 'roles.read',
  RolesManage: 'roles.manage',
  AuditRead: 'audit.read',
  ApprovalsManage: 'approvals.manage',
  AccountingSetup: 'accounting.setup',
  AccountsView: 'accounting.accounts.view',
  AccountsCreate: 'accounting.accounts.create',
  AccountsUpdate: 'accounting.accounts.update',
  AccountsArchive: 'accounting.accounts.archive',
  AccountsDelete: 'accounting.accounts.delete',
  JournalsView: 'accounting.journals.view',
  JournalsCreate: 'accounting.journals.create',
  JournalsEditDraft: 'accounting.journals.edit_draft',
  JournalsSubmit: 'accounting.journals.submit',
  JournalsApprove: 'accounting.journals.approve',
  JournalsPost: 'accounting.journals.post',
  JournalsReverse: 'accounting.journals.reverse',
  PeriodsView: 'accounting.periods.view',
  PeriodsClose: 'accounting.periods.close',
  PeriodsReopen: 'accounting.periods.reopen',
  LedgerView: 'accounting.ledger.view',
  DimensionsView: 'accounting.dimensions.view',
  DimensionsManage: 'accounting.dimensions.manage',
  ReportsView: 'accounting.reports.view',
  PartiesView: 'parties.view',
  PartiesCreate: 'parties.create',
  PartiesUpdate: 'parties.update',
  PartiesArchive: 'parties.archive',
  // Phase 3B: Sales, customers and tax.
  CustomersView: 'customers.view',
  CustomersCreate: 'customers.create',
  CustomersUpdate: 'customers.update',
  CustomersArchive: 'customers.archive',
  InvoicesView: 'invoices.view',
  InvoicesCreate: 'invoices.create',
  InvoicesEditDraft: 'invoices.edit_draft',
  InvoicesDeleteDraft: 'invoices.delete_draft',
  InvoicesIssue: 'invoices.issue',
  InvoicesVoid: 'invoices.void',
  InvoicesApprove: 'invoices.approve',
  CreditNotesView: 'credit_notes.view',
  CreditNotesCreate: 'credit_notes.create',
  CreditNotesIssue: 'credit_notes.issue',
  CreditNotesApprove: 'credit_notes.approve',
  ReceiptsView: 'receipts.view',
  ReceiptsCreate: 'receipts.create',
  ReceiptsVoid: 'receipts.void',
  SalesSettingsManage: 'sales.settings.manage',
  SalesReportsView: 'sales.reports.view',
  SalesItemsManage: 'sales.items.manage',
  TaxCodesManage: 'tax.codes.manage',
} as const;
export type PermissionKey = (typeof Permission)[keyof typeof Permission];

/**
 * Whether the active organization grants a permission. UX only: the server
 * independently authorizes every request.
 */
export function usePermission(permission: PermissionKey): boolean {
  const { activeOrganization } = useAuth();
  return activeOrganization?.permissions.includes(permission) ?? false;
}

/** True if the active organization grants any of the permissions. */
export function useAnyPermission(permissions: readonly PermissionKey[]): boolean {
  const { activeOrganization } = useAuth();
  return permissions.some((p) => activeOrganization?.permissions.includes(p) ?? false);
}

export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: PermissionKey;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}
