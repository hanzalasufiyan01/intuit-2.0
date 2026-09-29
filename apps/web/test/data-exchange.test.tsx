import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** S6 UI: import wizard, history, export actions, exports list, journal discard (L-9). */

type Handler = (url: URL, body: unknown) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const key = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url, body)
        : {
            status: 404,
            body: { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } },
          };
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const ok = (data: unknown) => () => ({ status: 200, body: { data } });
const IMPORTER = [
  'accounting.accounts.view',
  'accounting.accounts.create',
  'accounting.journals.view',
  'accounting.journals.create',
  'accounting.journals.edit_draft',
];

const fields = [
  {
    key: 'code',
    label: 'Code',
    required: true,
    description: 'Account code.',
    example: '1150',
    synonyms: [],
  },
  {
    key: 'name',
    label: 'Name',
    required: true,
    description: 'Account name.',
    example: 'Petty Cash',
    synonyms: [],
  },
  {
    key: 'type',
    label: 'Type',
    required: true,
    description: 'Asset, …',
    example: 'Asset',
    synonyms: [],
  },
  {
    key: 'description',
    label: 'Description',
    required: false,
    description: 'Notes.',
    example: '',
    synonyms: [],
  },
];
const catalog = [
  { key: 'chart_of_accounts', label: 'Chart of accounts', groupsRows: false, fields },
];

function batch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    domain: 'chart_of_accounts',
    domainLabel: 'Chart of accounts',
    status: 'awaiting_file',
    version: 1,
    options: { dateFormat: 'YYYY-MM-DD', decimalSeparator: '.', delimiter: 'auto' },
    mapping: null,
    mappingVersion: 0,
    validatedMappingVersion: null,
    columns: null,
    counts: { total: 0, valid: 0, warning: 0, error: 0, excluded: 0 },
    fileId: null,
    fileName: null,
    duplicateOfBatchId: null,
    lastError: null,
    created: null,
    discardedDrafts: null,
    jobs: { validate: null, commit: null },
    createdByUserId: 'u1',
    createdAt: '2026-09-28T10:00:00Z',
    committedAt: null,
    finishedAt: null,
    expiresAt: '2026-10-05T10:00:00Z',
    redacted: false,
    ...overrides,
  };
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('navigation', () => {
  it('shows Import only with an import permission, Exports always', async () => {
    stubApi({ 'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })) });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByText('Import')).toBeNull();
    expect(within(nav).getByText('Exports')).toBeTruthy();
  });
});

describe('import history and start', () => {
  it('starts an import with the chosen type and formats, then opens the wizard', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok(catalog),
      'GET /imports': ok([
        batch({
          id: 'old',
          status: 'committed',
          fileName: 'coa.csv',
          counts: { total: 3, valid: 3, warning: 0, error: 0, excluded: 0 },
        }),
      ]),
      'POST /imports': () => ({ status: 201, body: { data: batch() } }),
      'GET /imports/b1': ok(batch()),
    });
    const router = renderAt('/imports');
    expect(await screen.findByText('coa.csv')).toBeTruthy();
    expect(screen.getByText('Imported')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('What to import'), 'chart_of_accounts');
    await user.selectOptions(screen.getByLabelText('Dates in the file'), 'DD/MM/YYYY');
    await user.selectOptions(screen.getByLabelText('Decimal separator'), ',');
    await user.click(screen.getByRole('button', { name: 'Start import' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/imports/b1'));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      domain: 'chart_of_accounts',
      options: { dateFormat: 'DD/MM/YYYY', decimalSeparator: ',' },
    });
    expect(
      (await screen.findByRole('link', { name: 'Download the CSV template' })).getAttribute('href'),
    ).toBe('/api/v1/imports/templates/chart_of_accounts');
    expect(screen.getByText('Account code.')).toBeTruthy(); // field guide
  });
});

