import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { useFormatters, useT } from '../../i18n/i18n';
import { api } from '../../services/api-client';
import type { AuditEvent } from '../../services/types';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';

export function AuditPage() {
  const t = useT();
  const format = useFormatters();
  const { activeOrganization } = useAuth();
  const events = useQuery({
    queryKey: ['audit-events', activeOrganization?.id ?? 'none'],
    queryFn: () => api.get<AuditEvent[]>('/organizations/current/audit-events?limit=100'),
  });

  return (
    <>
      <PageHeader title={t('audit.title')} description={t('audit.description')} />
      <Card>
        {events.isPending ? (
          <Spinner label={t('audit.loading')} />
        ) : events.isError ? (
          <ErrorAlert error={events.error} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('audit.when')}</th>
                <th>{t('audit.action')}</th>
                <th>{t('audit.resource')}</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((event) => (
                <tr key={event.id}>
                  <td>{format.dateTime(event.occurredAt)}</td>
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
