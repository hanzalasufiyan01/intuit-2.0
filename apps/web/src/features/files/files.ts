import { useQuery } from '@tanstack/react-query';
import { ApiError, api, getCsrfToken, type ApiErrorBody } from '../../services/api-client';

/** File storage client (Phase 3A S5). */

export type FileLinkType =
  | 'organization_logo'
  | 'party'
  | 'journal'
  | 'import_batch'
  | 'export'
  | 'opening_balance_batch'
  | 'invoice'
  | 'credit_note'
  | 'receipt'
  | 'bill'
  | 'vendor_credit';

export interface StoredFile {
  id: string;
  name: string;
  type: 'pdf' | 'png' | 'jpeg' | 'webp' | 'csv' | 'xlsx';
  mimeType: string;
  size: number;
  sha256: string;
  status: 'available' | 'quarantined';
  scanStatus: 'not_scanned' | 'clean' | 'infected';
  uploadedAt: string;
  uploadedBy: { id: string; displayName: string | null };
  link: { type: FileLinkType; id: string | null };
}

export interface Job {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  progress: number;
  progressMessage: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Decision 61. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ALL_FILE_TYPES = '.pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx';
export const IMAGE_FILE_TYPES = '.png,.jpg,.jpeg,.webp';

export function linkQuery(linkType: FileLinkType, linkId: string | null): string {
  const params = new URLSearchParams({ linkType });
  if (linkId) params.set('linkId', linkId);
  return params.toString();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** User-facing message for an upload failure. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'FILE_TOO_LARGE') return 'The file is larger than 25 MB.';
    if (error.code === 'UNSUPPORTED_FILE_TYPE') {
      return 'This file type is not accepted here, or the file does not match its extension.';
    }
    return error.message;
  }
  return 'The upload failed.';
}

/**
 * Uploads one file as a raw body (S5-21) with XHR so progress can be shown. The name travels
 * percent-encoded in X-File-Name; the session cookie and CSRF token authorize it.
 */
export function uploadFile(input: {
  linkType: FileLinkType;
  linkId: string | null;
  file: File;
  onProgress?: (fraction: number) => void;
}): Promise<StoredFile> {
  if (input.file.size > MAX_FILE_BYTES) {
    return Promise.reject(
      new ApiError(413, 'FILE_TOO_LARGE', 'The file is larger than 25 MB.', null),
    );
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/v1/files?${linkQuery(input.linkType, input.linkId)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(input.file.name));
    const csrf = getCsrfToken();
    if (csrf) xhr.setRequestHeader('x-csrf-token', csrf);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress?.(event.loaded / event.total);
    };
    xhr.onerror = () =>
      reject(
        new ApiError(
          0,
          'NETWORK_ERROR',
          'Unable to reach the server. Check your connection.',
          null,
        ),
      );
    xhr.onload = () => {
      let parsed: unknown;
      try {
        parsed = xhr.responseText ? JSON.parse(xhr.responseText) : undefined;
      } catch {
        parsed = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((parsed as { data: StoredFile }).data);
        return;
      }
      const error = (parsed as ApiErrorBody | undefined)?.error;
      reject(
        new ApiError(
          xhr.status,
          error?.code ?? 'UNKNOWN_ERROR',
          error?.message ?? 'The upload failed.',
          error?.requestId ?? null,
          error?.details?.issues ?? [],
        ),
      );
    };
    xhr.send(input.file);
  });
}

/** A short-lived signed download URL (S5-08). */
export function downloadUrl(fileId: string) {
  return api.get<{ url: string; expiresAt: string }>(`/files/${fileId}/download-url`);
}

/** Poll delay: every second at first, backing off to five seconds (S5 §13). */
export function jobPollDelay(polls: number, firstMs = 1000, maxMs = 5000): number {
  return Math.min(firstMs * 1.5 ** polls, maxMs);
}

/** Polls a background job until it finishes (S5-16). */
export function useJob(jobId: string | null, firstMs = 1000, maxMs = 5000) {
  return useQuery({
    queryKey: ['job', jobId],
    queryFn: () => api.get<Job>(`/jobs/${jobId}`),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' || status === undefined
        ? jobPollDelay(query.state.dataUpdateCount, firstMs, maxMs)
        : false;
    },
  });
}
