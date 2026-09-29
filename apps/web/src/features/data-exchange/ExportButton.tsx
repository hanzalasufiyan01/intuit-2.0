import { useState } from 'react';
import { Link } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { downloadExport, useExport, type ExportDomainKey, type ExportView } from './api';

/**
 * Export action for a list or report screen (S6-44): exports exactly the screen's current
 * filters as CSV in the background, then offers the download (S6-26).
 */
export function ExportButton({
  domain,
  params = {},
  label = 'Export CSV',
}: {
  domain: ExportDomainKey;
  params?: Record<string, unknown>;
  label?: string;
}) {
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useApiMutation(() =>
    api.post<{ export: ExportView; jobId: string }>('/exports', { domain, params }),
  );
  const current = useExport(exportId);
  const download = useApiMutation((id: string) => downloadExport(id));
  const status = current.data?.status;
  const working = start.isPending || status === 'queued' || status === 'running';

  return (
    <span className="export-action">
      {status === 'ready' ? (
        <Button
          variant="secondary"
          busy={download.isPending}
          onClick={() => download.mutate(current.data!.id)}
        >
          Download {current.data!.rowCount ?? 0} rows
        </Button>
      ) : (
        <Button
          variant="secondary"
          busy={working}
          onClick={() =>
            start.mutate(undefined, { onSuccess: (result) => setExportId(result.export.id) })
          }
        >
          {working ? 'Preparing export…' : label}
        </Button>
      )}
      {status === 'failed' ? (
        <span className="alert alert--error" role="alert">
          {current.data!.error ?? 'The export could not be completed.'}{' '}
          <Link to="/exports">All exports</Link>
        </span>
      ) : null}
      <ErrorAlert error={start.error ?? download.error} />
    </span>
  );
}
