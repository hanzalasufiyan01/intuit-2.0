import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/auth-context';
import { ErrorAlert } from '../shared/ui/Alert';

/**
 * Active organization selector. The choice is only a preference stored in the server-side
 * session; the server re-verifies membership and permissions on every request.
 */
export function OrganizationSwitcher() {
  const { session, activeOrganization, switchOrganization } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  if (!session) return null;

  const onChange = async (organizationId: string) => {
    if (organizationId === '__new') {
      void navigate('/organizations/new');
      return;
    }
    setPending(true);
    setError(null);
    try {
      await switchOrganization(organizationId);
      void navigate('/');
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="field">
      <label htmlFor="organization-switcher">Organization</label>
      <select
        id="organization-switcher"
        value={activeOrganization?.id ?? ''}
        disabled={pending}
        onChange={(e) => void onChange(e.target.value)}
      >
        {activeOrganization ? null : <option value="">Select an organization</option>}
        {session.organizations.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
        <option value="__new">+ New organization…</option>
      </select>
      <ErrorAlert error={error} />
    </div>
  );
}
