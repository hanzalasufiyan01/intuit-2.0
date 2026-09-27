import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the approvals module. */
export const ApprovalPermissions = {
  ApprovalsManage: 'approvals.manage',
} as const;

export const approvalPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: ApprovalPermissions.ApprovalsManage,
    module: 'approvals',
    description: 'Configure approval policies (approvers, approval groups, required approvals)',
  },
];
