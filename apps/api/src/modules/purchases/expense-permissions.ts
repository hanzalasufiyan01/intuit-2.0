import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Direct expenses (Phase 4B-9; ADR 0004 P4-37, P4-39, P4-42). Creating, submitting and posting an
 * expense need `expenses.create` (like recording a payment); the void needs `expenses.void` and a
 * recent password confirmation; approving needs `expenses.approve`.
 */
export const ExpensePermissions = {
  View: 'expenses.view',
  Create: 'expenses.create',
  Void: 'expenses.void',
  Approve: 'expenses.approve',
} as const;

export const expenseViewPermissions = [ExpensePermissions.View] as const;

export const expensePermissionDefinitions: readonly PermissionDefinition[] = [
  { key: ExpensePermissions.View, module: 'purchases', description: 'View direct expenses' },
  {
    key: ExpensePermissions.Create,
    module: 'purchases',
    description: 'Create, edit, submit and post direct expenses',
  },
  { key: ExpensePermissions.Void, module: 'purchases', description: 'Void posted expenses' },
  {
    key: ExpensePermissions.Approve,
    module: 'purchases',
    description: 'Approve direct expenses before posting',
  },
];
