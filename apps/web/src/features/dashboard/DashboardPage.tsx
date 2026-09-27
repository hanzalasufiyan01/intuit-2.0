import { Link } from 'react-router';
import { useAuth } from '../../auth/auth-context';
import { Alert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';

export function DashboardPage() {
  const { session, activeOrganization } = useAuth();
  if (!session) return null;

  if (!activeOrganization) {
    return (
      <>
        <PageHeader title={`Welcome, ${session.user.displayName}`} />
        <Alert tone="info">
          You are not in an active organization.{' '}
          <Link to="/organizations/new">Create an organization</Link> or accept an invitation.
        </Alert>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={activeOrganization.name}
        description={`Signed in as ${session.user.email}`}
      />
      <Card title="Your access">
        <p>
          {activeOrganization.isOwner
            ? 'You are the Owner of this organization.'
            : 'You are a member of this organization.'}
        </p>
        <div>
          {activeOrganization.permissions.map((permission) => (
            <span key={permission} className="badge">
              {permission}
            </span>
          ))}
        </div>
      </Card>
      <Card title="Organizations">
        <ul>
          {session.organizations.map((org) => (
            <li key={org.id}>
              {org.name}
              {org.id === activeOrganization.id ? <span className="muted"> (active)</span> : null}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
