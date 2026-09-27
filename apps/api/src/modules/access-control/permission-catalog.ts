/**
 * Permission catalog contract. Permissions are global; each module contributes its own
 * definitions and the composition root aggregates them (see application/permission-catalog.ts).
 */
export interface PermissionDefinition {
  /** `<resource>.<action>`, lower snake case, e.g. `members.invite`. */
  key: string;
  /** Owning module name. */
  module: string;
  description: string;
}

const PERMISSION_KEY_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/**
 * Permissions that must never exist. Financial records are never physically deleted:
 * invoices use `invoices.delete_draft` and `invoices.void` instead of `invoices.delete`.
 */
export const FORBIDDEN_PERMISSION_KEYS: ReadonlySet<string> = new Set(['invoices.delete']);

export class PermissionCatalogError extends Error {}

/** Validates a module-contributed catalog before it is seeded. */
export function validatePermissionCatalog(
  definitions: readonly PermissionDefinition[],
): readonly PermissionDefinition[] {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (!PERMISSION_KEY_PATTERN.test(definition.key)) {
      throw new PermissionCatalogError(`Invalid permission key "${definition.key}"`);
    }
    if (FORBIDDEN_PERMISSION_KEYS.has(definition.key)) {
      throw new PermissionCatalogError(
        `Permission "${definition.key}" is forbidden; use explicit draft-deletion / void permissions`,
      );
    }
    if (seen.has(definition.key)) {
      throw new PermissionCatalogError(`Duplicate permission key "${definition.key}"`);
    }
    seen.add(definition.key);
  }
  return definitions;
}

/** Permissions contributed by the access-control module. */
export const AccessControlPermissions = {
  RolesRead: 'roles.read',
  RolesManage: 'roles.manage',
} as const;

export const accessControlPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: AccessControlPermissions.RolesRead,
    module: 'access-control',
    description: 'View roles and the permission catalog',
  },
  {
    key: AccessControlPermissions.RolesManage,
    module: 'access-control',
    description: 'Create, edit and delete organization roles',
  },
];
