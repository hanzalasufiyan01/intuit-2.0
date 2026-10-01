import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the customers module (D11; Phase 3B D6). */
export const CustomerPermissions = {
  View: 'customers.view',
  Create: 'customers.create',
  /** Includes the customer's identity (Party) fields when edited from the customer screens (D6). */
  Update: 'customers.update',
  Archive: 'customers.archive',
} as const;

export const customerPermissionDefinitions: readonly PermissionDefinition[] = [
  { key: CustomerPermissions.View, module: 'customers', description: 'View customers' },
  { key: CustomerPermissions.Create, module: 'customers', description: 'Create customers' },
  {
    key: CustomerPermissions.Update,
    module: 'customers',
    description: 'Edit customers, including their contact and tax details',
  },
  {
    key: CustomerPermissions.Archive,
    module: 'customers',
    description: 'Archive and restore customers',
  },
];