describe('mapping', () => {
  it('pre-fills the suggested mapping, requires the required fields and starts validation', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok(catalog),
      'GET /imports/b1': ok(batch({ status: 'ready', fileName: 'coa.csv' })),
      'POST /imports/b1/inspect': ok({
        batch: batch({
          status: 'ready',
          version: 3,
          options: { dateFormat: 'YYYY-MM-DD', decimalSeparator: '.', delimiter: ';' },
        }),
        columns: ['GL Code', 'Title', 'Kind', 'Notes'],
        sample: [['1150', 'Petty Cash', 'Asset', '']],
        suggestedMapping: { code: 0, name: 1, type: null, description: 3 },
        fields,
      }),
      'GET /import-mappings': ok([]),
      'PUT /imports/b1/mapping': () => ({
        status: 202,
        body: { data: { batch: batch({ status: 'validating' }), jobId: 'j1' } },
      }),
    });
    renderAt('/imports/b1');
    const typeSelect = await screen.findByLabelText('Column for Type');
    expect((screen.getByLabelText('Column for Code') as HTMLSelectElement).value).toBe('0');
    expect(screen.getByText('Delimiter detected: semicolon.', { exact: false })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check all rows' })).toHaveProperty('disabled', true);
    await user.selectOptions(typeSelect, '2');
    await user.click(screen.getByRole('button', { name: 'Check all rows' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      version: 3,
      mapping: { code: 0, name: 1, type: 2, description: 3 },
      options: { dateFormat: 'YYYY-MM-DD', decimalSeparator: '.' },
    });
  });
});

describe('review and commit', () => {
  const rows = [
    {
      rowNumber: 1,
      status: 'valid',
      excluded: false,
      groupKey: null,
      cells: ['1150', 'Petty', 'Asset'],
      messages: [],
      recordId: null,
    },
    {
      rowNumber: 2,
      status: 'warning',
      excluded: false,
      groupKey: null,
      cells: ['1160', 'Float', 'Asset'],
      messages: [
        {
          severity: 'warning',
          code: 'POSSIBLE_DUPLICATE',
          field: 'name',
          message: 'Same name exists.',
        },
      ],
      recordId: null,
    },
    {
      rowNumber: 3,
      status: 'error',
      excluded: false,
      groupKey: null,
      cells: ['1110', 'Dup', 'Asset'],
      messages: [
        {
          severity: 'error',
          code: 'ALREADY_EXISTS',
          field: 'code',
          message: 'An account with this code already exists.',
        },
      ],
      recordId: null,
    },
  ];

  it('shows problems with field labels, excludes rows and blocks the commit while errors remain', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok(catalog),
      'GET /imports/b1': ok(
        batch({
          status: 'validated',
          version: 5,
          counts: { total: 3, valid: 1, warning: 1, error: 1, excluded: 0 },
        }),
      ),
      'GET /imports/b1/rows': (url) => ({
        status: 200,
        body: {
          data: {
            columns: ['code', 'name', 'type'],
            rows: url.searchParams.get('status') === 'error' ? [rows[2]] : rows,
            nextAfter: null,
          },
        },
      }),
      'PUT /imports/b1/exclusions': () => ({
        status: 202,
        body: { data: { batch: batch({ status: 'validating' }), jobId: 'j2' } },
      }),
    });
    renderAt('/imports/b1');
    expect(await screen.findByText('Code: An account with this code already exists.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Import 2 rows/ })).toHaveProperty('disabled', true);
    await user.click(screen.getByLabelText('Include row 3'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      version: 5,
      exclude: [3],
      include: [],
    });
  });

  it('requires acknowledging warnings and a duplicate file before importing', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok(catalog),
      'GET /imports/b1': ok(
        batch({
          status: 'validated',
          version: 7,
          duplicateOfBatchId: 'b0',
          counts: { total: 3, valid: 1, warning: 1, error: 0, excluded: 1 },
        }),
      ),
      'GET /imports/b1/rows': ok({
        columns: ['code', 'name', 'type'],
        rows: rows.slice(0, 2),
        nextAfter: null,
      }),
      'POST /imports/b1/commit': () => ({
        status: 202,
        body: { data: { batch: batch({ status: 'committing' }), jobId: 'j3' } },
      }),
    });
    renderAt('/imports/b1');
    const button = await screen.findByRole('button', { name: 'Import 2 rows' });
    expect(button).toHaveProperty('disabled', true);
    expect(screen.getByRole('link', { name: 'earlier import' })).toBeTruthy();
    await user.click(screen.getByLabelText('I reviewed the 1 warnings'));
    expect(button).toHaveProperty('disabled', true);
    await user.click(screen.getByLabelText('Import this file again'));
    await user.click(button);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      version: 7,
      acknowledgeWarnings: true,
      acknowledgeDuplicateFile: true,
    });
  });

  it('tells the user when only the first 500 rows are shown (L-1)', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok(catalog),
      'GET /imports/b1': ok(
        batch({
          status: 'validated',
          counts: { total: 1200, valid: 1200, warning: 0, error: 0, excluded: 0 },
        }),
      ),
      'GET /imports/b1/rows': ok({ columns: ['code'], rows: rows.slice(0, 1), nextAfter: 500 }),
    });
    renderAt('/imports/b1');
    expect(
      await screen.findByText(/Showing the first 500 rows\. Every row was checked/),
    ).toBeTruthy();
  });
});

