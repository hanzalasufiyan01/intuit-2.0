import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the vendors module (ADR 0004 P4-39). */
export const VendorPermissions = {
  View: 'vendors.view',
  Create: 'vendors.create',
  /** Includes the vendor's identity (Party) fields when edited from the vendor screens. */
  Update: 'vendors.update',
  Archive: 'vendors.archive',
} as const;

export const vendorPermissionDefinitions: readonly PermissionDefinition[] = [
  { key: VendorPermissions.View, module: 'vendors', description: 'View vendors' },
  { key: VendorPermissions.Create, module: 'vendors', description: 'Create vendors' },
  {
    key: VendorPermissions.Update,
    module: 'vendors',
    description: 'Edit vendors, including their contact and tax details',
  },
  { key: VendorPermissions.Archive, module: 'vendors', description: 'Archive and restore vendors' },
];
