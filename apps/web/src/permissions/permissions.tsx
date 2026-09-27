import type { ReactNode } from 'react';
import { useAuth } from '../auth/auth-context';

/** Phase 1 permission keys (mirrors the server catalog). */
export const Permission = {
  OrganizationRead: 'organization.read',
  OrganizationUpdate: 'organization.update',
  MembersRead: 'members.read',
  MembersInvite: 'members.invite',
  MembersManage: 'members.manage',
  RolesRead: 'roles.read',
  RolesManage: 'roles.manage',
  AuditRead: 'audit.read',
} as const;
export type PermissionKey = (typeof Permission)[keyof typeof Permission];

/**
 * Whether the active organization grants a permission. UX only: the server
 * independently authorizes every request.
 */
export function usePermission(permission: PermissionKey): boolean {
  const { activeOrganization } = useAuth();
  return activeOrganization?.permissions.includes(permission) ?? false;
}

export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: PermissionKey;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return usePermission(permission) ? <>{children}</> : <>{fallback}</>;
}
