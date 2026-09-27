import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import type { Role } from '../../services/types';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';

export function RolesPage() {
  const { activeOrganization } = useAuth();
  const roles = useQuery({
    queryKey: ['roles', activeOrganization?.id ?? 'none'],
    queryFn: () => api.get<Role[]>('/organizations/current/roles'),
  });

  return (
    <>
      <PageHeader
        title="Roles"
        description="Roles group permissions. The Owner role is protected."
      />
      {roles.isPending ? (
        <Spinner label="Loading roles" />
      ) : roles.isError ? (
        <ErrorAlert error={roles.error} />
      ) : (
        roles.data.map((role) => (
          <Card key={role.id} title={role.name}>
            <p className="muted">
              {role.description || 'No description.'}{' '}
              {role.isSystem ? '· System role' : '· Custom role'}
              {role.memberCount !== undefined ? ` · ${role.memberCount} member(s)` : ''}
            </p>
            <div>
              {role.permissionKeys.map((key) => (
                <span key={key} className="badge">
                  {key}
                </span>
              ))}
            </div>
          </Card>
        ))
      )}
    </>
  );
}
