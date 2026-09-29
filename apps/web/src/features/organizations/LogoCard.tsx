import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiMutation, useAuth } from '../../auth/auth-context';
import { Permission, usePermission } from '../../permissions/permissions';
import { api } from '../../services/api-client';
import { ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card } from '../../shared/ui/Card';
import { FileUpload } from '../../shared/ui/FileUpload';
import {
  downloadUrl,
  IMAGE_FILE_TYPES,
  MAX_FILE_BYTES,
  uploadErrorMessage,
  uploadFile,
} from '../files/files';
import type { OrganizationProfile } from '../parties/types';

/** Company logo (S4-03, K-6, S5-11, S5-12): PNG, JPEG or WebP, separate from the profile save. */
export function LogoCard({ profile }: { profile: OrganizationProfile }) {
  const org = useAuth().activeOrganization?.id ?? 'none';
  const queryClient = useQueryClient();
  const canEdit = usePermission(Permission.OrganizationUpdate);
  const fileId = profile.logo?.fileId ?? null;
  // Signed URLs last 5 minutes; refresh before they expire.
  const preview = useQuery({
    queryKey: ['logo-url', org, fileId],
    queryFn: () => downloadUrl(fileId!),
    enabled: fileId !== null,
    staleTime: 4 * 60_000,
  });
  const setLogo = useApiMutation((next: string | null) =>
    next
      ? api.put<{ logo: { fileId: string } | null }>('/organizations/current/profile/logo', {
          fileId: next,
        })
      : api.delete<{ logo: null }>('/organizations/current/profile/logo'),
  );
  const apply = (next: string | null) =>
    setLogo.mutate(next, {
      onSuccess: ({ logo }) =>
        queryClient.setQueryData<OrganizationProfile>(['organization-profile', org], (current) =>
          current ? { ...current, logo } : current,
        ),
    });

  return (
    <Card
      title="Company logo"
      actions={
        canEdit && fileId ? (
          <Button variant="ghost" busy={setLogo.isPending} onClick={() => apply(null)}>
            Remove logo
          </Button>
        ) : null
      }
    >
      {fileId && preview.data ? (
        <img className="company-logo" src={preview.data.url} alt="Company logo" />
      ) : fileId ? null : (
        <p className="muted">No logo.</p>
      )}
      {canEdit ? (
        profile.version === 0 ? (
          <p className="muted">Save the company profile before adding a logo.</p>
        ) : (
          <FileUpload
            accept={IMAGE_FILE_TYPES}
            maxBytes={MAX_FILE_BYTES}
            label={fileId ? 'Replace logo' : 'Upload logo'}
            hint="PNG, JPEG or WebP, up to 25 MB."
            upload={async (file, onProgress) => {
              const stored = await uploadFile({
                linkType: 'organization_logo',
                linkId: null,
                file,
                onProgress,
              });
              apply(stored.id);
            }}
            errorMessage={uploadErrorMessage}
          />
        )
      ) : null}
      <ErrorAlert error={setLogo.error} />
    </Card>
  );
}
