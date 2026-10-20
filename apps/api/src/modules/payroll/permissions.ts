import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Payroll permissions (sensitive; granted to owners and administrators only). Viewing payroll data
 * needs `payroll.view`; every workflow step has its own key so duties can be separated. An
 * employee linked to a user always sees their own payslips without any payroll permission.
 */
export const PayrollPermissions = {
  View: 'payroll.view',
  EmployeesManage: 'payroll.employees.manage',
  SettingsManage: 'payroll.settings.manage',
  RunsCreate: 'payroll.runs.create',
  RunsApprove: 'payroll.runs.approve',
  RunsPost: 'payroll.runs.post',
  RunsPay: 'payroll.runs.pay',
  RunsVoid: 'payroll.runs.void',
  LeaveManage: 'payroll.leave.manage',
  AdvancesManage: 'payroll.advances.manage',
} as const;

export const payrollPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: PayrollPermissions.View,
    module: 'payroll',
    description: 'View employees, pay components, pay runs and payslips',
  },
  {
    key: PayrollPermissions.EmployeesManage,
    module: 'payroll',
    description: 'Create and edit employees and their pay components',
  },
  {
    key: PayrollPermissions.SettingsManage,
    module: 'payroll',
    description: 'Manage payroll settings and pay component definitions',
  },
  {
    key: PayrollPermissions.RunsCreate,
    module: 'payroll',
    description: 'Create and recalculate draft pay runs',
  },
  { key: PayrollPermissions.RunsApprove, module: 'payroll', description: 'Approve pay runs' },
  {
    key: PayrollPermissions.RunsPost,
    module: 'payroll',
    description: 'Post approved pay runs to the general ledger',
  },
  {
    key: PayrollPermissions.RunsPay,
    module: 'payroll',
    description: 'Record the payment of posted pay runs',
  },
  {
    key: PayrollPermissions.RunsVoid,
    module: 'payroll',
    description: 'Void pay runs that are not yet paid',
  },
  {
    key: PayrollPermissions.LeaveManage,
    module: 'payroll',
    description: 'Manage leave types and approve or reject leave requests',
  },
  {
    key: PayrollPermissions.AdvancesManage,
    module: 'payroll',
    description: 'Grant, view and cancel salary advances',
  },
];
