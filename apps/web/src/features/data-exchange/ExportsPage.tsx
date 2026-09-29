import { useQuery } from '@tanstack/react-query';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { downloadExport, formatDateTime, useOrg, type ExportView } from './api';

const STATUS: Record<ExportView['status'], string> = {
  queued: 'Waiting',
  running: 'Preparing',
  ready: 'Ready',
  failed: 'Failed',
  expired: 'Expired',
};

/** The user's own recent exports (S6-44). Files are kept for 7 days. */
export function ExportsPage() {
  const org = useOrg();
  const exportsList = useQuery({
    queryKey: ['exports', org],
    queryFn: () => api.get<ExportView[]>('/exports?limit=50'),
    refetchInterval: (query) =>
      query.state.data?.some((e) => e.status === 'queued' || e.status === 'running') ? 2000 : false,
  });
  const download = useApiMutation((id: string) => downloadExport(id));

  return (
    <>
      <PageHeader
        title="Exports"
        description="CSV files you exported. Download links are private to you and files are removed after 7 days."
      />
      <Card>
        {exportsList.isPending ? (
          <Spinner label="Loading exports" />
        ) : exportsList.isError ? (
          <ErrorAlert error={exportsList.error} />
        ) : exportsList.data.length === 0 ? (
          <p className="muted">
            No exports yet. Use "Export CSV" on the chart of accounts, contacts, journals, ledger or
            a financial statement.
          </p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Requested</th>
                  <th>Export</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>Available until</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {exportsList.data.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>{e.domainLabel}</td>
                    <td>
                      {STATUS[e.status]}
                      {e.error ? <div className="muted">{e.error}</div> : null}
                    </td>
                    <td>{e.rowCount ?? '—'}</td>
                    <td>{e.status === 'ready' ? formatDateTime(e.expiresAt) : '—'}</td>
                    <td>
                      {e.status === 'ready' ? (
                        <Button
                          variant="ghost"
                          aria-label={`Download ${e.domainLabel}`}
                          busy={download.isPending && download.variables === e.id}
                          onClick={() => download.mutate(e.id)}
                        >
                          Download
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorAlert error={download.error} />
      </Card>
    </>
  );
}
