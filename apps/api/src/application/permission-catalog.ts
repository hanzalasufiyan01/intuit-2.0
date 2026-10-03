import {
  accessControlPermissionDefinitions,
  validatePermissionCatalog,
  type PermissionDefinition,
} from '../modules/access-control/index.js';
import { accountingPermissionDefinitions } from '../modules/accounting/index.js';
import { approvalPermissionDefinitions } from '../modules/approvals/index.js';
import { auditPermissionDefinitions } from '../modules/audit/index.js';
import { catalogPermissionDefinitions } from '../modules/catalog/index.js';
import { organizationPermissionDefinitions } from '../modules/organizations/index.js';
import { customerPermissionDefinitions } from '../modules/customers/index.js';
import { partyPermissionDefinitions } from '../modules/parties/index.js';
import { purchasesPermissionDefinitions } from '../modules/purchases/index.js';
import { salesPermissionDefinitions } from '../modules/sales/index.js';
import { taxPermissionDefinitions } from '../modules/tax/index.js';
import { vendorPermissionDefinitions } from '../modules/vendors/index.js';

/**
 * The global permission catalog, aggregated from every module's contribution.
 * Later phases add their module's definitions here.
 */
export const permissionCatalog: readonly PermissionDefinition[] = validatePermissionCatalog([
  ...organizationPermissionDefinitions,
  ...accessControlPermissionDefinitions,
  ...auditPermissionDefinitions,
  ...approvalPermissionDefinitions,
  ...accountingPermissionDefinitions,
  ...partyPermissionDefinitions,
  // Phase 3B (D11, Decisions 30, 31, 40): Sales, customers and tax.
  ...customerPermissionDefinitions,
  ...salesPermissionDefinitions,
  ...taxPermissionDefinitions,
  // Phase 4 (ADR 0004 P4-39): vendors.
  ...vendorPermissionDefinitions,
  // Phase 4A-4 (P4-06, P4-39): the shared catalog key and Purchases settings.
  ...catalogPermissionDefinitions,
  ...purchasesPermissionDefinitions,
]);
