import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { Spinner } from '../../shared/ui/Spinner';
import { FileUpload } from '../../shared/ui/FileUpload';
import {
  ALL_FILE_TYPES,
  downloadUrl,
  formatFileSize,
  linkQuery,
  MAX_FILE_BYTES,
  uploadErrorMessage,
  uploadFile,
  type FileLinkType,
  type StoredFile,
} from './files';
import { useT } from '../../i18n/i18n';

/**
 * Files attached to one record (S5-22). Access follows the record: `canChange` uploads,
 * `canRemove` additionally reflects the record's state (e.g. only draft journals, S5-20).
 */
export function AttachmentsCard({
  linkType,
  linkId,
  canChange,
  canRemove,
  removeNote,
}: {
  linkType: FileLinkType;
  linkId: string;
  canChange: boolean;
  canRemove: boolean;
  removeNote?: string;
}) {
  const t = useT();
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const key = ['files', org, linkType, linkId];
  const files = useQuery({
    queryKey: key,
    queryFn: () => api.get<StoredFile[]>(`/files?${linkQuery(linkType, linkId)}`),
  });
  const [confirming, setConfirming] = useState<string | null>(null);
  const remove = useApiMutation((fileId: string) => api.delete<void>(`/files/${fileId}`));
  const open = useApiMutation(async (fileId: string) => {
    const { url } = await downloadUrl(fileId);
    window.location.assign(url);
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

  return (
    <Card title={t('attachments.title')}>
      {files.isPending ? (
        <Spinner label={t('attachments.loading')} />
      ) : files.isError ? (
        <ErrorAlert error={files.error} />
      ) : files.data.length === 0 ? (
        <p className="muted">{t('attachments.none')}</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>{t('attachments.name')}</th>
                <th>{t('attachments.type')}</th>
                <th>{t('attachments.size')}</th>
                <th>{t('attachments.uploadedBy')}</th>
                <th>{t('attachments.uploaded')}</th>
                {canRemove ? <th aria-label={t('common.actions')} /> : null}
              </tr>
            </thead>
            <tbody>
              {files.data.map((f) => (
                <tr key={f.id}>
                  <td>
                    <Button variant="ghost" onClick={() => open.mutate(f.id)}>
                      {f.name}
                    </Button>
                  </td>
                  <td>{f.type.toUpperCase()}</td>
                  <td>{formatFileSize(f.size)}</td>
                  <td>{f.uploadedBy.displayName ?? '—'}</td>
                  <td>{new Date(f.uploadedAt).toLocaleString()}</td>
                  {canRemove ? (
                    <td>
                      {confirming === f.id ? (
                        <>
                          <Button
                            variant="secondary"
                            busy={remove.isPending}
                            aria-label={t('attachments.confirmRemoveNamed', { name: f.name })}
                            onClick={() =>
                              remove.mutate(f.id, {
                                onSuccess: () => (setConfirming(null), refresh()),
                              })
                            }
                          >
                            {t('attachments.confirmRemove')}
                          </Button>
                          <Button variant="ghost" onClick={() => setConfirming(null)}>
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          aria-label={t('attachments.removeNamed', { name: f.name })}
                          onClick={() => setConfirming(f.id)}
                        >
                          {t('attachments.remove')}
                        </Button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {removeNote && canChange && !canRemove && files.data?.length ? (
        <p className="muted">{removeNote}</p>
      ) : null}
      <ErrorAlert error={remove.error ?? open.error} />
      {canChange ? (
        <FileUpload
          accept={ALL_FILE_TYPES}
          maxBytes={MAX_FILE_BYTES}
          label={t('attachments.attach')}
          hint={t('attachments.hint')}
          upload={async (file, onProgress) => {
            await uploadFile({ linkType, linkId, file, onProgress });
            refresh();
          }}
          errorMessage={uploadErrorMessage}
        />
      ) : null}
    </Card>
  );
}
