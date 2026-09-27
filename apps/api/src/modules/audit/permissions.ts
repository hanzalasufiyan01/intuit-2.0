import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the audit module. */
export const AuditPermissions = {
  AuditRead: 'audit.read',
} as const;

export const auditPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: AuditPermissions.AuditRead,
    module: 'audit',
    description: 'View the organization audit history',
  },
];
