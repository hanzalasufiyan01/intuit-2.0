import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the organizations module. */
export const OrganizationPermissions = {
  OrganizationRead: 'organization.read',
  OrganizationUpdate: 'organization.update',
  MembersRead: 'members.read',
  MembersInvite: 'members.invite',
  MembersManage: 'members.manage',
} as const;

export const organizationPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: OrganizationPermissions.OrganizationRead,
    module: 'organizations',
    description: 'View the organization profile',
  },
  {
    key: OrganizationPermissions.OrganizationUpdate,
    module: 'organizations',
    description: 'Edit the organization profile',
  },
  {
    key: OrganizationPermissions.MembersRead,
    module: 'organizations',
    description: 'View members and their roles',
  },
  {
    key: OrganizationPermissions.MembersInvite,
    module: 'organizations',
    description: 'Invite people and manage pending invitations',
  },
  {
    key: OrganizationPermissions.MembersManage,
    module: 'organizations',
    description: 'Change member roles and disable or re-enable memberships',
  },
];
