import {
  AccessControlPermissions,
  RoleTemplateKeys,
  type RoleTemplateDefinition,
} from '../modules/access-control/index.js';
import { AccountingPermissions, accountingViewPermissions } from '../modules/accounting/index.js';
import { ApprovalPermissions } from '../modules/approvals/index.js';
import { AuditPermissions } from '../modules/audit/index.js';
import { CatalogPermissions } from '../modules/catalog/index.js';
import { OrganizationPermissions } from '../modules/organizations/index.js';
import { CustomerPermissions } from '../modules/customers/index.js';
import { PartyPermissions } from '../modules/parties/index.js';
import {
  BillPermissions,
  billViewPermissions,
  PurchasesPermissions,
  VendorCreditPermissions,
  vendorCreditViewPermissions,
  VendorPaymentPermissions,
  vendorPaymentViewPermissions,
} from '../modules/purchases/index.js';
import { SalesPermissions, salesViewPermissions } from '../modules/sales/index.js';
import { TaxPermissions } from '../modules/tax/index.js';
import { VendorPermissions } from '../modules/vendors/index.js';

/** Approved Phase 1 system role templates. */
export const roleTemplateDefinitions: readonly RoleTemplateDefinition[] = [
  {
    key: RoleTemplateKeys.Owner,
    name: 'Owner',
    description: 'Organization owner. Protected: exactly one per organization.',
    isOwner: true,
    sortOrder: 0,
    permissions: 'all',
  },
  {
    key: RoleTemplateKeys.Administrator,
    name: 'Administrator',
    description: 'Manages the organization, its members and roles.',
    isOwner: false,
    sortOrder: 1,
    permissions: [
      OrganizationPermissions.OrganizationRead,
      OrganizationPermissions.OrganizationUpdate,
      OrganizationPermissions.MembersRead,
      OrganizationPermissions.MembersInvite,
      OrganizationPermissions.MembersManage,
      AccessControlPermissions.RolesRead,
      AccessControlPermissions.RolesManage,
      AuditPermissions.AuditRead,
      // Phase 2 (decision F25): all accounting and approval-policy permissions.
      ...Object.values(AccountingPermissions),
      ApprovalPermissions.ApprovalsManage,
      // Phase 3A S4 (Decision 65): all party permissions.
      ...Object.values(PartyPermissions),
      // Phase 3B (D14): all Sales, customer and tax permissions.
      ...Object.values(CustomerPermissions),
      ...Object.values(SalesPermissions),
      ...Object.values(TaxPermissions),
      // Phase 4 (ADR 0004 P4-39): all vendor permissions.
      ...Object.values(VendorPermissions),
      // Phase 4A-4 (P4-06, P4-39): the shared catalog and Purchases settings.
      ...Object.values(CatalogPermissions),
      ...Object.values(PurchasesPermissions),
      // Phase 4A-5 (P4-39): all bill permissions.
      ...Object.values(BillPermissions),
      // Phase 4B-1 (P4-39): all vendor-credit permissions.
      ...Object.values(VendorCreditPermissions),
      // Phase 4B-2 (P4-39): all vendor-payment permissions.
      ...Object.values(VendorPaymentPermissions),
    ],
  },
  {
    key: RoleTemplateKeys.Member,
    name: 'Member',
    description: 'Basic access to the organization.',
    isOwner: false,
    sortOrder: 2,
    permissions: [
      OrganizationPermissions.OrganizationRead,
      OrganizationPermissions.MembersRead,
      // Phase 2 (decision F25): accounting view permissions.
      ...accountingViewPermissions,
      // Phase 3A S4 (Decision 65): party view.
      PartyPermissions.View,
      // Phase 3B (D14): Sales view-only.
      CustomerPermissions.View,
      ...salesViewPermissions,
      // Phase 4 (ADR 0004 P4-40): vendor view.
      VendorPermissions.View,
      // Phase 4A-5 (P4-40): bill view.
      ...billViewPermissions,
      // Phase 4B-1 (P4-40): vendor-credit view.
      ...vendorCreditViewPermissions,
      // Phase 4B-2 (P4-40): vendor-payment view.
      ...vendorPaymentViewPermissions,
    ],
  },
];
