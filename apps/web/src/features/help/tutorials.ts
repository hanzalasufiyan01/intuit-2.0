import type { MessageKey } from '../../i18n/i18n';
import { Permission } from '../../permissions/permissions';

/**
 * The tutorial catalogue (Help centre). A tutorial is structure only: its text lives in the typed
 * message catalog under `help.t.<id>.*` (see `tutorialKey`), so it is translated like every other
 * screen. Each step may point at a page of the application; the page itself decides who may open
 * it, and a tutorial or step the member cannot use is left out or marked unavailable rather than
 * described as if it worked. Nothing here changes data.
 */

export type ModuleKey = 'payroll' | 'projects' | 'clinic';

/** What a tutorial or step needs. UX only: the server enforces permissions on every request. */
export interface Requirement {
  /** Any one of these permissions. */
  anyPermission?: readonly string[];
  /** An optional module that must be switched on for the organization. */
  module?: ModuleKey;
}

export interface TutorialStepDef {
  requires?: Requirement;
  /** The page this step is about (a link is offered when the member can use the step). */
  route?: string;
}

export interface TutorialDef {
  id: string;
  steps: readonly TutorialStepDef[];
  /** How many prerequisite lines the tutorial has in the catalog (`prereq1` ...). */
  prerequisites: number;
  requires?: Requirement;
  /** Pages (path prefixes) for which this is the contextual help. */
  contextPrefixes: readonly string[];
}

export interface Access {
  permissions: readonly string[];
  /** Null while unknown (the member cannot read the module switches). */
  modules: Readonly<Record<ModuleKey, boolean>> | null;
}

const P = Permission;

const SALES_VIEW = [P.InvoicesView, P.CreditNotesView, P.ReceiptsView, P.CustomersView] as const;
const PURCHASES_VIEW = [P.VendorsView, P.BillsView, P.VendorPaymentsView, P.ExpensesView] as const;
const REPORTS = [P.ReportsView, P.SalesReportsView, P.PurchasesReportsView] as const;
const BANKING = [P.BankingTransactionsView, P.BankingReconcile] as const;
const CLINIC = [P.ClinicPatientsView, P.ClinicAppointmentsManage] as const;

