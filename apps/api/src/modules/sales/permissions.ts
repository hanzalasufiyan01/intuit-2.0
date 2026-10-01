import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Permissions contributed by the sales module: the frozen keys of D11, extended by Decisions 30
 * (`invoices.approve`, `credit_notes.approve`), 31 (`sales.items.manage`) and 40 (`receipts.void`).
 * There is no `invoices.delete` (drafts use `invoices.delete_draft`; issued invoices are voided).
 */
export const SalesPermissions = {
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
  SettingsManage: 'sales.settings.manage',
  ReportsView: 'sales.reports.view',
  ItemsManage: 'sales.items.manage',
} as const;

/** The Sales view keys a Member receives (D14: Member view-only). */
export const salesViewPermissions = [
  SalesPermissions.InvoicesView,
  SalesPermissions.CreditNotesView,
  SalesPermissions.ReceiptsView,
  SalesPermissions.ReportsView,
] as const;

const define = (key: string, description: string): PermissionDefinition => ({
  key,
  module: 'sales',
  description,
});

export const salesPermissionDefinitions: readonly PermissionDefinition[] = [
  define(SalesPermissions.InvoicesView, 'View invoices'),
  define(SalesPermissions.InvoicesCreate, 'Create draft invoices'),
  define(SalesPermissions.InvoicesEditDraft, 'Edit draft invoices'),
  define(SalesPermissions.InvoicesDeleteDraft, 'Delete draft invoices'),
  define(SalesPermissions.InvoicesIssue, 'Issue invoices (posts them to the ledger)'),
  define(SalesPermissions.InvoicesVoid, 'Void unpaid issued invoices'),
  define(SalesPermissions.InvoicesApprove, 'Approve invoices before they are issued'),
  define(SalesPermissions.CreditNotesView, 'View credit notes'),
  define(SalesPermissions.CreditNotesCreate, 'Create, edit and delete draft credit notes'),
  define(SalesPermissions.CreditNotesIssue, 'Issue credit notes (posts them to the ledger)'),
  define(SalesPermissions.CreditNotesApprove, 'Approve credit notes before they are issued'),
  define(SalesPermissions.ReceiptsView, 'View customer receipts and allocations'),
  define(
    SalesPermissions.ReceiptsCreate,
    'Record receipts, allocate them and apply customer credit',
  ),
  define(SalesPermissions.ReceiptsVoid, 'Void receipts'),
  define(SalesPermissions.SettingsManage, 'Manage sales settings, numbering and default accounts'),
  define(SalesPermissions.ReportsView, 'View sales reports, aging and customer statements'),
  define(SalesPermissions.ItemsManage, 'Manage the items catalog'),
];
