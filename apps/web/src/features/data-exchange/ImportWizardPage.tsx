import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiMutation } from '../../auth/auth-context';
import { api } from '../../services/api-client';
import { Alert, ErrorAlert } from '../../shared/ui/Alert';
import { Button } from '../../shared/ui/Button';
import { Card, PageHeader } from '../../shared/ui/Card';
import { FileUpload } from '../../shared/ui/FileUpload';
import { Spinner } from '../../shared/ui/Spinner';
import { TextField } from '../../shared/ui/TextField';
import { useJob, uploadErrorMessage, uploadFile } from '../files/files';
import {
  downloadExport,
  formatDateTime,
  STATUS_LABELS,
  useExport,
  useImportBatch,
  useImportCatalog,
  useOrg,
  type DateFormat,
  type DecimalSeparator,
  type ExportView,
  type ImportBatch,
  type ImportDomainInfo,
  type ImportRowView,
  type InspectResult,
  type SavedMapping,
} from './api';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const PREVIEW_ROWS = 500;

/** Import wizard (S6-44): upload → map → validate → review → import → result. */
export function ImportWizardPage() {
  const { id = '' } = useParams();
  const batch = useImportBatch(id);
  const catalog = useImportCatalog();
  const [remap, setRemap] = useState(false);

  if (batch.isPending || catalog.isPending) return <Spinner label="Loading import" />;
  if (batch.isError) return <ErrorAlert error={batch.error} />;
  const b = batch.data;
  const domain = catalog.data?.find((d) => d.key === b.domain);

  let step: React.ReactNode;
  if (b.status === 'awaiting_file') step = <UploadStep batch={b} domain={domain} />;
  else if (b.status === 'ready' || remap) {
    step = <MappingStep batch={b} onDone={() => setRemap(false)} />;
  } else if (b.status === 'validating' || b.status === 'committing') {
    step = <ProgressStep batch={b} />;
  } else if (b.status === 'validated' || b.status === 'needs_review') {
    step = <ReviewStep batch={b} domain={domain} onRemap={() => setRemap(true)} />;
  } else if (b.status === 'committed') step = <DoneStep batch={b} />;
  else step = <EndedStep batch={b} />;

  return (
    <>
      <PageHeader
        title={`Import: ${b.domainLabel}`}
        description={`${STATUS_LABELS[b.status]}${b.fileName ? ` · ${b.fileName}` : ''} · started ${formatDateTime(b.createdAt)}`}
      />
      <p>
        <Link to="/imports">← All imports</Link>
      </p>
      {b.lastError && b.status !== 'committed' ? <Alert>{b.lastError}</Alert> : null}
      {step}
      <CancelImport batch={b} />
    </>
  );
}

function useRefreshBatch(batchId: string) {
  const queryClient = useQueryClient();
  const org = useOrg();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['import', org, batchId] });
    void queryClient.invalidateQueries({ queryKey: ['imports', org] });
  };
}

// ---------------------------------------------------------------------------
// 1. Upload
// ---------------------------------------------------------------------------

function UploadStep({
  batch,
  domain,
}: {
  batch: ImportBatch;
  domain: ImportDomainInfo | undefined;
}) {
  const refresh = useRefreshBatch(batch.id);
  return (
    <>
      <Card title="1. Choose the file">
        <p>
          <a href={`/api/v1/imports/templates/${batch.domain}`} download>
            Download the CSV template
          </a>{' '}
          for {batch.domainLabel.toLowerCase()}, fill it in (or use your own column names) and save
          it as <strong>CSV UTF-8</strong>.
        </p>
        <FileUpload
          accept=".csv"
          maxBytes={MAX_IMPORT_BYTES}
          label="CSV file"
          hint="CSV (UTF-8), up to 25 MB and 25,000 rows."
          upload={async (file, onProgress) => {
            await uploadFile({ linkType: 'import_batch', linkId: batch.id, file, onProgress });
            refresh();
          }}
          errorMessage={uploadErrorMessage}
        />
      </Card>
      {domain ? <FieldGuide domain={domain} /> : null}
    </>
  );
}

