import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Project permissions (FP-26). Viewing needs `projects.view`; managing projects, logging time,
 * approving time and billing it each have their own key so duties can be separated. Granted to
 * owners and administrators; give a custom role `projects.time.log` to let staff log their time.
 */
export const ProjectPermissions = {
  View: 'projects.view',
  Manage: 'projects.manage',
  TimeLog: 'projects.time.log',
  TimeApprove: 'projects.time.approve',
  Bill: 'projects.bill',
} as const;

export const projectPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: ProjectPermissions.View,
    module: 'projects',
    description: 'View projects, time entries and project reports',
  },
  {
    key: ProjectPermissions.Manage,
    module: 'projects',
    description: 'Create and edit projects and their members',
  },
  {
    key: ProjectPermissions.TimeLog,
    module: 'projects',
    description: 'Log and submit your own time on projects you belong to',
  },
  {
    key: ProjectPermissions.TimeApprove,
    module: 'projects',
    description: 'Approve or reject submitted time',
  },
  {
    key: ProjectPermissions.Bill,
    module: 'projects',
    description: 'Create draft invoices from approved billable time',
  },
];
