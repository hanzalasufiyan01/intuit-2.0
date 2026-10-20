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
  // Phase 4: Purchases (ADR 0004 P4-39).
  VendorsView: 'vendors.view',
  VendorsCreate: 'vendors.create',
  VendorsUpdate: 'vendors.update',
  VendorsArchive: 'vendors.archive',
  // Phase 4A-4: Purchases settings (P4-39) and the shared catalog (P4-06).
  PurchasesSettingsManage: 'purchases.settings.manage',
  // Phase 4B-5: AP aging, vendor statements and the AP reconciliation (P4-39, PD3).
  PurchasesReportsView: 'purchases.reports.view',
  CatalogItemsManage: 'catalog.items.manage',
  // Phase 4A-5: bills (P4-39).
  BillsView: 'bills.view',
  BillsCreate: 'bills.create',
  BillsEditDraft: 'bills.edit_draft',
  BillsDeleteDraft: 'bills.delete_draft',
  BillsPost: 'bills.post',
  BillsVoid: 'bills.void',
  BillsApprove: 'bills.approve',
  // Phase 4B-1: vendor credits and debit notes (P4-39).
  VendorCreditsView: 'vendor_credits.view',
  VendorCreditsCreate: 'vendor_credits.create',
  VendorCreditsPost: 'vendor_credits.post',
  VendorCreditsVoid: 'vendor_credits.void',
  VendorCreditsApprove: 'vendor_credits.approve',
  // Phase 4B-2: vendor payments, prepayments and credit application (P4-39).
  VendorPaymentsView: 'vendor_payments.view',
  VendorPaymentsCreate: 'vendor_payments.create',
  VendorPaymentsVoid: 'vendor_payments.void',
  VendorPaymentsApprove: 'vendor_payments.approve',
  // Phase 4B-9: direct expenses (P4-39).
  ExpensesView: 'expenses.view',
  ExpensesCreate: 'expenses.create',
  ExpensesVoid: 'expenses.void',
  ExpensesApprove: 'expenses.approve',
  // Banking: accounts, statements, matching, transfers, reconciliation and rules.
  BankingAccountsManage: 'banking.accounts.manage',
  BankingTransactionsView: 'banking.transactions.view',
  BankingTransactionsImport: 'banking.transactions.import',
  BankingTransactionsMatch: 'banking.transactions.match',
  BankingTransactionsCategorize: 'banking.transactions.categorize',
  BankingTransfersCreate: 'banking.transfers.create',
  BankingTransfersVoid: 'banking.transfers.void',
  BankingReconcile: 'banking.reconcile',
  BankingRulesManage: 'banking.rules.manage',
  // Purchase orders, goods receiving and three-way matching.
  PurchaseOrdersView: 'purchase_orders.view',
  PurchaseOrdersCreate: 'purchase_orders.create',
  PurchaseOrdersApprove: 'purchase_orders.approve',
  PurchaseOrdersReceive: 'purchase_orders.receive',
  PurchaseOrdersClose: 'purchase_orders.close',
  PurchaseOrdersSettingsManage: 'purchase_orders.settings.manage',
  // Employee expense claims.
  ExpenseClaimsView: 'expense_claims.view',
  ExpenseClaimsCreate: 'expense_claims.create',
  ExpenseClaimsApprove: 'expense_claims.approve',
  ExpenseClaimsPost: 'expense_claims.post',
  ExpenseClaimsVoid: 'expense_claims.void',
  ExpenseClaimsSettingsManage: 'expense_claims.settings.manage',
  // Fixed assets: register, depreciation, disposal and transfers.
  FixedAssetsView: 'fixed_assets.view',
  FixedAssetsManage: 'fixed_assets.manage',
  FixedAssetsDepreciate: 'fixed_assets.depreciate',
  FixedAssetsDispose: 'fixed_assets.dispose',
  FixedAssetsVoid: 'fixed_assets.void',
  // Inventory: tracked items, the stock ledger, adjustments and valuation.
  InventoryView: 'inventory.view',
  InventoryItemsManage: 'inventory.items.manage',
  InventorySettingsManage: 'inventory.settings.manage',
  InventoryAdjustmentsCreate: 'inventory.adjustments.create',
  InventoryAdjustmentsVoid: 'inventory.adjustments.void',
  InventoryCountsManage: 'inventory.counts.manage',
  // Payroll (FP-25).
  PayrollView: 'payroll.view',
  PayrollEmployeesManage: 'payroll.employees.manage',
  PayrollSettingsManage: 'payroll.settings.manage',
  PayrollRunsCreate: 'payroll.runs.create',
  PayrollRunsApprove: 'payroll.runs.approve',
  PayrollRunsPost: 'payroll.runs.post',
  PayrollRunsPay: 'payroll.runs.pay',
  PaymentsView: 'payments.view',
  PaymentsIntentsCreate: 'payments.intents.create',
  PaymentsReconcile: 'payments.reconcile',
  PaymentsSettingsManage: 'payments.settings.manage',
  PayrollRunsVoid: 'payroll.runs.void',
  PayrollLeaveManage: 'payroll.leave.manage',
  PayrollAdvancesManage: 'payroll.advances.manage',
  // Clinic (FP-27, ADR 0013).
  ClinicPatientsView: 'clinic.patients.view',
  ClinicPatientsManage: 'clinic.patients.manage',
  ClinicAppointmentsManage: 'clinic.appointments.manage',
  ClinicBillingCreate: 'clinic.billing.create',
  ClinicReportsView: 'clinic.reports.view',
  // Payment reminders, sales orders and invoice share links (FP-28).
  PaymentRemindersView: 'payment_reminders.view',
  PaymentRemindersSend: 'payment_reminders.send',
  PaymentRemindersSettings: 'payment_reminders.settings.manage',
  SalesOrdersView: 'sales_orders.view',
  SalesOrdersCreate: 'sales_orders.create',
  SalesOrdersInvoice: 'sales_orders.invoice',
  InvoiceLinksManage: 'invoice_links.manage',
  // Sales quotes and recurring invoices (FP-28).
  QuotesView: 'quotes.view',
  QuotesCreate: 'quotes.create',
  QuotesConvert: 'quotes.convert',
  RecurringInvoicesView: 'recurring_invoices.view',
  RecurringInvoicesManage: 'recurring_invoices.manage',
  // Projects (FP-26).
  ProjectsView: 'projects.view',
  ProjectsManage: 'projects.manage',
  ProjectsTimeLog: 'projects.time.log',
  ProjectsTimeApprove: 'projects.time.approve',
  ProjectsBill: 'projects.bill',
  // Public API integrations and webhooks (ADR 0011).
  ApiTokensView: 'api_tokens.view',
  ApiTokensManage: 'api_tokens.manage',
  WebhooksView: 'webhooks.view',
  WebhooksManage: 'webhooks.manage',
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
