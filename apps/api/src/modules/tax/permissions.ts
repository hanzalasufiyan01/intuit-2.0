import type { PermissionDefinition } from '../access-control/index.js';

/** Permissions contributed by the tax module (Decision 31). */
export const TaxPermissions = {
  /** Create and change tax codes and their rate versions (re-authentication, D12). */
  CodesManage: 'tax.codes.manage',
} as const;

export const taxPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: TaxPermissions.CodesManage,
    module: 'tax',
    description: 'Create and change tax codes and their effective-dated rates',
  },
];