describe('result', () => {
  it('discards unsubmitted imported drafts after confirmation (L-9)', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /imports/catalog': ok([
        {
          ...catalog[0],
          key: 'manual_journals',
          label: 'Manual journals (drafts)',
          groupsRows: true,
        },
      ]),
      'GET /imports/b1': ok(
        batch({
          domain: 'manual_journals',
          domainLabel: 'Manual journals (drafts)',
          status: 'committed',
          created: 4,
          committedAt: '2026-09-28T11:00:00Z',
        }),
      ),
      'POST /imports/b1/discard-drafts': ok({ batch: batch(), discarded: 3, kept: 1 }),
    });
    renderAt('/imports/b1');
    expect(await screen.findByText(/4 draft journals created/)).toBeTruthy();
    await user.click(
      screen.getByRole('button', { name: 'Discard unsubmitted drafts from this import' }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm: discard unsubmitted drafts' }));
    expect(
      await screen.findByText(/3 drafts discarded; 1 already submitted or posted was kept/),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });
});

describe('exports', () => {
  it('exports the screen filters, waits for the file and downloads it', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    let polls = 0;
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['accounting.reports.view', 'accounting.journals.view'] }),
      ),
      'GET /accounting/reports/trial-balance': () => ({
        status: 409,
        body: {
          error: { code: 'FISCAL_YEAR_NOT_FOUND', message: 'No fiscal year.', requestId: 'r' },
        },
      }),
      'POST /exports': () => ({
        status: 202,
        body: { data: { export: { id: 'e1', status: 'queued' }, jobId: 'j' } },
      }),
      'GET /exports/e1': () => {
        polls += 1;
        return ok({
          id: 'e1',
          domain: 'trial_balance',
          status: polls > 1 ? 'ready' : 'running',
          rowCount: 12,
        })();
      },
      'GET /exports/e1/download-url': ok({ url: '/api/v1/files/content?token=t', expiresAt: 'x' }),
    });
    renderAt('/accounting/reports/trial-balance?from=2026-01-01&to=2026-03-31');
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    const download = await screen.findByRole(
      'button',
      { name: 'Download 12 rows' },
      { timeout: 5000 },
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      domain: 'trial_balance',
      params: { from: '2026-01-01', to: '2026-03-31' },
    });
    await user.click(download);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/v1/files/content?token=t'));
  });

  it('shows a failed export with its reason', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['accounting.accounts.view'] })),
      'GET /accounting/setup': ok({
        isSetUp: true,
        settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: false },
        templates: [],
      }),
      'GET /accounting/accounts': ok([]),
      'POST /exports': () => ({
        status: 202,
        body: { data: { export: { id: 'e2', status: 'queued' }, jobId: 'j' } },
      }),
      'GET /exports/e2': ok({
        id: 'e2',
        status: 'failed',
        error: 'The export is larger than 25 MB.',
      }),
    });
    renderAt('/accounting/accounts');
    await user.click(await screen.findByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText(/The export is larger than 25 MB\./)).toBeTruthy();
  });

  it('lists my exports with download links for ready ones', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: [] })),
      'GET /exports': ok([
        {
          id: 'e1',
          domain: 'chart_of_accounts',
          domainLabel: 'Chart of accounts',
          status: 'ready',
          params: {},
          rowCount: 35,
          fileId: 'f',
          error: null,
          createdAt: '2026-09-28T10:00:00Z',
          finishedAt: null,
          expiresAt: '2026-10-05T10:00:00Z',
        },
        {
          id: 'e2',
          domain: 'journals',
          domainLabel: 'Journals',
          status: 'expired',
          params: {},
          rowCount: 3,
          fileId: null,
          error: null,
          createdAt: '2026-09-20T10:00:00Z',
          finishedAt: null,
          expiresAt: '2026-09-27T10:00:00Z',
        },
      ]),
    });
    renderAt('/exports');
    expect(await screen.findByRole('button', { name: 'Download Chart of accounts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download Journals' })).toBeNull();
    expect(screen.getByText('Expired')).toBeTruthy();
  });
});

