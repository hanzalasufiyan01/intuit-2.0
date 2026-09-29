import type { RouteObject } from 'react-router';
import { LoginPage } from '../auth/pages/LoginPage';
import { MfaChallengePage } from '../auth/pages/MfaChallengePage';
import { ForgotPasswordPage, ResetPasswordPage } from '../auth/pages/PasswordResetPages';
import { RegisterPage } from '../auth/pages/RegisterPage';
import { RedirectIfAuthenticated, RequireAuth, RequirePendingMfa } from '../auth/RequireAuth';
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
          { path: '*', element: <p>Page not found.</p> },
        ],
      },
    ],
  },
];
