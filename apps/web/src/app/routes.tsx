import type { RouteObject } from 'react-router';
import { LoginPage } from '../auth/pages/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '../auth/pages/PasswordResetPages';
import { RegisterPage } from '../auth/pages/RegisterPage';
import { RedirectIfAuthenticated, RequireAuth } from '../auth/RequireAuth';
import { AccountingDashboardPage } from '../features/accounting/AccountingDashboardPage';
import { AccountsPage } from '../features/accounting/AccountsPage';
import { JournalDetailPage, NewJournalPage } from '../features/accounting/JournalPages';
import { JournalsPage } from '../features/accounting/JournalsPage';
import { LedgerPage } from '../features/accounting/LedgerPage';
import { FiscalYearsPage, PeriodsPage } from '../features/accounting/PeriodPages';
import { SetupPage } from '../features/accounting/SetupPage';
import { ApprovalPoliciesPage } from '../features/approvals/ApprovalPoliciesPage';
import { AuditPage } from '../features/audit/AuditPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { AcceptInvitationPage } from '../features/invitations/AcceptInvitationPage';
import { MembersPage } from '../features/members/MembersPage';
import { CreateOrganizationPage } from '../features/organizations/CreateOrganizationPage';
import { RolesPage } from '../features/roles/RolesPage';
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
              {
                path: 'accounts',
                element: (
                  <RequirePermission permission={Permission.AccountsView}>
                    <AccountsPage />
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
            ],
          },
          { path: '*', element: <p>Page not found.</p> },
        ],
      },
    ],
  },
];
