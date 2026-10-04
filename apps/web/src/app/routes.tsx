import type { RouteObject } from 'react-router';
import { LoginPage } from '../auth/pages/LoginPage';
import { MfaChallengePage } from '../auth/pages/MfaChallengePage';
import { ForgotPasswordPage, ResetPasswordPage } from '../auth/pages/PasswordResetPages';
import { RegisterPage } from '../auth/pages/RegisterPage';
import { RedirectIfAuthenticated, RequireAuth, RequirePendingMfa } from '../auth/RequireAuth';
import { PurchasesHome, PurchasesSection } from '../features/purchases/PurchasesSection';
import { PurchasesSettingsPage } from '../features/purchases/SettingsPage';
import {
  BillDetailPage,
  BillsPage,
  EditBillPage,
  NewBillPage,
} from '../features/purchases/BillPages';
import {
  EditVendorCreditPage,
  NewVendorCreditPage,
  VendorCreditDetailPage,
  VendorCreditsPage,
} from '../features/purchases/VendorCreditPages';
import {
  EditPaymentPage,
  NewPaymentPage,
  PaymentDetailPage,
  PaymentsPage,
} from '../features/purchases/PaymentPages';
import { NewVendorPage, VendorDetailPage, VendorsPage } from '../features/purchases/VendorPages';
import { AccountingDashboardPage } from '../features/accounting/AccountingDashboardPage';
import { AccountsPage } from '../features/accounting/AccountsPage';
import { DesignationsPage } from '../features/accounting/DesignationsPage';
import { DimensionsPage } from '../features/accounting/DimensionsPage';
import { JournalDetailPage, NewJournalPage } from '../features/accounting/JournalPages';
import { JournalsPage } from '../features/accounting/JournalsPage';
import { LedgerPage } from '../features/accounting/LedgerPage';
import { OpeningBalancesPage } from '../features/accounting/OpeningBalancesPage';
import {
  BalanceSheetPage,
  ProfitAndLossPage,
  TrialBalancePage,
} from '../features/reports/ReportPages';
import { FiscalYearsPage, PeriodsPage } from '../features/accounting/PeriodPages';
import { SetupPage } from '../features/accounting/SetupPage';
import { ApprovalPoliciesPage } from '../features/approvals/ApprovalPoliciesPage';
import { AuditPage } from '../features/audit/AuditPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { AcceptInvitationPage } from '../features/invitations/AcceptInvitationPage';
import { MembersPage } from '../features/members/MembersPage';
import { CreateOrganizationPage } from '../features/organizations/CreateOrganizationPage';
import { CompanyProfilePage } from '../features/organizations/CompanyProfilePage';
import { NewPartyPage, PartiesPage, PartyDetailPage } from '../features/parties/PartyPages';
import { RolesPage } from '../features/roles/RolesPage';
import { AccountSecurityPage } from '../features/security/AccountSecurityPage';
import { OrganizationSecurityPage } from '../features/security/OrganizationSecurityPage';
import { ExportsPage } from '../features/data-exchange/ExportsPage';
import { ImportsPage } from '../features/data-exchange/ImportsPage';
import { ImportWizardPage } from '../features/data-exchange/ImportWizardPage';
import { IMPORT_PERMISSIONS } from '../features/data-exchange/permissions';
import {
  CreditNoteDetailPage,
  CreditNotesPage,
  EditCreditNotePage,
  NewCreditNotePage,
} from '../features/sales/CreditNotePages';
import {
  CustomerDetailPage,
  CustomersPage,
  NewCustomerPage,
} from '../features/sales/CustomerPages';
import {
  EditInvoicePage,
  InvoiceDetailPage,
  InvoicesPage,
  NewInvoicePage,
} from '../features/sales/InvoicePages';
import { ItemsPage } from '../features/sales/ItemsPage';
import {
  ApplyCreditPage,
  ReceiptDetailPage,
  ReceiptsPage,
  RecordReceiptPage,
} from '../features/sales/ReceiptPages';
import { SalesReportsPage } from '../features/sales/ReportsPage';
import { SalesHomePage } from '../features/sales/SalesHomePage';
import {
  CATALOG_VIEW_PERMISSIONS,
  SALES_SETTINGS_VIEW_PERMISSIONS,
  SALES_VIEW_PERMISSIONS,
  SalesSection,
  TAX_CODES_VIEW_PERMISSIONS,
} from '../features/sales/SalesSection';
import { SalesSettingsPage, TaxCodesPage } from '../features/sales/SettingsPages';
import { Permission } from '../permissions/permissions';
import { RequireAnyPermission, RequirePermission } from '../permissions/RequirePermission';
import { AppLayout } from './AppLayout';
import { RouteError } from './RouteError';

