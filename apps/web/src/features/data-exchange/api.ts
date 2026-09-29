import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/auth-context';
import { api } from '../../services/api-client';

/** Import and export client (Phase 3A S6). */

export type ImportDomainKey =
  | 'chart_of_accounts'
  | 'parties'
  | 'party_contacts'
  | 'dimension_values'
  | 'exchange_rates'
  | 'manual_journals'
  | 'opening_balances';

export type ExportDomainKey =
  | 'chart_of_accounts'
  | 'parties'
  | 'dimension_values'
  | 'journals'
  | 'general_ledger'
  | 'trial_balance'
  | 'profit_and_loss'
  | 'balance_sheet'
  | 'import_errors'
  | 'opening_balances';

export type ImportStatus =
  | 'awaiting_file'
  | 'ready'
  | 'validating'
  | 'validated'
  | 'failed_file'
  | 'committing'
  | 'committed'
  | 'needs_review'
  | 'cancelled'
  | 'expired';

export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
export type DecimalSeparator = '.' | ',';

export interface ImportField {
  key: string;
  label: string;
  required: boolean;
  description: string;
  example: string;
  synonyms: string[];
}

export interface ImportDomainInfo {
  key: ImportDomainKey;
  label: string;
  groupsRows: boolean;
  fields: ImportField[];
}

export interface ImportBatch {
  id: string;
  domain: ImportDomainKey;
  domainLabel: string;
  status: ImportStatus;
  version: number;
  options: { dateFormat: DateFormat; decimalSeparator: DecimalSeparator; delimiter: string };
  mapping: Record<string, number | null> | null;
  mappingVersion: number;
  validatedMappingVersion: number | null;
  columns: string[] | null;
  counts: { total: number; valid: number; warning: number; error: number; excluded: number };
  fileId: string | null;
  fileName: string | null;
  duplicateOfBatchId: string | null;
  lastError: string | null;
  created: number | null;
  discardedDrafts: number | null;
  jobs: { validate: string | null; commit: string | null };
  createdByUserId: string;
  createdAt: string;
  committedAt: string | null;
  finishedAt: string | null;
  expiresAt: string;
  redacted: boolean;
}

export interface RowMessage {
  severity: 'error' | 'warning';
  code: string;
  field: string | null;
  message: string;
}

export interface ImportRowView {
  rowNumber: number;
  status: 'pending' | 'valid' | 'warning' | 'error';
  excluded: boolean;
  groupKey: string | null;
  cells: string[] | null;
  messages: RowMessage[];
  recordId: string | null;
}

export interface InspectResult {
  batch: ImportBatch;
  columns: string[];
  sample: string[][];
  suggestedMapping: Record<string, number | null>;
  fields: ImportField[];
}

export interface SavedMapping {
  id: string;
  domain: ImportDomainKey;
  name: string;
  mapping: Record<string, string>;
  options: { dateFormat?: DateFormat; decimalSeparator?: DecimalSeparator };
}

export interface ExportView {
  id: string;
  domain: ExportDomainKey;
  domainLabel: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired';
  params: Record<string, unknown>;
  rowCount: number | null;
  fileId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
}

export const ACTIVE_IMPORT_STATUSES: readonly ImportStatus[] = ['validating', 'committing'];
export const OPEN_IMPORT_STATUSES: readonly ImportStatus[] = [
  'awaiting_file',
  'ready',
  'validated',
  'needs_review',
];

export const STATUS_LABELS: Record<ImportStatus, string> = {
  awaiting_file: 'Waiting for file',
  ready: 'Ready to map',
  validating: 'Validating',
  validated: 'Ready to review',
  failed_file: 'File rejected',
  committing: 'Importing',
  committed: 'Imported',
  needs_review: 'Needs review',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export function useOrg() {
  return useAuth().activeOrganization?.id ?? 'none';
}

export function useImportCatalog() {
  const org = useOrg();
  return useQuery({
    queryKey: ['import-catalog', org],
    queryFn: () => api.get<ImportDomainInfo[]>('/imports/catalog'),
  });
}

/** An import, polled while its background work runs. */
export function useImportBatch(id: string) {
  const org = useOrg();
  return useQuery({
    queryKey: ['import', org, id],
    queryFn: () => api.get<ImportBatch>(`/imports/${id}`),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_IMPORT_STATUSES.includes(query.state.data.status) ? 1000 : false,
  });
}

/** An export, polled until its file is ready (or it failed). */
export function useExport(id: string | null) {
  const org = useOrg();
  return useQuery({
    queryKey: ['export', org, id],
    queryFn: () => api.get<ExportView>(`/exports/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' || status === undefined ? 1000 : false;
    },
  });
}

/** Starts the browser download of a ready export through its short-lived signed link. */
export async function downloadExport(exportId: string) {
  const { url } = await api.get<{ url: string; expiresAt: string }>(
    `/exports/${exportId}/download-url`,
  );
  window.location.assign(url);
}

export function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString() : '—';
}
