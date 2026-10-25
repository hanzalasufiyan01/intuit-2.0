import { useSyncExternalStore } from 'react';
import { matchPath } from 'react-router';
import { ASSET_VIEW_PERMISSIONS } from '../features/assets/AssetPages';
import { BANKING_VIEW_PERMISSIONS } from '../features/banking/BankingSection';
import { CLAIM_VIEW_PERMISSIONS } from '../features/claims/ClaimPages';
import { CLINIC_PERMISSIONS } from '../features/clinic/ClinicPages';
import { IMPORT_PERMISSIONS } from '../features/data-exchange/permissions';
import { INVENTORY_VIEW_PERMISSIONS } from '../features/inventory/InventoryPages';
import { useModules } from '../features/payroll/PayrollPages';
import { PURCHASES_VIEW_PERMISSIONS } from '../features/purchases/PurchasesSection';
import { SALES_VIEW_PERMISSIONS } from '../features/sales/SalesSection';
import type { MessageKey } from '../i18n/i18n';
import { Permission, useAnyPermission, usePermission } from '../permissions/permissions';
import type { NavIconName } from '../shared/nav-icons';

/**
 * The application's main navigation, grouped (UI phase 2). Every link is one that already existed
 * in the flat sidebar, with the same destination, label and visibility rule; only the grouping is
 * new. Visibility here is a convenience for the user: the API decides what a user may do, and each
 * route has its own guard.
 */

export interface NavItem {
  to: string;
  label: MessageKey;
  /** Match the exact path only (the Overview route). */
  end?: boolean;
}

export type NavGroupId =
  | 'workspace'
  | 'finance'
  | 'commerce'
  | 'people'
  | 'data'
  | 'organization'
  | 'integrations'
  | 'security';

export interface NavGroup {
  id: NavGroupId;
  /** Null for the Workspace group, whose single link is shown without a group header. */
  label: MessageKey | null;
  icon: NavIconName;
  /** Groups that start expanded; the group of the current page is always expanded on arrival. */
  defaultExpanded: boolean;
  items: NavItem[];
}

/** The groups that start expanded. Organization and Security & audit start open because their
 *  links (Members, Roles, Audit log ...) are the first things a new owner looks for. */
export const NAV_DEFAULT_EXPANDED: Record<NavGroupId, boolean> = {
  workspace: true,
  finance: true,
  commerce: true,
  people: true,
  data: false,
  organization: true,
  integrations: false,
  security: true,
};

/** The responsive breakpoint at which the sidebar becomes a drawer; keep in step with styles.css. */
export const COMPACT_QUERY = '(max-width: 1024px)';

/**
 * The navigation the current user may see, in display order. Calls the same access-control hooks
 * as before (usePermission, useAnyPermission, useModules); groups with no visible link are left
 * out. Hooks are called unconditionally and in a fixed order.
 */
