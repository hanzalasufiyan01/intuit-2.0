import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Inventory permissions. Viewing stock, the stock ledger and valuation needs `inventory.view`;
 * tracking an item, settings and adjustments each have their own key. Voiding an adjustment also
 * needs a recent password confirmation.
 */
export const InventoryPermissions = {
  View: 'inventory.view',
  ItemsManage: 'inventory.items.manage',
  SettingsManage: 'inventory.settings.manage',
  AdjustmentsCreate: 'inventory.adjustments.create',
  AdjustmentsVoid: 'inventory.adjustments.void',
  CountsManage: 'inventory.counts.manage',
} as const;

export const inventoryViewPermissions = [InventoryPermissions.View] as const;

export const inventoryPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: InventoryPermissions.View,
    module: 'inventory',
    description: 'View tracked items, stock levels, the stock ledger and valuation',
  },
  {
    key: InventoryPermissions.ItemsManage,
    module: 'inventory',
    description: 'Start and stop tracking stock for items',
  },
  {
    key: InventoryPermissions.SettingsManage,
    module: 'inventory',
    description: 'Manage inventory settings (negative stock, adjustment account)',
  },
  {
    key: InventoryPermissions.AdjustmentsCreate,
    module: 'inventory',
    description: 'Post stock adjustments',
  },
  {
    key: InventoryPermissions.AdjustmentsVoid,
    module: 'inventory',
    description: 'Void stock adjustments',
  },
  {
    key: InventoryPermissions.CountsManage,
    module: 'inventory',
    description: 'Start, enter, post and cancel physical stock counts',
  },
];