function FieldGuide({ domain }: { domain: ImportDomainInfo }) {
  return (
    <Card title="Columns">
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Column</th>
              <th>Required</th>
              <th>Description</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {domain.fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td>{f.required ? 'Yes' : ''}</td>
                <td>{f.description}</td>
                <td>{f.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {domain.groupsRows ? (
        <p className="muted">
          Rows with the same journal key form one journal. Imported journals are drafts: submit,
          approve and post them as usual.
        </p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Mapping
// ---------------------------------------------------------------------------

function MappingStep({ batch, onDone }: { batch: ImportBatch; onDone: () => void }) {
  const org = useOrg();
  const refresh = useRefreshBatch(batch.id);
  const inspect = useQuery({
    queryKey: ['import-inspect', org, batch.id],
    queryFn: () => api.post<InspectResult>(`/imports/${batch.id}/inspect`, {}),
    retry: false,
  });
  const saved = useQuery({
    queryKey: ['import-mappings', org, batch.domain],
    queryFn: () => api.get<SavedMapping[]>(`/import-mappings?domain=${batch.domain}`),
  });
  // The user's edits; until then the batch's mapping, else the suggestion from the headers.
  const [edited, setMapping] = useState<Record<string, number | null> | null>(null);
  const mapping = edited ?? batch.mapping ?? inspect.data?.suggestedMapping ?? null;
  const [dateFormat, setDateFormat] = useState<DateFormat>(batch.options.dateFormat);
  const [decimalSeparator, setDecimalSeparator] = useState<DecimalSeparator>(
    batch.options.decimalSeparator,
  );
  const [mappingName, setMappingName] = useState('');
  const validate = useApiMutation(() =>
    api.put(`/imports/${batch.id}/mapping`, {
      version: inspect.data?.batch.version ?? batch.version,
      mapping,
      options: { dateFormat, decimalSeparator },
    }),
  );
  const save = useApiMutation(() => {
    const columns = inspect.data?.columns ?? [];
    return api.post('/import-mappings', {
      domain: batch.domain,
      name: mappingName,
      mapping: Object.fromEntries(
        Object.entries(mapping ?? {})
          .filter(([, column]) => column !== null)
          .map(([field, column]) => [field, columns[column!]!]),
      ),
      options: { dateFormat, decimalSeparator },
    });
  });

  const inspected = inspect.data;
  if (!inspected || mapping === null) {
    return inspect.isError ? (
      <ErrorAlert error={inspect.error} />
    ) : (
      <Spinner label="Reading the file" />
    );
  }
  const { columns, sample, fields } = inspected;
  const applySaved = (m: SavedMapping) => {
    const byHeader = new Map(columns.map((c, i) => [c.trim().toLowerCase(), i]));
    setMapping(
      Object.fromEntries(
        fields.map((f) => [
          f.key,
          byHeader.get(m.mapping[f.key]?.trim().toLowerCase() ?? '') ?? null,
        ]),
      ),
    );
    if (m.options.dateFormat) setDateFormat(m.options.dateFormat);
    if (m.options.decimalSeparator) setDecimalSeparator(m.options.decimalSeparator);
  };
  const missing = fields.filter((f) => f.required && (mapping[f.key] ?? null) === null);

  return (
    <Card title="2. Match the columns">
      {saved.data?.length ? (
        <div className="field">
          <label htmlFor="saved-mapping">Use a saved mapping</label>
          <select
            id="saved-mapping"
            defaultValue=""
            onChange={(e) => {
              const found = saved.data.find((m) => m.id === e.target.value);
              if (found) applySaved(found);
            }}
          >
            <option value="">Choose…</option>
            {saved.data.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Column in your file</th>
              <th>First value</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) => {
              const column = mapping[f.key] ?? null;
              return (
                <tr key={f.key}>
                  <td>
                    {f.label}
                    {f.required ? ' *' : ''}
                    <div className="muted">{f.description}</div>
                  </td>
                  <td>
                    <select
                      aria-label={`Column for ${f.label}`}
                      value={column === null ? '' : String(column)}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          [f.key]: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">— not imported —</option>
                      {columns.map((c, i) => (
                        <option key={i} value={i}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{column === null ? '' : (sample[0]?.[column] ?? '')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="form form--inline">
        <div className="field">
          <label htmlFor="map-date-format">Dates in the file</label>
          <select
            id="map-date-format"
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value as DateFormat)}
          >
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="map-decimal">Decimal separator</label>
          <select
            id="map-decimal"
            value={decimalSeparator}
            onChange={(e) => setDecimalSeparator(e.target.value as DecimalSeparator)}
          >
            <option value=".">Point (1,234.56)</option>
            <option value=",">Comma (1.234,56)</option>
          </select>
        </div>
      </div>
      {missing.length ? (
        <Alert tone="info">
          Match the required fields: {missing.map((f) => f.label).join(', ')}.
        </Alert>
      ) : null}
      <div className="actions">
        <Button
          disabled={missing.length > 0}
          busy={validate.isPending}
          onClick={() =>
            validate.mutate(undefined, {
              onSuccess: () => {
                onDone();
                refresh();
              },
            })
          }
        >
          Check all rows
        </Button>
      </div>
      <ErrorAlert error={validate.error} />
      <div className="form form--inline">
        <TextField
          label="Save this mapping as"
          value={mappingName}
          onChange={(e) => setMappingName(e.target.value)}
        />
        <Button
          variant="secondary"
          disabled={!mappingName.trim()}
          busy={save.isPending}
          onClick={() =>
            save.mutate(undefined, { onSuccess: () => (setMappingName(''), void saved.refetch()) })
          }
        >
          Save mapping
        </Button>
      </div>
      {save.isSuccess ? <Alert tone="success">Mapping saved.</Alert> : null}
      <ErrorAlert error={save.error} />
      <p className="muted">
        Columns you don't match are ignored. Delimiter detected:{' '}
        {describeDelimiter(inspected.batch.options.delimiter)}.
      </p>
    </Card>
  );
}

function describeDelimiter(delimiter: string) {
  return delimiter === ';' ? 'semicolon' : delimiter === '\t' ? 'tab' : 'comma';
}

// ---------------------------------------------------------------------------
// 3. Progress
// ---------------------------------------------------------------------------

function ProgressStep({ batch }: { batch: ImportBatch }) {
  const jobId = batch.status === 'committing' ? batch.jobs.commit : batch.jobs.validate;
  const job = useJob(jobId);
  const percent = job.data?.progress ?? 0;
  return (
    <Card title={batch.status === 'committing' ? 'Importing…' : 'Checking every row…'}>
      <progress aria-label="Import progress" max={100} value={percent}>
        {percent}%
      </progress>
      <p className="muted">
        {job.data?.progressMessage ?? 'Waiting to start.'} You can leave this page; the work
        continues in the background.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4. Review
// ---------------------------------------------------------------------------

type RowFilter = 'all' | 'error' | 'warning' | 'excluded';

function ReviewStep({
  batch,
  domain,
  onRemap,
}: {
  batch: ImportBatch;
  domain: ImportDomainInfo | undefined;
  onRemap: () => void;
}) {
  const org = useOrg();
  const refresh = useRefreshBatch(batch.id);
  const [filter, setFilter] = useState<RowFilter>(batch.counts.error ? 'error' : 'all');
  const rows = useQuery({
    queryKey: ['import-rows', org, batch.id, batch.version, filter],
    queryFn: () =>
      api.get<{ columns: string[]; rows: ImportRowView[]; nextAfter: number | null }>(
        `/imports/${batch.id}/rows?limit=${PREVIEW_ROWS}${filter === 'all' ? '' : `&status=${filter}`}`,
      ),
  });
  const exclusions = useApiMutation((change: { exclude: number[]; include: number[] }) =>
    api.put(`/imports/${batch.id}/exclusions`, { version: batch.version, ...change }),
  );
  const [ackWarnings, setAckWarnings] = useState(false);
  const [ackDuplicate, setAckDuplicate] = useState(false);
  const commit = useApiMutation(() =>
    api.post(`/imports/${batch.id}/commit`, {
      version: batch.version,
      acknowledgeWarnings: ackWarnings,
      acknowledgeDuplicateFile: ackDuplicate,
    }),
  );
  const importable = batch.counts.valid + batch.counts.warning;
  const canCommit =
    batch.status === 'validated' &&
    batch.counts.error === 0 &&
    importable > 0 &&
    (batch.counts.warning === 0 || ackWarnings) &&
    (!batch.duplicateOfBatchId || ackDuplicate);
  const columnsShown = (rows.data?.columns ?? []).slice(0, 6);

  return (
    <>
      <Card title="3. Review">
        <ul className="summary-list">
          <li>{batch.counts.total} rows in the file</li>
          <li>{batch.counts.valid} ready</li>
          <li>{batch.counts.warning} with warnings</li>
          <li>{batch.counts.error} with errors</li>
          <li>{batch.counts.excluded} excluded</li>
        </ul>
        {batch.duplicateOfBatchId ? (
          <Alert tone="info">
            A file with the same content was already imported (
            <Link to={`/imports/${batch.duplicateOfBatchId}`}>earlier import</Link>).
          </Alert>
        ) : null}
        <div className="actions">
          <Button variant="secondary" onClick={onRemap}>
            Change column matching
          </Button>
          {batch.counts.error + batch.counts.warning > 0 ? (
            <ErrorReportButton batchId={batch.id} />
          ) : null}
        </div>
        <div className="tabs" role="tablist" aria-label="Rows">
          {(
            [
              ['all', 'All rows'],
              ['error', `Errors (${batch.counts.error})`],
              ['warning', `Warnings (${batch.counts.warning})`],
              ['excluded', `Excluded (${batch.counts.excluded})`],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              role="tab"
              aria-selected={filter === key}
              variant={filter === key ? 'primary' : 'ghost'}
              onClick={() => setFilter(key)}
            >
              {label}
            </Button>
          ))}
        </div>
        {rows.isPending ? (
          <Spinner label="Loading rows" />
        ) : rows.isError ? (
          <ErrorAlert error={rows.error} />
        ) : rows.data.rows.length === 0 ? (
          <p className="muted">No rows here.</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Include</th>
                  <th>Problems</th>
                  {columnsShown.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.data.rows.map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={r.excluded ? 'row--excluded' : `row--${r.status}`}
                  >
                    <td>{r.rowNumber}</td>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Include row ${r.rowNumber}`}
                        checked={!r.excluded}
                        disabled={exclusions.isPending}
                        onChange={(e) =>
                          exclusions.mutate(
                            e.target.checked
                              ? { include: [r.rowNumber], exclude: [] }
                              : { exclude: [r.rowNumber], include: [] },
                            { onSuccess: refresh },
                          )
                        }
                      />
                    </td>
                    <td>
                      {r.messages.map((m, i) => (
                        <div
                          key={i}
                          className={m.severity === 'error' ? 'text-error' : 'text-warning'}
                        >
                          {m.field ? `${fieldLabel(domain, m.field)}: ` : ''}
                          {m.message}
                        </div>
                      ))}
                    </td>
                    {columnsShown.map((c, i) => (
                      <td key={c}>{r.cells?.[i] ?? ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows.data?.nextAfter ? (
          <p className="muted">
            Showing the first {PREVIEW_ROWS} rows. Every row was checked; download the error report
            for the full list of problems.
          </p>
        ) : null}
        {domain?.groupsRows ? (
          <p className="muted">Excluding or including a row applies to its whole journal.</p>
        ) : null}
        <ErrorAlert error={exclusions.error} />
      </Card>
      <Card title="4. Import">
        {batch.counts.error > 0 ? (
          <Alert tone="info">Fix the file or exclude the rows with errors before importing.</Alert>
        ) : null}
        {batch.counts.warning > 0 ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ackWarnings}
              onChange={(e) => setAckWarnings(e.target.checked)}
            />{' '}
            I reviewed the {batch.counts.warning} warnings
          </label>
        ) : null}
        {batch.duplicateOfBatchId ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ackDuplicate}
              onChange={(e) => setAckDuplicate(e.target.checked)}
            />{' '}
            Import this file again
          </label>
        ) : null}
        <div className="actions">
          <Button
            disabled={!canCommit}
            busy={commit.isPending}
            onClick={() => commit.mutate(undefined, { onSuccess: refresh })}
          >
            Import {importable} rows
          </Button>
        </div>
        <p className="muted">
          All rows are checked again and imported together: if anything changed in the meantime,
          nothing is imported and you can review again.
        </p>
        <ErrorAlert error={commit.error} />
      </Card>
    </>
  );
}

function fieldLabel(domain: ImportDomainInfo | undefined, key: string) {
  return domain?.fields.find((f) => f.key === key)?.label ?? key;
}

function ErrorReportButton({ batchId }: { batchId: string }) {
  const [exportId, setExportId] = useState<string | null>(null);
  const start = useApiMutation(() =>
    api.post<{ export: ExportView }>(`/imports/${batchId}/error-report`, {}),
  );
  const report = useExport(exportId);
  const download = useApiMutation((id: string) => downloadExport(id));
  if (report.data?.status === 'ready') {
    return (
      <Button
        variant="secondary"
        busy={download.isPending}
        onClick={() => download.mutate(report.data!.id)}
      >
        Download error report
      </Button>
    );
  }
  return (
    <>
      <Button
        variant="secondary"
        busy={
          start.isPending || report.data?.status === 'queued' || report.data?.status === 'running'
        }
        onClick={() => start.mutate(undefined, { onSuccess: (r) => setExportId(r.export.id) })}
      >
        Prepare error report
      </Button>
      <ErrorAlert error={start.error ?? download.error} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Result
// ---------------------------------------------------------------------------

function DoneStep({ batch }: { batch: ImportBatch }) {
  const refresh = useRefreshBatch(batch.id);
  const [confirm, setConfirm] = useState(false);
  const discard = useApiMutation(() =>
    api.post<{ discarded: number; kept: number }>(`/imports/${batch.id}/discard-drafts`, {}),
  );
  const target: Record<string, [string, string]> = {
    chart_of_accounts: ['/accounting/accounts', 'Open the chart of accounts'],
    parties: ['/parties', 'Open contacts'],
    party_contacts: ['/parties', 'Open contacts'],
    dimension_values: ['/accounting/dimensions', 'Open dimensions'],
    exchange_rates: ['/accounting', 'Open accounting'],
    manual_journals: ['/accounting/journals/drafts', 'Open draft journals'],
  };
  const [href, label] = target[batch.domain] ?? ['/', 'Home'];
  return (
    <Card title="Imported">
      <Alert tone="success">
        {batch.created ?? 0} {batch.domain === 'manual_journals' ? 'draft journals' : 'records'}{' '}
        created
        {batch.committedAt ? ` on ${formatDateTime(batch.committedAt)}` : ''}.
      </Alert>
      <p>
        <Link to={href}>{label}</Link>
      </p>
      {batch.domain === 'manual_journals' ? (
        <>
          <p className="muted">
            The journals are drafts. Submit, approve and post them as usual. Drafts from this import
            that were never submitted can be discarded; they are kept as discarded, never deleted.
          </p>
          {discard.data ? (
            <Alert tone="success">
              {discard.data.discarded} {discard.data.discarded === 1 ? 'draft' : 'drafts'} discarded
              {discard.data.kept
                ? `; ${discard.data.kept} already submitted or posted ${discard.data.kept === 1 ? 'was' : 'were'} kept`
                : ''}
              .
            </Alert>
          ) : confirm ? (
            <div className="actions">
              <Button
                variant="secondary"
                busy={discard.isPending}
                onClick={() => discard.mutate(undefined, { onSuccess: refresh })}
              >
                Confirm: discard unsubmitted drafts
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                Keep them
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              Discard unsubmitted drafts from this import
            </Button>
          )}
          <ErrorAlert error={discard.error} />
        </>
      ) : null}
    </Card>
  );
}

function EndedStep({ batch }: { batch: ImportBatch }) {
  const message: Partial<Record<ImportBatch['status'], string>> = {
    failed_file: 'The file could not be read. Fix it and start a new import.',
    cancelled: 'This import was cancelled. Nothing was imported.',
    expired: 'This import expired before it was completed. Nothing was imported.',
  };
  return (
    <Card>
      <Alert tone="info">{message[batch.status] ?? STATUS_LABELS[batch.status]}</Alert>
      <p>
        <Link to="/imports">Start a new import</Link>
      </p>
    </Card>
  );
}

function CancelImport({ batch }: { batch: ImportBatch }) {
  const refresh = useRefreshBatch(batch.id);
  const cancel = useApiMutation(() =>
    api.post(`/imports/${batch.id}/cancel`, { version: batch.version }),
  );
  if (!['awaiting_file', 'ready', 'validated', 'needs_review'].includes(batch.status)) return null;
  return (
    <p>
      <Button
        variant="ghost"
        busy={cancel.isPending}
        onClick={() => cancel.mutate(undefined, { onSuccess: refresh })}
      >
        Cancel this import
      </Button>
      <ErrorAlert error={cancel.error} />
    </p>
  );
}
