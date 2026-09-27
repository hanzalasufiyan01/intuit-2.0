import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import type { AuditEvent } from '../../services/types';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';

export function AuditPage() {
  const { activeOrganization } = useAuth();
  const events = useQuery({
    queryKey: ['audit-events', activeOrganization?.id ?? 'none'],
    queryFn: () => api.get<AuditEvent[]>('/organizations/current/audit-events?limit=100'),
  });

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only history of changes in this organization."
      />
      <Card>
        {events.isPending ? (
          <Spinner label="Loading audit history" />
        ) : events.isError ? (
          <ErrorAlert error={events.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Resource</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((event) => (
                <tr key={event.id}>
                  <td>{new Date(event.occurredAt).toLocaleString()}</td>
                  <td>{event.action}</td>
                  <td className="muted">
                    {event.resourceType} {event.resourceId?.slice(0, 8)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
