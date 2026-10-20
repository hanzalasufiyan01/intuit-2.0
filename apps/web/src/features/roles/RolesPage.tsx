import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import type { Role } from '../../services/types';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';

export function RolesPage() {
  const t = useT();
  const { activeOrganization } = useAuth();
  const roles = useQuery({
    queryKey: ['roles', activeOrganization?.id ?? 'none'],
    queryFn: () => api.get<Role[]>('/organizations/current/roles'),
  });

  return (
    <>
      <PageHeader title={t('roles.title')} description={t('roles.description')} />
      {roles.isPending ? (
        <Spinner label={t('roles.loading')} />
      ) : roles.isError ? (
        <ErrorAlert error={roles.error} />
      ) : (
        roles.data.map((role) => (
          <Card key={role.id} title={role.name}>
            <p className="muted">
              {role.description || t('roles.noDescription')}{' '}
              {role.isSystem ? t('roles.system') : t('roles.custom')}
              {role.memberCount !== undefined
                ? ` · ${t('roles.members', { count: role.memberCount })}`
                : ''}
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
