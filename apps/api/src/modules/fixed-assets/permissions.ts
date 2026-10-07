import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Fixed asset permissions. Viewing the register, schedules and reports needs
 * `fixed_assets.view`; registering assets, categories, settings and transfers share
 * `fixed_assets.manage`; depreciating and disposing have their own keys, and voiding a run or a
 * disposal also needs a recent password confirmation.
 */
export const FixedAssetPermissions = {
  View: 'fixed_assets.view',
  Manage: 'fixed_assets.manage',
  Depreciate: 'fixed_assets.depreciate',
  Dispose: 'fixed_assets.dispose',
  Void: 'fixed_assets.void',
} as const;

export const fixedAssetViewPermissions = [FixedAssetPermissions.View] as const;

export const fixedAssetPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: FixedAssetPermissions.View,
    module: 'fixed_assets',
    description: 'View the fixed asset register, categories, schedules and reports',
  },
  {
    key: FixedAssetPermissions.Manage,
    module: 'fixed_assets',
    description: 'Manage categories and settings, register and edit assets, and transfer them',
  },
  {
    key: FixedAssetPermissions.Depreciate,
    module: 'fixed_assets',
    description: 'Run depreciation',
  },
  {
    key: FixedAssetPermissions.Dispose,
    module: 'fixed_assets',
    description: 'Dispose of fixed assets',
  },
  {
    key: FixedAssetPermissions.Void,
    module: 'fixed_assets',
    description: 'Void depreciation runs and disposals',
  },
];
