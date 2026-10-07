import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Purchase orders, goods receiving and three-way matching. Creating, editing and submitting an
 * order and linking it to a bill need `purchase_orders.create`; approving, receiving, closing and
 * the matching settings each have their own key.
 */
export const PurchaseOrderPermissions = {
  View: 'purchase_orders.view',
  Create: 'purchase_orders.create',
  Approve: 'purchase_orders.approve',
  Receive: 'purchase_orders.receive',
  Close: 'purchase_orders.close',
  SettingsManage: 'purchase_orders.settings.manage',
} as const;

export const purchaseOrderViewPermissions = [PurchaseOrderPermissions.View] as const;

export const purchaseOrderPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: PurchaseOrderPermissions.View,
    module: 'purchases',
    description: 'View purchase orders, goods receipts and commitments',
  },
  {
    key: PurchaseOrderPermissions.Create,
    module: 'purchases',
    description: 'Create, edit, submit and link purchase orders to bills',
  },
  {
    key: PurchaseOrderPermissions.Approve,
    module: 'purchases',
    description: 'Approve purchase orders',
  },
  {
    key: PurchaseOrderPermissions.Receive,
    module: 'purchases',
    description: 'Record and void goods receipts',
  },
  {
    key: PurchaseOrderPermissions.Close,
    module: 'purchases',
    description: 'Close and cancel purchase orders',
  },
  {
    key: PurchaseOrderPermissions.SettingsManage,
    module: 'purchases',
    description: 'Manage three-way matching settings',
  },
];
