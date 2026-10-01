import { Permission, type PermissionKey } from '../../permissions/permissions';

/** The create permissions of the S6 import domains (Decision 65; UX only, the server decides). */
export const IMPORT_PERMISSIONS: PermissionKey[] = [
  Permission.AccountsCreate,
  Permission.PartiesCreate,
  Permission.PartiesUpdate,
  Permission.DimensionsManage,
  Permission.AccountingSetup,
  Permission.JournalsCreate,
  // Phase 3B: customers, items and AR opening invoices.
  Permission.CustomersCreate,
  Permission.SalesItemsManage,
  Permission.InvoicesCreate,
];
