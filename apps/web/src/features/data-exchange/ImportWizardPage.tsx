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
import { useT } from '../../i18n/i18n';

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const PREVIEW_ROWS = 500;

/** Import wizard (S6-44): upload → map → validate → review → import → result. */
export function ImportWizardPage() {
  const t = useT();
  const { id = '' } = useParams();
  const batch = useImportBatch(id);
  const catalog = useImportCatalog();
  const [remap, setRemap] = useState(false);

  if (batch.isPending || catalog.isPending)
    return <Spinner label={t('data-exchange.importWizardPage.loadingImport')} />;
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
        title={t('data-exchange.importWizardPage.import', { domainLabel: b.domainLabel })}
        description={t('data-exchange.importWizardPage.started', {
          value: t(`imports.status.${b.status}`),
          value2: b.fileName ? ` · ${b.fileName}` : '',
          value3: formatDateTime(b.createdAt),
        })}
      />
      <p>
        <Link to="/imports">{t('data-exchange.importWizardPage.allImports')}</Link>
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
  const t = useT();
  const refresh = useRefreshBatch(batch.id);
  return (
    <>
      <Card title={t('data-exchange.importWizardPage.1ChooseTheFile')}>
        <p>
          <a href={`/api/v1/imports/templates/${batch.domain}`} download>
            {t('data-exchange.importWizardPage.downloadTheCsvTemplate')}
          </a>{' '}
          {t('data-exchange.importWizardPage.forFillItInOr', {
            value: batch.domainLabel.toLowerCase(),
          })}{' '}
          <strong>CSV UTF-8</strong> {t('data-exchange.importWizardPage.or')}{' '}
          <strong>{t('data-exchange.importWizardPage.excelXlsx')}</strong>
          {t('data-exchange.importWizardPage.formulasAreNotCalculatedThe')}
        </p>
        <FileUpload
          accept=".csv,.xlsx"
          maxBytes={MAX_IMPORT_BYTES}
          label={t('data-exchange.importWizardPage.csvOrExcelFile')}
          hint={t('data-exchange.importWizardPage.csvUtf8OrExcel')}
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
  const t = useT();
  return (
    <Card title={t('data-exchange.importWizardPage.columns')}>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>{t('data-exchange.importWizardPage.column')}</th>
              <th>{t('data-exchange.importWizardPage.required')}</th>
              <th>{t('data-exchange.importWizardPage.description')}</th>
              <th>{t('data-exchange.importWizardPage.example')}</th>
            </tr>
          </thead>
          <tbody>
            {domain.fields.map((f) => (
              <tr key={f.key}>
                <td>{f.label}</td>
                <td>{f.required ? t('data-exchange.importWizardPage.yes') : ''}</td>
                <td>{f.description}</td>
                <td>{f.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {domain.groupsRows ? (
        <p className="muted">{t('data-exchange.importWizardPage.rowsWithTheSameJournal')}</p>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Mapping
// ---------------------------------------------------------------------------

function MappingStep({ batch, onDone }: { batch: ImportBatch; onDone: () => void }) {
  const t = useT();
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
      <Spinner label={t('data-exchange.importWizardPage.readingTheFile')} />
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
    <Card title={t('data-exchange.importWizardPage.2MatchTheColumns')}>
      {saved.data?.length ? (
        <div className="field">
          <label htmlFor="saved-mapping">
            {t('data-exchange.importWizardPage.useASavedMapping')}
          </label>
          <select
            id="saved-mapping"
            defaultValue=""
            onChange={(e) => {
              const found = saved.data.find((m) => m.id === e.target.value);
              if (found) applySaved(found);
            }}
          >
            <option value="">{t('common.choose')}</option>
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
              <th>{t('data-exchange.importWizardPage.field')}</th>
              <th>{t('data-exchange.importWizardPage.columnInYourFile')}</th>
              <th>{t('data-exchange.importWizardPage.firstValue')}</th>
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
                      aria-label={t('data-exchange.importWizardPage.columnFor', { label: f.label })}
                      value={column === null ? '' : String(column)}
                      onChange={(e) =>
                        setMapping({
                          ...mapping,
                          [f.key]: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    >
                      <option value="">{t('data-exchange.importWizardPage.notImported')}</option>
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
          <label htmlFor="map-date-format">
            {t('data-exchange.importWizardPage.datesInTheFile')}
          </label>
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
          <label htmlFor="map-decimal">
            {t('data-exchange.importWizardPage.decimalSeparator')}
          </label>
          <select
            id="map-decimal"
            value={decimalSeparator}
            onChange={(e) => setDecimalSeparator(e.target.value as DecimalSeparator)}
          >
            <option value=".">{t('data-exchange.importWizardPage.point123456')}</option>
            <option value=",">{t('data-exchange.importWizardPage.comma123456')}</option>
          </select>
        </div>
      </div>
      {missing.length ? (
        <Alert tone="info">
          {t('data-exchange.importWizardPage.matchTheRequiredFields', {
            value: missing.map((f) => f.label).join(', '),
          })}
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
          {t('data-exchange.importWizardPage.checkAllRows')}
        </Button>
      </div>
      <ErrorAlert error={validate.error} />
      <div className="form form--inline">
        <TextField
          label={t('data-exchange.importWizardPage.saveThisMappingAs')}
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
          {t('data-exchange.importWizardPage.saveMapping')}
        </Button>
      </div>
      {save.isSuccess ? (
        <Alert tone="success">{t('data-exchange.importWizardPage.mappingSaved')}</Alert>
      ) : null}
      <ErrorAlert error={save.error} />
      <p className="muted">
        {t('data-exchange.importWizardPage.columnsYouDonTMatch')}
        {inspected.batch.format === 'xlsx' ? (
          t('data-exchange.importWizardPage.theFirstSheetOfThe')
        ) : (
          <>
            {' '}
            {t('data-exchange.importWizardPage.delimiterDetected', {
              value: describeDelimiter(inspected.batch.options.delimiter),
            })}
          </>
        )}
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
  const t = useT();
  const jobId = batch.status === 'committing' ? batch.jobs.commit : batch.jobs.validate;
  const job = useJob(jobId);
  const percent = job.data?.progress ?? 0;
  return (
    <Card
      title={
        batch.status === 'committing'
          ? t('data-exchange.importWizardPage.importing')
          : t('data-exchange.importWizardPage.checkingEveryRow')
      }
    >
      <progress
        aria-label={t('data-exchange.importWizardPage.importProgress')}
        max={100}
        value={percent}
      >
        {percent}%
      </progress>
      <p className="muted">
        {t('data-exchange.importWizardPage.youCanLeaveThisPage', {
          progressMessage:
            job.data?.progressMessage ?? t('data-exchange.importWizardPage.waitingToStart'),
        })}
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
  const t = useT();
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
      <Card title={t('data-exchange.importWizardPage.3Review')}>
        <ul className="summary-list">
          <li>
            {t('data-exchange.importWizardPage.rowsInTheFile', { total: batch.counts.total })}
          </li>
          <li>{t('data-exchange.importWizardPage.ready', { valid: batch.counts.valid })}</li>
          <li>
            {t('data-exchange.importWizardPage.withWarnings', { warning: batch.counts.warning })}
          </li>
          <li>{t('data-exchange.importWizardPage.withErrors', { error: batch.counts.error })}</li>
          <li>
            {t('data-exchange.importWizardPage.excluded', { excluded: batch.counts.excluded })}
          </li>
        </ul>
        {batch.duplicateOfBatchId ? (
          <Alert tone="info">
            {t('data-exchange.importWizardPage.aFileWithTheSame')}
            <Link to={`/imports/${batch.duplicateOfBatchId}`}>
              {t('data-exchange.importWizardPage.earlierImport')}
            </Link>
            ).
          </Alert>
        ) : null}
        <div className="actions">
          <Button variant="secondary" onClick={onRemap}>
            {t('data-exchange.importWizardPage.changeColumnMatching')}
          </Button>
          {batch.counts.error + batch.counts.warning > 0 ? (
            <ErrorReportButton batchId={batch.id} />
          ) : null}
        </div>
        <div className="tabs" role="tablist" aria-label={t('data-exchange.importWizardPage.rows')}>
          {(
            [
              ['all', t('data-exchange.importWizardPage.tabAll')],
              [
                'error',
                t('data-exchange.importWizardPage.tabErrors', { count: batch.counts.error }),
              ],
              [
                'warning',
                t('data-exchange.importWizardPage.tabWarnings', { count: batch.counts.warning }),
              ],
              [
                'excluded',
                t('data-exchange.importWizardPage.tabExcluded', { count: batch.counts.excluded }),
              ],
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
          <Spinner label={t('data-exchange.importWizardPage.loadingRows')} />
        ) : rows.isError ? (
          <ErrorAlert error={rows.error} />
        ) : rows.data.rows.length === 0 ? (
          <p className="muted">{t('data-exchange.importWizardPage.noRowsHere')}</p>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('data-exchange.importWizardPage.row')}</th>
                  <th>{t('data-exchange.importWizardPage.include')}</th>
                  <th>{t('data-exchange.importWizardPage.problems')}</th>
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
                        aria-label={t('data-exchange.importWizardPage.includeRow', {
                          rowNumber: r.rowNumber,
                        })}
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
            {t('data-exchange.importWizardPage.showingTheFirstRowsEvery', {
              PREVIEWROWS: PREVIEW_ROWS,
            })}
          </p>
        ) : null}
        {domain?.groupsRows ? (
          <p className="muted">{t('data-exchange.importWizardPage.excludingOrIncludingARow')}</p>
        ) : null}
        <ErrorAlert error={exclusions.error} />
      </Card>
      <Card title={t('data-exchange.importWizardPage.4Import')}>
        {batch.counts.error > 0 ? (
          <Alert tone="info">{t('data-exchange.importWizardPage.fixTheFileOrExclude')}</Alert>
        ) : null}
        {batch.counts.warning > 0 ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ackWarnings}
              onChange={(e) => setAckWarnings(e.target.checked)}
            />{' '}
            {t('data-exchange.importWizardPage.iReviewedTheWarnings', {
              warning: batch.counts.warning,
            })}
          </label>
        ) : null}
        {batch.duplicateOfBatchId ? (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={ackDuplicate}
              onChange={(e) => setAckDuplicate(e.target.checked)}
            />{' '}
            {t('data-exchange.importWizardPage.importThisFileAgain')}
          </label>
        ) : null}
        <div className="actions">
          <Button
            disabled={!canCommit}
            busy={commit.isPending}
            onClick={() => commit.mutate(undefined, { onSuccess: refresh })}
          >
            {t('data-exchange.importWizardPage.importRows', { importable })}
          </Button>
        </div>
        <p className="muted">{t('data-exchange.importWizardPage.allRowsAreCheckedAgain')}</p>
        <ErrorAlert error={commit.error} />
      </Card>
    </>
  );
}

function fieldLabel(domain: ImportDomainInfo | undefined, key: string) {
  return domain?.fields.find((f) => f.key === key)?.label ?? key;
}

function ErrorReportButton({ batchId }: { batchId: string }) {
  const t = useT();
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
        {t('data-exchange.importWizardPage.downloadErrorReport')}
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
        {t('data-exchange.importWizardPage.prepareErrorReport')}
      </Button>
      <ErrorAlert error={start.error ?? download.error} />
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. Result
// ---------------------------------------------------------------------------

function DoneStep({ batch }: { batch: ImportBatch }) {
  const t = useT();
  const refresh = useRefreshBatch(batch.id);
  const [confirm, setConfirm] = useState(false);
  const discard = useApiMutation(() =>
    api.post<{ discarded: number; kept: number }>(`/imports/${batch.id}/discard-drafts`, {}),
  );
  const target: Record<string, [string, string]> = {
    chart_of_accounts: ['/accounting/accounts', t('data-exchange.importWizardPage.openAccounts')],
    parties: ['/parties', t('data-exchange.importWizardPage.openContacts')],
    party_contacts: ['/parties', t('data-exchange.importWizardPage.openContacts')],
    dimension_values: [
      '/accounting/dimensions',
      t('data-exchange.importWizardPage.openDimensions'),
    ],
    exchange_rates: ['/accounting', t('data-exchange.importWizardPage.openAccounting')],
    manual_journals: [
      '/accounting/journals/drafts',
      t('data-exchange.importWizardPage.openDrafts'),
    ],
  };
  const [href, label] = target[batch.domain] ?? ['/', t('data-exchange.importWizardPage.home')];
  return (
    <Card title={t('data-exchange.importWizardPage.imported')}>
      <Alert tone="success">
        {t('data-exchange.importWizardPage.created', {
          created: batch.created ?? 0,
          value:
            batch.domain === 'manual_journals'
              ? t('data-exchange.importWizardPage.draftJournals')
              : t('data-exchange.importWizardPage.records'),
          value2: batch.committedAt
            ? t('data-exchange.importWizardPage.on', { value: formatDateTime(batch.committedAt) })
            : '',
        })}
      </Alert>
      <p>
        <Link to={href}>{label}</Link>
      </p>
      {batch.domain === 'manual_journals' ? (
        <>
          <p className="muted">{t('data-exchange.importWizardPage.theJournalsAreDraftsSubmit')}</p>
          {discard.data ? (
            <Alert tone="success">
              {t('data-exchange.importWizardPage.discarded', {
                discarded: discard.data.discarded,
                value:
                  discard.data.discarded === 1
                    ? t('data-exchange.importWizardPage.draft')
                    : t('data-exchange.importWizardPage.drafts'),
                value2: discard.data.kept
                  ? t('data-exchange.importWizardPage.alreadySubmittedOrPostedKept', {
                      kept: discard.data.kept,
                      value: discard.data.kept === 1 ? 'was' : 'were',
                    })
                  : '',
              })}
            </Alert>
          ) : confirm ? (
            <div className="actions">
              <Button
                variant="secondary"
                busy={discard.isPending}
                onClick={() => discard.mutate(undefined, { onSuccess: refresh })}
              >
                {t('data-exchange.importWizardPage.confirmDiscardUnsubmittedDrafts')}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                {t('data-exchange.importWizardPage.keepThem')}
              </Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setConfirm(true)}>
              {t('data-exchange.importWizardPage.discardUnsubmittedDraftsFromThis')}
            </Button>
          )}
          <ErrorAlert error={discard.error} />
        </>
      ) : null}
    </Card>
  );
}

function EndedStep({ batch }: { batch: ImportBatch }) {
  const t = useT();
  const message: Partial<Record<ImportBatch['status'], string>> = {
    failed_file: t('data-exchange.importWizardPage.endedFailedFile'),
    cancelled: t('data-exchange.importWizardPage.endedCancelled'),
    expired: t('data-exchange.importWizardPage.endedExpired'),
  };
  return (
    <Card>
      <Alert tone="info">{message[batch.status] ?? t(`imports.status.${batch.status}`)}</Alert>
      <p>
        <Link to="/imports">{t('data-exchange.importWizardPage.startANewImport')}</Link>
      </p>
    </Card>
  );
}

function CancelImport({ batch }: { batch: ImportBatch }) {
  const t = useT();
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
        {t('data-exchange.importWizardPage.cancelThisImport')}
      </Button>
      <ErrorAlert error={cancel.error} />
    </p>
  );
}