export const TUTORIALS: readonly TutorialDef[] = [
  {
    id: 'welcome',
    prerequisites: 1,
    contextPrefixes: [],
    steps: [
      { route: '/' },
      {},
      {},
      { route: '/accounting/setup', requires: { anyPermission: [P.AccountingSetup] } },
      { route: '/account/security' },
    ],
  },
  {
    id: 'dashboard',
    prerequisites: 1,
    contextPrefixes: [],
    steps: [
      { route: '/' },
      {},
      { route: '/accounting/reports/trial-balance', requires: { anyPermission: [P.ReportsView] } },
    ],
  },
  {
    id: 'business-settings',
    prerequisites: 2,
    requires: { anyPermission: [P.OrganizationRead, P.AccountingSetup, P.PeriodsView] },
    contextPrefixes: ['/settings/company-profile', '/accounting/setup', '/accounting/fiscal-years'],
    steps: [
      { route: '/settings/company-profile', requires: { anyPermission: [P.OrganizationRead] } },
      { route: '/accounting/setup', requires: { anyPermission: [P.AccountingSetup] } },
      { route: '/sales/settings', requires: { anyPermission: [P.SalesSettingsManage] } },
      { route: '/purchases/settings', requires: { anyPermission: [P.PurchasesSettingsManage] } },
      { route: '/accounting/periods', requires: { anyPermission: [P.PeriodsView] } },
    ],
  },
  {
    id: 'customers-suppliers',
    prerequisites: 1,
    requires: { anyPermission: [P.CustomersView, P.VendorsView] },
    contextPrefixes: ['/sales/customers', '/purchases/vendors'],
    steps: [
      { route: '/sales/customers', requires: { anyPermission: [P.CustomersView] } },
      { route: '/sales/customers', requires: { anyPermission: [P.CustomersCreate] } },
      { route: '/purchases/vendors', requires: { anyPermission: [P.VendorsView] } },
      { route: '/purchases/vendors', requires: { anyPermission: [P.VendorsCreate] } },
      {},
    ],
  },
  {
    id: 'invoices',
    prerequisites: 2,
    requires: { anyPermission: SALES_VIEW },
    contextPrefixes: ['/sales/invoices', '/sales/receipts', '/sales/credit-notes'],
    steps: [
      { route: '/sales/invoices', requires: { anyPermission: [P.InvoicesView] } },
      { route: '/sales/invoices', requires: { anyPermission: [P.InvoicesCreate] } },
      { requires: { anyPermission: [P.InvoicesCreate] } },
      { route: '/sales/invoices', requires: { anyPermission: [P.InvoicesIssue] } },
      { route: '/sales/receipts', requires: { anyPermission: [P.ReceiptsCreate] } },
      { route: '/sales/credit-notes', requires: { anyPermission: [P.CreditNotesView] } },
    ],
  },
  {
    id: 'expenses-payments',
    prerequisites: 2,
    requires: { anyPermission: PURCHASES_VIEW },
    contextPrefixes: [
      '/purchases/bills',
      '/purchases/expenses',
      '/purchases/payments',
      '/purchases/pay-bills',
    ],
    steps: [
      { route: '/purchases/bills', requires: { anyPermission: [P.BillsView] } },
      { route: '/purchases/bills', requires: { anyPermission: [P.BillsCreate] } },
      { route: '/purchases/expenses', requires: { anyPermission: [P.ExpensesView] } },
      { route: '/purchases/payments', requires: { anyPermission: [P.VendorPaymentsView] } },
      { route: '/purchases/pay-bills', requires: { anyPermission: [P.VendorPaymentsCreate] } },
    ],
  },
  {
    id: 'reports',
    prerequisites: 1,
    requires: { anyPermission: REPORTS },
    contextPrefixes: ['/accounting/reports', '/sales/reports', '/purchases/reports'],
    steps: [
      { route: '/accounting', requires: { anyPermission: [P.ReportsView] } },
      { route: '/accounting/reports/trial-balance', requires: { anyPermission: [P.ReportsView] } },
      {
        route: '/accounting/reports/profit-and-loss',
        requires: { anyPermission: [P.ReportsView] },
      },
      { route: '/accounting/reports/balance-sheet', requires: { anyPermission: [P.ReportsView] } },
      { route: '/sales/reports', requires: { anyPermission: [P.SalesReportsView] } },
      { route: '/purchases/reports', requires: { anyPermission: [P.PurchasesReportsView] } },
      {},
    ],
  },
  {
    id: 'banking',
    prerequisites: 2,
    requires: { anyPermission: BANKING },
    contextPrefixes: ['/banking'],
    steps: [
      { route: '/banking' },
      { route: '/banking' },
      { route: '/banking' },
      { route: '/banking', requires: { anyPermission: [P.BankingReconcile] } },
      {},
    ],
  },
  {
    id: 'inventory-appointments',
    prerequisites: 1,
    requires: { anyPermission: [P.InventoryView, ...CLINIC] },
    contextPrefixes: ['/inventory', '/clinic'],
    steps: [
      { route: '/inventory', requires: { anyPermission: [P.InventoryView] } },
      { requires: { anyPermission: [P.InventoryView] } },
      { route: '/inventory', requires: { anyPermission: [P.InventoryView] } },
      { route: '/settings/modules', requires: { anyPermission: [P.OrganizationRead] } },
      { route: '/clinic', requires: { module: 'clinic', anyPermission: CLINIC } },
      { route: '/clinic', requires: { module: 'clinic', anyPermission: CLINIC } },
    ],
  },
  {
    id: 'roles-security',
    prerequisites: 1,
    contextPrefixes: ['/members', '/roles', '/audit', '/settings/security', '/account/security'],
    steps: [
      { route: '/members', requires: { anyPermission: [P.MembersRead] } },
      { route: '/roles', requires: { anyPermission: [P.RolesRead] } },
      {},
      { route: '/audit', requires: { anyPermission: [P.AuditRead] } },
      { route: '/settings/security', requires: { anyPermission: [P.MembersManage] } },
      { route: '/account/security' },
    ],
  },
];

export function tutorialById(id: string): TutorialDef | undefined {
  return TUTORIALS.find((t) => t.id === id);
}

/** Message key for a part of a tutorial's text: `title`, `summary`, `objective`, `prereq1`, `s1.title` ... */
export function tutorialKey(id: string, part: string): MessageKey {
  return `help.t.${id}.${part}` as MessageKey;
}

export function meets(requires: Requirement | undefined, access: Access): boolean {
  if (!requires) return true;
  if (requires.module && access.modules?.[requires.module] !== true) return false;
  if (
    requires.anyPermission &&
    !requires.anyPermission.some((p) => access.permissions.includes(p))
  ) {
    return false;
  }
  return true;
}

export interface VisibleStep extends TutorialStepDef {
  /** The step's number in the catalog text (`s<number>`), stable whatever the member can see. */
  number: number;
}

/** The steps this member can follow, in order. Steps they cannot use are left out, not described. */
export function visibleSteps(tutorial: TutorialDef, access: Access): VisibleStep[] {
  return tutorial.steps
    .map((step, index) => ({ ...step, number: index + 1 }))
    .filter((step) => meets(step.requires, access));
}

export type Availability = { available: true; steps: VisibleStep[] } | { available: false };

/** Whether the member can follow the tutorial at all, and which steps apply to them. */
export function availability(tutorial: TutorialDef, access: Access): Availability {
  if (!meets(tutorial.requires, access)) return { available: false };
  const steps = visibleSteps(tutorial, access);
  return steps.length > 0 ? { available: true, steps } : { available: false };
}

/** The tutorial that helps with a page, from its path; null when no tutorial covers it. */
export function contextualTutorial(pathname: string): TutorialDef | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  let best: { tutorial: TutorialDef; length: number } | null = null;
  for (const tutorial of TUTORIALS) {
    for (const prefix of tutorial.contextPrefixes) {
      if (
        (path === prefix || path.startsWith(`${prefix}/`)) &&
        (!best || prefix.length > best.length)
      ) {
        best = { tutorial, length: prefix.length };
      }
    }
  }
  return best?.tutorial ?? null;
}
