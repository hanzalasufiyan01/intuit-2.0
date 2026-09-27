import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { Can, Permission } from '../permissions/permissions';
import { Button } from '../shared/ui/Button';
import { OrganizationSwitcher } from './OrganizationSwitcher';

export function AppLayout() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();

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
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">
            {session?.activeOrganization?.name ?? 'No organization selected'}
          </span>
          <div className="topbar__user">
            <span>{session?.user.displayName}</span>
            <Button variant="secondary" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
