import { useState } from 'react';
import { Link } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { downloadExport, useExport, type ExportDomainKey, type ExportView } from './api';
import { useT } from '../../i18n/i18n';

/**
 * Export action for a list or report screen (S6-44): exports exactly the screen's current
 * filters as CSV or an Excel workbook in the background, then offers the download (S6-26).
 */
export function ExportButton({
  domain,
  params = {},
  label,
}: {
  domain: ExportDomainKey;
  params?: Record<string, unknown>;
  label?: string;
}) {
  const t = useT();
  const csvLabel = label ?? t('export.csv');
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useApiMutation((format: 'csv' | 'xlsx') =>
    api.post<{ export: ExportView; jobId: string }>('/exports', { domain, params, format }),
  );
  const xlsxLabel = csvLabel.includes('CSV') ? csvLabel.replace('CSV', 'XLSX') : t('export.xlsx');
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
          {t('export.download', { count: current.data!.rowCount ?? 0 })}
        </Button>
      ) : (
        <>
          {(['csv', 'xlsx'] as const).map((format) => (
            <Button
              key={format}
              variant="secondary"
              busy={working}
              onClick={() =>
                start.mutate(format, { onSuccess: (result) => setExportId(result.export.id) })
              }
            >
              {working ? t('export.preparing') : format === 'csv' ? csvLabel : xlsxLabel}
            </Button>
          ))}
        </>
      )}
      {status === 'failed' ? (
        <span className="alert alert--error" role="alert">
          {current.data!.error ?? t('export.failed')} <Link to="/exports">{t('export.all')}</Link>
        </span>
      ) : null}
      <ErrorAlert error={start.error ?? download.error} />
    </span>
  );
}