export const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      {
        path: '/login',
        element: (
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        ),
      },
      {
        path: '/register',
        element: (
          <RedirectIfAuthenticated>
            <RegisterPage />
          </RedirectIfAuthenticated>
        ),
      },
      {
        path: '/login/verify',
        element: (
          <RequirePendingMfa>
            <MfaChallengePage />
          </RequirePendingMfa>
        ),
      },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/invitations/accept', element: <AcceptInvitationPage /> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <DashboardPage /> },
          {
            path: 'members',
            element: (
              <RequirePermission permission={Permission.MembersRead}>
                <MembersPage />
              </RequirePermission>
            ),
          },
          {
            path: 'roles',
            element: (
              <RequirePermission permission={Permission.RolesRead}>
                <RolesPage />
              </RequirePermission>
            ),
          },
          {
            path: 'audit',
            element: (
              <RequirePermission permission={Permission.AuditRead}>
                <AuditPage />
              </RequirePermission>
            ),
          },
          { path: 'organizations/new', element: <CreateOrganizationPage /> },
          { path: 'account/security', element: <AccountSecurityPage /> },
          {
            path: 'settings/security',
            element: (
              <RequirePermission permission={Permission.MembersManage}>
                <OrganizationSecurityPage />
              </RequirePermission>
            ),
          },
          {
            path: 'settings/company-profile',
            element: (
              <RequirePermission permission={Permission.OrganizationRead}>
                <CompanyProfilePage />
              </RequirePermission>
            ),
          },
          {
            path: 'parties',
            element: (
              <RequirePermission permission={Permission.PartiesView}>
                <PartiesPage />
              </RequirePermission>
            ),
          },
          {
            path: 'parties/new',
            element: (
              <RequirePermission permission={Permission.PartiesCreate}>
                <NewPartyPage />
              </RequirePermission>
            ),
          },
          {
            path: 'parties/:id',
            element: (
              <RequirePermission permission={Permission.PartiesView}>
                <PartyDetailPage />
              </RequirePermission>
            ),
          },
          {
            path: 'imports',
            element: (
              <RequireAnyPermission permissions={IMPORT_PERMISSIONS}>
                <ImportsPage />
              </RequireAnyPermission>
            ),
          },
          {
            path: 'imports/:id',
            element: (
              <RequireAnyPermission permissions={IMPORT_PERMISSIONS}>
                <ImportWizardPage />
              </RequireAnyPermission>
            ),
          },
          { path: 'exports', element: <ExportsPage /> },
          {
            path: 'settings/approvals',
            element: (
              <RequirePermission permission={Permission.ApprovalsManage}>
                <ApprovalPoliciesPage />
              </RequirePermission>
            ),
          },
          {
            path: 'accounting',
            children: [
              {
                index: true,
                element: (
                  <RequireAnyPermission
                    permissions={[Permission.JournalsView, Permission.PeriodsView]}
                  >
                    <AccountingDashboardPage />
                  </RequireAnyPermission>
                ),
              },
              {
                path: 'setup',
                element: (
                  <RequireAnyPermission
                    permissions={[Permission.AccountingSetup, Permission.AccountsView]}
                  >
                    <SetupPage />
                  </RequireAnyPermission>
                ),
              },
              ...(['opening-balances', 'opening-balances/:id'] as const).map((path) => ({
                path,
                element: (
                  <RequirePermission permission={Permission.JournalsView}>
                    <OpeningBalancesPage />
                  </RequirePermission>
                ),
              })),
              {
                path: 'accounts',
                element: (
                  <RequirePermission permission={Permission.AccountsView}>
                    <AccountsPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'dimensions',
                element: (
                  <RequirePermission permission={Permission.DimensionsView}>
                    <DimensionsPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'designations',
                element: (
                  <RequirePermission permission={Permission.AccountsView}>
                    <DesignationsPage />
                  </RequirePermission>
                ),
              },
              ...(['all', 'drafts', 'approvals', 'posted'] as const).map((view) => ({
                path: view === 'all' ? 'journals' : `journals/${view}`,
                element: (
                  <RequirePermission permission={Permission.JournalsView}>
                    <JournalsPage key={view} view={view} />
                  </RequirePermission>
                ),
              })),
              {
                path: 'journals/new',
                element: (
                  <RequirePermission permission={Permission.JournalsCreate}>
                    <NewJournalPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'journals/:id',
                element: (
                  <RequirePermission permission={Permission.JournalsView}>
                    <JournalDetailPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'fiscal-years',
                element: (
                  <RequirePermission permission={Permission.PeriodsView}>
                    <FiscalYearsPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'periods',
                element: (
                  <RequirePermission permission={Permission.PeriodsView}>
                    <PeriodsPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'ledger',
                element: (
                  <RequirePermission permission={Permission.LedgerView}>
                    <LedgerPage />
                  </RequirePermission>
                ),
              },
              ...(
                [
                  ['trial-balance', <TrialBalancePage key="tb" />],
                  ['profit-and-loss', <ProfitAndLossPage key="pl" />],
                  ['balance-sheet', <BalanceSheetPage key="bs" />],
                ] as const
              ).map(([path, page]) => ({
                path: `reports/${path}`,
                element: (
                  <RequirePermission permission={Permission.ReportsView}>{page}</RequirePermission>
                ),
              })),
            ],
          },
          {
            path: 'sales',
            element: <SalesSection />,
            children: [
              {
                index: true,
                element: (
                  <RequireAnyPermission permissions={SALES_VIEW_PERMISSIONS}>
                    <SalesHomePage />
                  </RequireAnyPermission>
                ),
              },
              ...(
                [
                  ['invoices', Permission.InvoicesView, <InvoicesPage key="invoices" />],
                  ['invoices/new', Permission.InvoicesCreate, <NewInvoicePage key="new-invoice" />],
                  ['invoices/:id', Permission.InvoicesView, <InvoiceDetailPage key="invoice" />],
                  [
                    'invoices/:id/edit',
                    Permission.InvoicesEditDraft,
                    <EditInvoicePage key="edit-invoice" />,
                  ],
                  ['credit-notes', Permission.CreditNotesView, <CreditNotesPage key="notes" />],
                  [
                    'credit-notes/new',
                    Permission.CreditNotesCreate,
                    <NewCreditNotePage key="new-note" />,
                  ],
                  [
                    'credit-notes/:id',
                    Permission.CreditNotesView,
                    <CreditNoteDetailPage key="note" />,
                  ],
                  [
                    'credit-notes/:id/edit',
                    Permission.CreditNotesCreate,
                    <EditCreditNotePage key="edit-note" />,
                  ],
                  ['receipts', Permission.ReceiptsView, <ReceiptsPage key="receipts" />],
                  [
                    'receipts/new',
                    Permission.ReceiptsCreate,
                    <RecordReceiptPage key="new-receipt" />,
                  ],
                  ['receipts/:id', Permission.ReceiptsView, <ReceiptDetailPage key="receipt" />],
                  [
                    'customer-credit/apply',
                    Permission.ReceiptsCreate,
                    <ApplyCreditPage key="apply" />,
                  ],
                  ['customers', Permission.CustomersView, <CustomersPage key="customers" />],
                  [
                    'customers/new',
                    Permission.CustomersCreate,
                    <NewCustomerPage key="new-customer" />,
                  ],
                  [
                    'customers/:id',
                    Permission.CustomersView,
                    <CustomerDetailPage key="customer" />,
                  ],
                  ['reports', Permission.SalesReportsView, <SalesReportsPage key="reports" />],
                ] as const
              ).map(([path, permission, page]) => ({
                path,
                element: <RequirePermission permission={permission}>{page}</RequirePermission>,
              })),
              {
                path: 'items',
                element: (
                  <RequireAnyPermission permissions={CATALOG_VIEW_PERMISSIONS}>
                    <ItemsPage />
                  </RequireAnyPermission>
                ),
              },
              // Reading is broader than changing (the server's rules); the pages gate changes.
              {
                path: 'settings',
                element: (
                  <RequireAnyPermission permissions={SALES_SETTINGS_VIEW_PERMISSIONS}>
                    <SalesSettingsPage />
                  </RequireAnyPermission>
                ),
              },
              {
                path: 'tax-codes',
                element: (
                  <RequireAnyPermission permissions={TAX_CODES_VIEW_PERMISSIONS}>
                    <TaxCodesPage />
                  </RequireAnyPermission>
                ),
              },
            ],
          },
          {
            path: 'purchases',
            element: <PurchasesSection />,
            children: [
              { index: true, element: <PurchasesHome /> },
              {
                path: 'vendors',
                element: (
                  <RequirePermission permission={Permission.VendorsView}>
                    <VendorsPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'vendors/new',
                element: (
                  <RequirePermission permission={Permission.VendorsCreate}>
                    <NewVendorPage />
                  </RequirePermission>
                ),
              },
              {
                path: 'vendors/:id',
                element: (
                  <RequirePermission permission={Permission.VendorsView}>
                    <VendorDetailPage />
                  </RequirePermission>
                ),
              },
              // Phase 4A-5: bills (P4-15 to P4-22).
              ...(
                [
                  ['bills', Permission.BillsView, <BillsPage key="bills" />],
                  ['bills/new', Permission.BillsCreate, <NewBillPage key="new-bill" />],
                  ['bills/:id', Permission.BillsView, <BillDetailPage key="bill" />],
                  ['bills/:id/edit', Permission.BillsEditDraft, <EditBillPage key="edit-bill" />],
                  // Phase 4B-1: vendor credits and debit notes (P4-23).
                  [
                    'vendor-credits',
                    Permission.VendorCreditsView,
                    <VendorCreditsPage key="credits" />,
                  ],
                  [
                    'vendor-credits/new',
                    Permission.VendorCreditsCreate,
                    <NewVendorCreditPage key="new-credit" />,
                  ],
                  [
                    'vendor-credits/:id',
                    Permission.VendorCreditsView,
                    <VendorCreditDetailPage key="credit" />,
                  ],
                  [
                    'vendor-credits/:id/edit',
                    Permission.VendorCreditsCreate,
                    <EditVendorCreditPage key="edit-credit" />,
                  ],
                  // Phase 4B-2: vendor payments and prepayments (P4-25 to P4-33).
                  ['payments', Permission.VendorPaymentsView, <PaymentsPage key="payments" />],
                  [
                    'payments/new',
                    Permission.VendorPaymentsCreate,
                    <NewPaymentPage key="new-payment" />,
                  ],
                  [
                    'payments/:id',
                    Permission.VendorPaymentsView,
                    <PaymentDetailPage key="payment" />,
                  ],
                  [
                    'payments/:id/edit',
                    Permission.VendorPaymentsCreate,
                    <EditPaymentPage key="edit-payment" />,
                  ],
                ] as const
              ).map(([path, permission, page]) => ({
                path,
                element: <RequirePermission permission={permission}>{page}</RequirePermission>,
              })),
              // Phase 4A-4: Purchases settings and numbering (P4-07, P4-51).
              {
                path: 'settings',
                element: (
                  <RequirePermission permission={Permission.PurchasesSettingsManage}>
                    <PurchasesSettingsPage />
                  </RequirePermission>
                ),
              },
            ],
          },
          { path: '*', element: <p>Page not found.</p> },
        ],
      },
    ],
  },
];
