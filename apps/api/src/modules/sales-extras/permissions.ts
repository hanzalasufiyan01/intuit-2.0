import type { PermissionDefinition } from '../access-control/index.js';

/** Payment reminder, sales order and invoice share link permissions (FP-28). */
export const SalesExtraPermissions = {
  RemindersView: 'payment_reminders.view',
  RemindersSend: 'payment_reminders.send',
  RemindersSettings: 'payment_reminders.settings.manage',
  OrdersView: 'sales_orders.view',
  OrdersCreate: 'sales_orders.create',
  OrdersInvoice: 'sales_orders.invoice',
  LinksManage: 'invoice_links.manage',
} as const;

export const salesExtraPermissionDefinitions: readonly PermissionDefinition[] = [
  {
    key: SalesExtraPermissions.RemindersView,
    module: 'sales',
    description: 'View overdue invoices and payment reminders',
  },
  {
    key: SalesExtraPermissions.RemindersSend,
    module: 'sales',
    description: 'Send payment reminders for overdue invoices',
  },
  {
    key: SalesExtraPermissions.RemindersSettings,
    module: 'sales',
    description: 'Manage the automatic payment reminder schedule',
  },
  { key: SalesExtraPermissions.OrdersView, module: 'sales', description: 'View sales orders' },
  {
    key: SalesExtraPermissions.OrdersCreate,
    module: 'sales',
    description: 'Create, edit, confirm and cancel sales orders',
  },
  {
    key: SalesExtraPermissions.OrdersInvoice,
    module: 'sales',
    description: 'Create draft invoices from confirmed sales orders',
  },
  {
    key: SalesExtraPermissions.LinksManage,
    module: 'sales',
    description: 'Create and revoke read-only share links for issued invoices',
  },
];
