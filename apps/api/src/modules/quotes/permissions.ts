import type { PermissionDefinition } from '../access-control/index.js';

/**
 * Sales quote and recurring invoice permissions (FP-28). Converting a quote or generating a
 * recurring draft also needs `invoices.create`, because both create a draft invoice.
 */
export const QuotePermissions = {
  View: 'quotes.view',
  Create: 'quotes.create',
  Convert: 'quotes.convert',
  RecurringView: 'recurring_invoices.view',
  RecurringManage: 'recurring_invoices.manage',
} as const;

export const quoteViewPermissions = [
  QuotePermissions.View,
  QuotePermissions.RecurringView,
] as const;

export const quotePermissionDefinitions: readonly PermissionDefinition[] = [
  { key: QuotePermissions.View, module: 'sales', description: 'View sales quotes' },
  {
    key: QuotePermissions.Create,
    module: 'sales',
    description: 'Create, edit, send and record the outcome of sales quotes',
  },
  {
    key: QuotePermissions.Convert,
    module: 'sales',
    description: 'Convert accepted quotes into draft invoices',
  },
  {
    key: QuotePermissions.RecurringView,
    module: 'sales',
    description: 'View recurring invoice schedules',
  },
  {
    key: QuotePermissions.RecurringManage,
    module: 'sales',
    description: 'Create, edit, pause and run recurring invoice schedules',
  },
];
