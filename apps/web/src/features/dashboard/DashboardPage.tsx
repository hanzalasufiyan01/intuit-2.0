import { Link } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { Alert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { useT } from '../../i18n/i18n';

export function DashboardPage() {
  const t = useT();
  const { session, activeOrganization } = useAuth();
  if (!session) return null;

  if (!activeOrganization) {
    return (
      <>
        <PageHeader title={t('dashboard.welcome', { name: session.user.displayName })} />
        <Alert tone="info">
          {t('dashboard.noOrganization')}{' '}
          <Link to="/organizations/new">{t('dashboard.createOrganization')}</Link>{' '}
          {t('dashboard.orInvitation')}
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={activeOrganization.name}
        description={t('dashboard.signedInAs', { email: session.user.email })}
      />
      <Card title={t('dashboard.access')}>
        <p>{activeOrganization.isOwner ? t('dashboard.isOwner') : t('dashboard.isMember')}</p>
        <div>
          {activeOrganization.permissions.map((permission) => (
            <span key={permission} className="badge">
              {permission}
            </span>
          ))}
        </div>
      </Card>
      <Card title={t('dashboard.organizations')}>
        <ul>
          {session.organizations.map((org) => (
            <li key={org.id}>
              {org.name}
              {org.id === activeOrganization.id ? (
                <span className="muted"> {t('dashboard.active')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