export function useNavigationGroups(): NavGroup[] {
  const membersRead = usePermission(Permission.MembersRead);
  const rolesRead = usePermission(Permission.RolesRead);
  const auditRead = usePermission(Permission.AuditRead);
  const organizationRead = usePermission(Permission.OrganizationRead);
  const apiTokensView = usePermission(Permission.ApiTokensView);
  const webhooksView = usePermission(Permission.WebhooksView);
  const partiesView = usePermission(Permission.PartiesView);
  const approvalsManage = usePermission(Permission.ApprovalsManage);
  const membersManage = usePermission(Permission.MembersManage);
  const canAccounting = useAnyPermission([Permission.JournalsView, Permission.PeriodsView]);
  const canImport = useAnyPermission(IMPORT_PERMISSIONS);
  const canSales = useAnyPermission(SALES_VIEW_PERMISSIONS);
  const canPurchases = useAnyPermission(PURCHASES_VIEW_PERMISSIONS);
  const canBanking = useAnyPermission(BANKING_VIEW_PERMISSIONS);
  const canInventory = useAnyPermission(INVENTORY_VIEW_PERMISSIONS);
  const canClinic = useAnyPermission(CLINIC_PERMISSIONS);
  const canAssets = useAnyPermission(ASSET_VIEW_PERMISSIONS);
  const canClaims = useAnyPermission(CLAIM_VIEW_PERMISSIONS);
  const modules = useModules();

  const when = (visible: boolean, item: NavItem): NavItem[] => (visible ? [item] : []);

  const groups: NavGroup[] = [
    {
      id: 'workspace',
      label: null,
      icon: 'overview',
      defaultExpanded: NAV_DEFAULT_EXPANDED.workspace,
      items: [{ to: '/', label: 'shell.nav.overview', end: true }],
    },
    {
      id: 'finance',
      label: 'shell.nav.group.finance',
      icon: 'finance',
      defaultExpanded: NAV_DEFAULT_EXPANDED.finance,
      items: [
        ...when(canAccounting, { to: '/accounting', label: 'shell.nav.accounting' }),
        ...when(canBanking, { to: '/banking', label: 'shell.nav.banking' }),
        ...when(canAssets, { to: '/assets', label: 'shell.nav.fixedAssets' }),
        ...when(canClaims, { to: '/claims', label: 'shell.nav.claims' }),
      ],
    },
    {
      id: 'commerce',
      label: 'shell.nav.group.commerce',
      icon: 'commerce',
      defaultExpanded: NAV_DEFAULT_EXPANDED.commerce,
      items: [
        ...when(canSales, { to: '/sales', label: 'shell.nav.sales' }),
        ...when(canPurchases, { to: '/purchases', label: 'shell.nav.purchases' }),
        ...when(canInventory, { to: '/inventory', label: 'shell.nav.inventory' }),
        ...when(partiesView, { to: '/parties', label: 'shell.nav.contacts' }),
      ],
    },
    {
      id: 'people',
      label: 'shell.nav.group.people',
      icon: 'people',
      defaultExpanded: NAV_DEFAULT_EXPANDED.people,
      items: [
        ...when(!!modules.data?.modules.payroll, { to: '/payroll', label: 'shell.nav.payroll' }),
        ...when(!!modules.data?.modules.projects, {
          to: '/projects',
          label: 'shell.nav.projects',
        }),
        ...when(!!modules.data?.modules.clinic && canClinic, {
          to: '/clinic',
          label: 'shell.nav.clinic',
        }),
      ],
    },
    {
      id: 'data',
      label: 'shell.nav.group.data',
      icon: 'data',
      defaultExpanded: NAV_DEFAULT_EXPANDED.data,
      items: [
        ...when(canImport, { to: '/imports', label: 'shell.nav.import' }),
        { to: '/exports', label: 'shell.nav.exports' },
      ],
    },
    {
      id: 'organization',
      label: 'shell.nav.group.organization',
      icon: 'organization',
      defaultExpanded: NAV_DEFAULT_EXPANDED.organization,
      items: [
        ...when(membersRead, { to: '/members', label: 'shell.nav.members' }),
        ...when(membersRead, { to: '/settings/branch-access', label: 'shell.nav.branchAccess' }),
        ...when(rolesRead, { to: '/roles', label: 'shell.nav.roles' }),
        ...when(organizationRead, {
          to: '/settings/company-profile',
          label: 'shell.nav.companyProfile',
        }),
        ...when(organizationRead, { to: '/settings/ownership', label: 'shell.nav.ownership' }),
        ...when(organizationRead, { to: '/settings/groups', label: 'shell.nav.entityGroups' }),
        ...when(organizationRead, { to: '/settings/modules', label: 'shell.nav.modules' }),
        ...when(approvalsManage, { to: '/settings/approvals', label: 'shell.nav.approvals' }),
      ],
    },
    {
      id: 'integrations',
      label: 'shell.nav.group.integrations',
      icon: 'integrations',
      defaultExpanded: NAV_DEFAULT_EXPANDED.integrations,
      items: [
        ...when(apiTokensView, { to: '/settings/integrations', label: 'shell.nav.integrations' }),
        ...when(webhooksView, { to: '/settings/webhooks', label: 'shell.nav.webhooks' }),
      ],
    },
    {
      id: 'security',
      label: 'shell.nav.group.security',
      icon: 'security',
      defaultExpanded: NAV_DEFAULT_EXPANDED.security,
      items: [
        ...when(auditRead, { to: '/audit', label: 'shell.nav.audit' }),
        ...when(membersManage, { to: '/settings/security', label: 'shell.nav.security' }),
      ],
    },
  ];

  return groups.filter((group) => group.items.length > 0);
}

/** The group holding the page being shown, or null when the page is not a navigation item. */
export function findActiveGroupId(groups: NavGroup[], pathname: string): NavGroupId | null {
  for (const group of groups) {
    for (const item of group.items) {
      if (matchPath({ path: item.to, end: item.end ?? false }, pathname)) return group.id;
    }
  }
  return null;
}

/** True while the viewport is at or below the drawer breakpoint. False where matchMedia is absent. */
export function useCompactLayout(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const query = window.matchMedia(COMPACT_QUERY);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}
