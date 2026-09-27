import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { Alert } from '../shared/ui/Alert';
import { usePermission, type PermissionKey } from './permissions';

/** Route-level guard for organization pages (UX only; the API enforces authorization). */
export function RequirePermission({
  permission,
  children,
}: {
  permission: PermissionKey;
  children: ReactNode;
}) {
  const { activeOrganization } = useAuth();
  const allowed = usePermission(permission);
  if (!activeOrganization) {
    return (
      <Alert tone="info">
        Select or <Link to="/organizations/new">create an organization</Link> to continue.
      </Alert>
    );
  }
  if (!allowed) return <Alert>You do not have access to this page.</Alert>;
  return <>{children}</>;
}
