import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Permissions contributed by the purchases module (ADR 0004 P4-39). Keys join with the stages
 * that use them: Purchases settings (4A-4), bills (4A-5) and vendor credits (4B-1); payments,
 * expenses and reports come later.
 */
export const PurchasesPermissions = {
  /** AP control account, Purchases defaults and numbering (P4-41: MFA set; P4-42: re-auth). */
  SettingsManage: 'purchases.settings.manage',
} as const;

/** Bills (P4-15, P4-21, P4-37, P4-39). */
export const BillPermissions = {
  View: 'bills.view',
  Create: 'bills.create',
  EditDraft: 'bills.edit_draft',
  DeleteDraft: 'bills.delete_draft',
  Post: 'bills.post',
  Void: 'bills.void',
  Approve: 'bills.approve',
} as const;

/** Vendor credits and debit notes (P4-23, P4-24, P4-37, P4-39). Drafts are edited and deleted
 * under `vendor_credits.create` (the catalog has no separate draft keys, Sales credit-note parity). */
export const VendorCreditPermissions = {
  View: 'vendor_credits.view',
  Create: 'vendor_credits.create',
  Post: 'vendor_credits.post',
  Void: 'vendor_credits.void',
  Approve: 'vendor_credits.approve',
} as const;

/** The Member template's bill and vendor-credit access (P4-40: the view keys). */
export const billViewPermissions = [BillPermissions.View] as const;
export const vendorCreditViewPermissions = [VendorCreditPermissions.View] as const;

export const purchasesPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: PurchasesPermissions.SettingsManage,
    module: 'purchases',
    description: 'Manage Purchases settings, numbering and the AP control account',
  },
  { key: BillPermissions.View, module: 'purchases', description: 'View bills' },
  {
    key: BillPermissions.Create,
    module: 'purchases',
    description: 'Create bills, submit them for approval and choose tax recoverability',
  },
  { key: BillPermissions.EditDraft, module: 'purchases', description: 'Edit draft bills' },
  { key: BillPermissions.DeleteDraft, module: 'purchases', description: 'Delete draft bills' },
  {
    key: BillPermissions.Post,
    module: 'purchases',
    description: 'Post bills to the ledger and set a manual exchange rate',
  },
  { key: BillPermissions.Void, module: 'purchases', description: 'Void unpaid posted bills' },
  {
    key: BillPermissions.Approve,
    module: 'purchases',
    description: 'Approve bills before they are posted',
  },
  {
    key: VendorCreditPermissions.View,
    module: 'purchases',
    description: 'View vendor credits and debit notes',
  },
  {
    key: VendorCreditPermissions.Create,
    module: 'purchases',
    description: 'Create, edit, delete and submit draft vendor credits and debit notes',
  },
  {
    key: VendorCreditPermissions.Post,
    module: 'purchases',
    description:
      'Post vendor credits and debit notes, set a manual exchange rate and send debit notes',
  },
  {
    key: VendorCreditPermissions.Void,
    module: 'purchases',
    description: 'Void unapplied vendor credits and debit notes',
  },
  {
    key: VendorCreditPermissions.Approve,
    module: 'purchases',
    description: 'Approve vendor credits and debit notes before they are posted',
  },
];
