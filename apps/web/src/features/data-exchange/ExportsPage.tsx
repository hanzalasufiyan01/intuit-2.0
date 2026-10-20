import { useQuery } from '@tanstack/react-query';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { downloadExport, formatDateTime, useOrg, type ExportView } from './api';
import { useT } from '../../i18n/i18n';

/** The user's own recent exports (S6-44). Files are kept for 7 days. */
export function ExportsPage() {
  const t = useT();
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
      <PageHeader title={t('exports.title')} description={t('exports.description')} />
      <Card>
        {exportsList.isPending ? (
          <Spinner label={t('exports.loading')} />
        ) : exportsList.isError ? (
          <ErrorAlert error={exportsList.error} />
        ) : exportsList.data.length === 0 ? (
          <p className="muted">{t('exports.none')}</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('exports.requested')}</th>
                  <th>{t('exports.export')}</th>
                  <th>{t('exports.status')}</th>
                  <th>{t('exports.rows')}</th>
                  <th>{t('exports.availableUntil')}</th>
                  <th aria-label={t('common.actions')} />
                </tr>
              </thead>
              <tbody>
                {exportsList.data.map((e) => (
                  <tr key={e.id}>
                    <td>{formatDateTime(e.createdAt)}</td>
                    <td>{e.domainLabel}</td>
                    <td>
                      {t(`exports.status.${e.status}`)}
                      {e.error ? <div className="muted">{e.error}</div> : null}
                    </td>
                    <td>{e.rowCount ?? '—'}</td>
                    <td>{e.status === 'ready' ? formatDateTime(e.expiresAt) : '—'}</td>
                    <td>
                      {e.status === 'ready' ? (
                        <Button
                          variant="ghost"
                          aria-label={t('exports.downloadNamed', { name: e.domainLabel })}
                          busy={download.isPending && download.variables === e.id}
                          onClick={() => download.mutate(e.id)}
                        >
                          {t('exports.download')}
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
