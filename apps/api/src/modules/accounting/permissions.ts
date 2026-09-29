import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the accounting module (approved Phase 2 catalog, extended in Phase 3A). */
export const AccountingPermissions = {
  Setup: 'accounting.setup',
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
  // Phase 3A (Decision 65; S2)
  DimensionsView: 'accounting.dimensions.view',
  DimensionsManage: 'accounting.dimensions.manage',
  // Phase 3A (Decision 65; S3-01): financial statements and their exports
  ReportsView: 'accounting.reports.view',
} as const;

const describe: Record<string, string> = {
  [AccountingPermissions.Setup]:
    'Set up accounting (base currency, COA template), create fiscal years, record exchange rates',
  [AccountingPermissions.AccountsView]: 'View the chart of accounts',
  [AccountingPermissions.AccountsCreate]: 'Create accounts',
  [AccountingPermissions.AccountsUpdate]: 'Edit accounts',
  [AccountingPermissions.AccountsArchive]: 'Archive accounts',
  [AccountingPermissions.AccountsDelete]:
    'Delete accounts that were never used in posted transactions',
  [AccountingPermissions.JournalsView]: 'View journals',
  [AccountingPermissions.JournalsCreate]: 'Create draft journals',
  [AccountingPermissions.JournalsEditDraft]: 'Edit draft journals',
  [AccountingPermissions.JournalsSubmit]: 'Submit journals for approval and withdraw them',
  [AccountingPermissions.JournalsApprove]: 'Approve or reject journals (never one’s own)',
  [AccountingPermissions.JournalsPost]: 'Post journals to the general ledger',
  [AccountingPermissions.JournalsReverse]: 'Reverse posted journals',
  [AccountingPermissions.PeriodsView]: 'View fiscal years and accounting periods',
  [AccountingPermissions.PeriodsClose]: 'Close accounting periods',
  [AccountingPermissions.PeriodsReopen]: 'Reopen closed periods and approve reopen requests',
  [AccountingPermissions.LedgerView]: 'View the general ledger',
  [AccountingPermissions.DimensionsView]: 'View dimension types and values',
  [AccountingPermissions.DimensionsManage]:
    'Manage dimension types, values, required settings and account scopes',
  [AccountingPermissions.ReportsView]:
    'View and export financial statements (Trial Balance, Profit & Loss, Balance Sheet)',
};

export const accountingPermissionDefinitions: readonly PermissionDefinition[] = Object.values(
  AccountingPermissions,
).map((key) => ({ key, module: 'accounting', description: describe[key] ?? key }));

/** View-only accounting permissions (granted to the Member template). */
export const accountingViewPermissions: readonly string[] = [
  AccountingPermissions.AccountsView,
  AccountingPermissions.JournalsView,
  AccountingPermissions.PeriodsView,
  AccountingPermissions.LedgerView,
  AccountingPermissions.DimensionsView,
  AccountingPermissions.ReportsView,
];
