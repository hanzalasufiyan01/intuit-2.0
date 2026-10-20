import {
  AccessControlPermissions,
  RoleTemplateKeys,
  type RoleTemplateDefinition,
} from '../modules/access-control/index.js';
import { AccountingPermissions, accountingViewPermissions } from '../modules/accounting/index.js';
import {
  ApiIntegrationPermissions,
  apiIntegrationViewPermissions,
} from '../modules/api-integrations/index.js';
import { ApprovalPermissions } from '../modules/approvals/index.js';
import { AuditPermissions } from '../modules/audit/index.js';
import { BankingPermissions, bankingViewPermissions } from '../modules/banking/index.js';
import { CatalogPermissions } from '../modules/catalog/index.js';
import { ClinicPermissions } from '../modules/clinic/index.js';
import {
  ExpenseClaimPermissions,
  expenseClaimViewPermissions,
} from '../modules/expense-claims/index.js';
import { FixedAssetPermissions, fixedAssetViewPermissions } from '../modules/fixed-assets/index.js';
import { InventoryPermissions, inventoryViewPermissions } from '../modules/inventory/index.js';
import {
  PurchaseOrderPermissions,
  purchaseOrderViewPermissions,
} from '../modules/purchase-orders/index.js';
import { OrganizationPermissions } from '../modules/organizations/index.js';
import { CustomerPermissions } from '../modules/customers/index.js';
import { PartyPermissions } from '../modules/parties/index.js';
import { PayrollPermissions } from '../modules/payroll/index.js';
import { ProjectPermissions } from '../modules/projects/index.js';
import { QuotePermissions } from '../modules/quotes/index.js';
import {
  BillPermissions,
  billViewPermissions,
  ExpensePermissions,
  expenseViewPermissions,
  PurchasesPermissions,
  purchasesReportViewPermissions,
  VendorCreditPermissions,
  vendorCreditViewPermissions,
  VendorPaymentPermissions,
  vendorPaymentViewPermissions,
} from '../modules/purchases/index.js';
import { PaymentPermissions } from '../modules/payments/index.js';
import { SalesExtraPermissions } from '../modules/sales-extras/index.js';
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
      // Includes the AP report key (Phase 4B-5, PD3).
      ...Object.values(PurchasesPermissions),
      // Phase 4A-5 (P4-39): all bill permissions.
      ...Object.values(BillPermissions),
      // Phase 4B-1 (P4-39): all vendor-credit permissions.
      ...Object.values(VendorCreditPermissions),
      // Phase 4B-2 (P4-39): all vendor-payment permissions.
      ...Object.values(VendorPaymentPermissions),
      // Phase 4B-9 (P4-39): all direct-expense permissions.
      ...Object.values(ExpensePermissions),
      // Banking: all permissions.
      ...Object.values(BankingPermissions),
      // Inventory: all permissions.
      ...Object.values(InventoryPermissions),
      // Purchase orders: all permissions.
      ...Object.values(PurchaseOrderPermissions),
      // Fixed assets: all permissions.
      ...Object.values(FixedAssetPermissions),
      // Expense claims: all permissions.
      ...Object.values(ExpenseClaimPermissions),
      // Public API (ADR 0011): integrations, tokens and webhooks.
      ...Object.values(ApiIntegrationPermissions),
      // Payroll (FP-25): sensitive; owners and administrators only.
      ...Object.values(PayrollPermissions),
      // Projects (FP-26).
      ...Object.values(ProjectPermissions),
      // Clinic extension (FP-27, ADR 0013): sensitive; owners and administrators only.
      ...Object.values(ClinicPermissions),
      // Sales quotes and recurring invoices (FP-28).
      ...Object.values(QuotePermissions),
      // Payment reminders, sales orders and invoice share links (FP-28).
      ...Object.values(SalesExtraPermissions),
      // Online payment gateway (migration 0075).
      ...Object.values(PaymentPermissions),
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
      // Phase 4B-5 (P4-40, PD3): AP reports.
      ...purchasesReportViewPermissions,
      // Phase 4B-9 (P4-40): expense view.
      ...expenseViewPermissions,
      // Banking: view only.
      ...bankingViewPermissions,
      // Inventory: view only.
      ...inventoryViewPermissions,
      // Purchase orders: view only.
      ...purchaseOrderViewPermissions,
      // Fixed assets: view only.
      ...fixedAssetViewPermissions,
      // Expense claims: view only.
      ...expenseClaimViewPermissions,
      // Public API: view only (Member never manages integrations).
      ...apiIntegrationViewPermissions,
    ],
  },
];
