import type { RouteObject } from 'react-router';
import { LoginPage } from '../auth/pages/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage } from '../auth/pages/PasswordResetPages';
import { RegisterPage } from '../auth/pages/RegisterPage';
import { RedirectIfAuthenticated, RequireAuth } from '../auth/RequireAuth';
import { AuditPage } from '../features/audit/AuditPage';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { AcceptInvitationPage } from '../features/invitations/AcceptInvitationPage';
import { MembersPage } from '../features/members/MembersPage';
import { CreateOrganizationPage } from '../features/organizations/CreateOrganizationPage';
import { RolesPage } from '../features/roles/RolesPage';
import { Permission } from '../permissions/permissions';
import { RequirePermission } from '../permissions/RequirePermission';
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
          { path: '*', element: <p>Page not found.</p> },
        ],
      },
    ],
  },
];