describe('journal discard (L-9)', () => {
  function journal(overrides: Record<string, unknown>) {
    return {
      id: 'j1',
      number: null,
      status: 'DRAFT',
      source: 'manual',
      entryDate: '2026-03-15',
      description: 'Imported',
      reference: '',
      currency: 'MVR',
      exchangeRate: null,
      exchangeRateSource: null,
      baseCurrency: null,
      totalDebit: null,
      totalBaseDebit: null,
      createdByUserId: 'u2',
      submittedByUserId: null,
      submittedAt: null,
      createdAt: '2026-03-15T00:00:00Z',
      postedAt: null,
      lines: [],
      approval: null,
      approvalFacts: { transactionType: 'manual', baseAmount: '100', baseCurrency: 'MVR' },
      approvalSteps: [],
      approvalRequiredForPosting: false,
      reversedByJournalId: null,
      reversesJournalId: null,
      reversalReason: null,
      sourceModule: 'data_exchange',
      sourceType: 'import_batch',
      sourceId: 'b1',
      ...overrides,
    };
  }
  const base = {
    'GET /accounting/setup': ok({
      isSetUp: true,
      settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: false },
      templates: [],
    }),
    'GET /accounting/accounts': ok([]),
  };

  it('offers discard for a never-submitted imported draft and links the import', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      ...base,
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /accounting/journals/j1': ok(journal({})),
      'POST /accounting/journals/j1/discard': ok(
        journal({ status: 'DISCARDED', discardedAt: '2026-09-28T10:00:00Z' }),
      ),
    });
    renderAt('/accounting/journals/j1');
    expect((await screen.findByRole('link', { name: 'an import' })).getAttribute('href')).toBe(
      '/imports/b1',
    );
    await user.click(screen.getByRole('button', { name: 'Discard imported draft' }));
    await user.click(screen.getByRole('button', { name: 'Confirm discard' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url.pathname.endsWith('/discard'))).toBe(
        true,
      ),
    );
  });

  it('does not offer discard for submitted, non-imported or read-only cases', async () => {
    for (const [permissions, overrides] of [
      [IMPORTER, { submittedAt: '2026-03-16T00:00:00Z' }],
      [IMPORTER, { sourceModule: null, sourceType: null, sourceId: null }],
      [['accounting.journals.view'], {}],
    ] as const) {
      stubApi({
        ...base,
        'GET /auth/session': ok(makeSession({ permissions: [...permissions] })),
        'GET /accounting/journals/j1': ok(journal(overrides)),
      });
      const { unmount } = render(
        <App
          router={createMemoryRouter(routes, { initialEntries: ['/accounting/journals/j1'] })}
          queryClient={createQueryClient()}
        />,
      );
      expect(await screen.findByText('Imported')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Discard imported draft' })).toBeNull();
      unmount();
      vi.unstubAllGlobals();
    }
  });

  it('shows a discarded journal as kept and final', async () => {
    stubApi({
      ...base,
      'GET /auth/session': ok(makeSession({ permissions: IMPORTER })),
      'GET /accounting/journals/j1': ok(
        journal({ status: 'DISCARDED', discardedAt: '2026-09-28T10:00:00Z' }),
      ),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByText(/This imported draft was discarded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });
});
