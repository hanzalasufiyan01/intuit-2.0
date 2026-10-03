import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Permissions contributed by the catalog module (ADR 0004 P4-06, amended): the neutral key for
 * managing the shared items catalog. `sales.items.manage` (Phase 3B) is superseded by it but not
 * removed; during the transition it still permits catalog management.
 */
export const CatalogPermissions = {
  ItemsManage: 'catalog.items.manage',
} as const;

export const catalogPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: CatalogPermissions.ItemsManage,
    module: 'catalog',
    description: 'Manage the shared items catalog (sales and purchase details)',
  },
];
