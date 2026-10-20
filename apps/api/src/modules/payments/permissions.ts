import type { PermissionDefinition } from '../access-control/index.js';

/** Online payment gateway permissions (migration 0075). Owners and administrators only by default. */
export const PaymentPermissions = {
  View: 'payments.view',
  IntentsCreate: 'payments.intents.create',
  Reconcile: 'payments.reconcile',
  SettingsManage: 'payments.settings.manage',
} as const;

export const paymentPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: PaymentPermissions.View,
    module: 'sales',
    description: 'View online payment attempts and the gateway settings',
  },
  {
    key: PaymentPermissions.IntentsCreate,
    module: 'sales',
    description: 'Start online payments for issued invoices',
  },
  {
    key: PaymentPermissions.Reconcile,
    module: 'sales',
    description: 'Check a payment attempt against the provider and record it',
  },
  {
    key: PaymentPermissions.SettingsManage,
    module: 'sales',
    description: 'Manage the online payment gateway settings',
  },
];
