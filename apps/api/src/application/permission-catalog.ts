import {
  accessControlPermissionDefinitions,
  validatePermissionCatalog,
  type PermissionDefinition,
} from '../modules/access-control/index.js';
import { accountingPermissionDefinitions } from '../modules/accounting/index.js';
import { approvalPermissionDefinitions } from '../modules/approvals/index.js';
import { auditPermissionDefinitions } from '../modules/audit/index.js';
import { organizationPermissionDefinitions } from '../modules/organizations/index.js';
import { partyPermissionDefinitions } from '../modules/parties/index.js';

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
]);
