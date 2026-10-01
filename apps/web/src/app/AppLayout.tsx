import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { Can, Permission, useAnyPermission } from '../permissions/permissions';
import { IMPORT_PERMISSIONS } from '../features/data-exchange/permissions';
import { SALES_VIEW_PERMISSIONS } from '../features/sales/SalesSection';
import { MfaGate } from '../features/security/MfaGate';
import { Alert } from '../shared/ui/Alert';
import { Button } from '../shared/ui/Button';
import { OrganizationSwitcher } from './OrganizationSwitcher';

export function AppLayout() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const canAccounting = useAnyPermission([Permission.JournalsView, Permission.PeriodsView]);
  const canImport = useAnyPermission(IMPORT_PERMISSIONS);
  const canSales = useAnyPermission(SALES_VIEW_PERMISSIONS);
  const remaining = session?.mfa.recoveryCodesRemaining;
  const lowRecoveryCodes =
    remaining === null || remaining === undefined
      ? null
      : remaining === 0
        ? 'none'
        : remaining <= 3
          ? 'low'
          : null;

  const signOut = async () => {
    await logout();
    void navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__brand">Intuit 2.0</div>
        <OrganizationSwitcher />
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <Can permission={Permission.MembersRead}>
            <NavLink to="/members">Members</NavLink>
          </Can>
          <Can permission={Permission.RolesRead}>
            <NavLink to="/roles">Roles</NavLink>
          </Can>
          <Can permission={Permission.AuditRead}>
            <NavLink to="/audit">Audit log</NavLink>
          </Can>
          <Can permission={Permission.OrganizationRead}>
            <NavLink to="/settings/company-profile">Company profile</NavLink>
          </Can>
          <Can permission={Permission.PartiesView}>
            <NavLink to="/parties">Contacts</NavLink>
          </Can>
          {canAccounting ? <NavLink to="/accounting">Accounting</NavLink> : null}
          {canSales ? <NavLink to="/sales">Sales</NavLink> : null}
          {canImport ? <NavLink to="/imports">Import</NavLink> : null}
          <NavLink to="/exports">Exports</NavLink>
          <Can permission={Permission.ApprovalsManage}>
            <NavLink to="/settings/approvals">Approval policies</NavLink>
          </Can>
          <Can permission={Permission.MembersManage}>
            <NavLink to="/settings/security">Security</NavLink>
          </Can>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">
            {session?.activeOrganization?.name ?? 'No organization selected'}
          </span>
          <div className="topbar__user">
            <span>{session?.user.displayName}</span>
            <NavLink to="/account/security">Account security</NavLink>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="content">
          {lowRecoveryCodes ? (
            <Alert tone="info">
              {lowRecoveryCodes === 'none'
                ? 'You have no recovery codes left.'
                : 'You are running low on recovery codes.'}{' '}
              <NavLink to="/account/security">Generate new codes</NavLink>
            </Alert>
          ) : null}
          <MfaGate>
            <Outlet />
          </MfaGate>
        </main>
      </div>
    </div>
  );
}
