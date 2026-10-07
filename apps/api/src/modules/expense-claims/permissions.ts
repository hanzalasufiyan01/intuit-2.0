import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Expense claim permissions. Creating, editing, submitting and cancelling a claim need
 * `expense_claims.create`; approving, posting (which creates the reimbursable bill) and voiding
 * have their own keys. Posting also needs the bill permissions, and the vendor permission when the
 * employee has no vendor record yet; voiding also needs a recent password confirmation.
 */
export const ExpenseClaimPermissions = {
  View: 'expense_claims.view',
  Create: 'expense_claims.create',
  Approve: 'expense_claims.approve',
  Post: 'expense_claims.post',
  Void: 'expense_claims.void',
  SettingsManage: 'expense_claims.settings.manage',
} as const;

export const expenseClaimViewPermissions = [ExpenseClaimPermissions.View] as const;

export const expenseClaimPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: ExpenseClaimPermissions.View,
    module: 'expense_claims',
    description: 'View expense claims',
  },
  {
    key: ExpenseClaimPermissions.Create,
    module: 'expense_claims',
    description: 'Create, edit, submit and cancel expense claims',
  },
  {
    key: ExpenseClaimPermissions.Approve,
    module: 'expense_claims',
    description: 'Approve expense claims',
  },
  {
    key: ExpenseClaimPermissions.Post,
    module: 'expense_claims',
    description: 'Post approved expense claims for reimbursement',
  },
  {
    key: ExpenseClaimPermissions.Void,
    module: 'expense_claims',
    description: 'Void posted expense claims',
  },
  {
    key: ExpenseClaimPermissions.SettingsManage,
    module: 'expense_claims',
    description: 'Manage expense claim settings',
  },
];
