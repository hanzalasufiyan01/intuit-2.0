import {
  AccessControlPermissions,
  RoleTemplateKeys,
  type RoleTemplateDefinition,
} from '../modules/access-control/index.js';
import { AccountingPermissions, accountingViewPermissions } from '../modules/accounting/index.js';
import { ApprovalPermissions } from '../modules/approvals/index.js';
import { AuditPermissions } from '../modules/audit/index.js';
import { OrganizationPermissions } from '../modules/organizations/index.js';

/** Approved Phase 1 system role templates. */
export const roleTemplateDefinitions: readonly RoleTemplateDefinition[] = [
  {
    key: RoleTemplateKeys.Owner,
    name: 'Owner',
    description: 'Organization owner. Protected: exactly one per organization.',
    isOwner: true,
    sortOrder: 0,
    permissions: 'all',
  },
  {
    key: RoleTemplateKeys.Administrator,
    name: 'Administrator',
    description: 'Manages the organization, its members and roles.',
    isOwner: false,
    sortOrder: 1,
    permissions: [
      OrganizationPermissions.OrganizationRead,
      OrganizationPermissions.OrganizationUpdate,
      OrganizationPermissions.MembersRead,
      OrganizationPermissions.MembersInvite,
      OrganizationPermissions.MembersManage,
      AccessControlPermissions.RolesRead,
      AccessControlPermissions.RolesManage,
      AuditPermissions.AuditRead,
      // Phase 2 (decision F25): all accounting and approval-policy permissions.
      ...Object.values(AccountingPermissions),
      ApprovalPermissions.ApprovalsManage,
    ],
  },
  {
    key: RoleTemplateKeys.Member,
    name: 'Member',
    description: 'Basic access to the organization.',
    isOwner: false,
    sortOrder: 2,
    permissions: [
      OrganizationPermissions.OrganizationRead,
      OrganizationPermissions.MembersRead,
      // Phase 2 (decision F25): accounting view permissions.
      ...accountingViewPermissions,
    ],
  },
];
