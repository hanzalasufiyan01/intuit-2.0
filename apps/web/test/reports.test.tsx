import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** S3 financial report UI: permission-aware, URL-driven filters, integrity, drill-down. */

type Handler = (url: URL) => { status: number; body?: unknown };

function stubApi(table: Record<string, Handler>) {
  const urls: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      urls.push(url);
      const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
      const result = table[key]
        ? table[key](url)
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
  return urls;
}

const ok = (data: unknown) => () => ({ status: 200, body: { data } });
const setup = {
  isSetUp: true,
  settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: true },
  templates: [],
};
const REPORTS = ['organization.read', 'accounting.reports.view'];
const FULL = [
  ...REPORTS,
  'accounting.ledger.view',
  'accounting.dimensions.view',
  'accounting.periods.view',
];

const common = {
  baseCurrency: 'MVR',
  currencyView: 'base',
  includeZero: false,
  dimensionFilter: [],
  taggedActivityOnly: false,
  warnings: [],
  generatedAt: '2026-09-28T00:00:00Z',
};
const balanced = { status: 'BALANCED', checks: [] };

function tbRow(
  key: string,
  code: string,
  name: string,
  level: number,
  isLeaf: boolean,
  extra = {},
) {
  return {
    rowType: 'account',
    key,
    accountId: key,
    code,
    name,
    level,
    isLeaf,
    archived: false,
    includesPriorYearEarnings: false,
    openingDebit: '0.0000',
    openingCredit: '0.0000',
    periodDebit: '0.0000',
    periodCredit: '300.0000',
    closingDebit: '0.0000',
    closingCredit: '300.0000',
    netBalance: '-300.0000',
    accountCurrency: null,
    drill: {
      kind: 'ledger',
      accountId: key,
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
      openingBasis: 'fiscal_year',
    },
    ...extra,
  };
}

const trialBalance = {
  ...common,
  report: 'trial_balance',
  from: '2026-01-01',
  to: '2026-06-30',
  fiscalYear: { id: 'fy', name: 'FY2026', startDate: '2026-01-01', endDate: '2026-12-31' },
  rows: [tbRow('p', '4000', 'Revenue', 0, false), tbRow('s', '4100', 'Sales Revenue', 1, true)],
  totals: {
    openingDebit: '600.0000',
    openingCredit: '600.0000',
    periodDebit: '300.0000',
    periodCredit: '300.0000',
    closingDebit: '800.0000',
    closingCredit: '800.0000',
  },
  integrity: balanced,
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('financial reports UI', () => {
  it('shows report navigation only with accounting.reports.view', async () => {
    stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'accounting.ledger.view'] }),
      ),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/ledger': ok({
        baseCurrency: 'MVR',
        openingBalance: null,
        totals: { baseDebit: '0', baseCredit: '0' },
        truncated: false,
        rows: [],
      }),
      'GET /accounting/accounts': ok([]),
    });
    renderAt('/accounting/ledger');
    const nav = await screen.findByRole('navigation', { name: 'Accounting' });
    expect(within(nav).queryByText('Trial Balance')).toBeNull();
  });

  it('renders the trial balance with totals, integrity, hierarchy collapse and drill links', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: FULL })),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/reports/trial-balance': ok(trialBalance),
      'GET /accounting/dimensions': ok([]),
      'GET /accounting/fiscal-years': ok([]),
      'GET /accounting/periods': ok([]),
    });
    renderAt('/accounting/reports/trial-balance');
    expect(await screen.findByTestId('tb-closing-debit')).toHaveProperty('textContent', '800.00');
    expect(screen.getByTestId('integrity').textContent).toBe('Balanced');
    const link = screen
      .getAllByRole('link', { name: '300.00' })
      .find((l) => l.getAttribute('href')!.includes('accountId=s'))!;
    expect(link.getAttribute('href')).toBe(
      '/accounting/ledger?accountId=s&toDate=2026-06-30&fromDate=2026-01-01&openingBasis=fiscal_year',
    );
    await user.click(screen.getByRole('button', { name: 'Collapse Revenue' }));
    expect(screen.queryByText(/Sales Revenue/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Expand Revenue' }));
    expect(screen.getByText(/Sales Revenue/)).toBeTruthy();
  });

  it('shows plain amounts instead of drill links without ledger access, and hides dimension filters', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: REPORTS })),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/reports/trial-balance': ok(trialBalance),
    });
    renderAt('/accounting/reports/trial-balance');
    await screen.findByTestId('tb-closing-debit');
    expect(screen.queryAllByRole('link', { name: '300.00' })).toHaveLength(0);
    expect(screen.queryByLabelText('Department')).toBeNull();
    expect(screen.queryByLabelText('Fiscal year')).toBeNull();
  });

  it('applies filters through the URL, including comparison and dimension filters', async () => {
    const user = userEvent.setup();
    const urls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: FULL })),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/dimensions': ok([
        {
          id: 't',
          code: 'DEPT',
          name: 'Department',
          description: '',
          isRequired: false,
          scope: { accountTypes: [], accountSubtypes: [] },
          status: 'ACTIVE',
          values: [
            {
              id: 'v-sales',
              dimensionTypeId: 't',
              code: 'S',
              name: 'Sales',
              status: 'ACTIVE',
              archivedAt: null,
            },
          ],
        },
      ]),
      'GET /accounting/fiscal-years': ok([]),
      'GET /accounting/periods': ok([]),
      'GET /accounting/reports/profit-and-loss': (url) =>
        ok({
          ...common,
          report: 'profit_and_loss',
          taggedActivityOnly: url.searchParams.has('dimensionValueIds'),
          dimensionFilter: url.searchParams.has('dimensionValueIds')
            ? [
                {
                  dimensionTypeId: 't',
                  typeName: 'Department',
                  dimensionValueId: 'v-sales',
                  valueName: 'Sales',
                },
              ]
            : [],
          integrity: url.searchParams.has('dimensionValueIds')
            ? { status: 'NOT_APPLICABLE', checks: [] }
            : balanced,
          columns: url.searchParams.has('compare')
            ? [
                {
                  key: 'current',
                  label: '2026-01-01 – 2026-12-31',
                  from: '2026-01-01',
                  to: '2026-12-31',
                },
                {
                  key: 'comparison',
                  label: '2025-01-01 – 2025-12-31',
                  from: '2025-01-01',
                  to: '2025-12-31',
                },
              ]
            : [
                {
                  key: 'current',
                  label: '2026-01-01 – 2026-12-31',
                  from: '2026-01-01',
                  to: '2026-12-31',
                },
              ],
          sections: [
            {
              key: 'revenue',
              label: 'Revenue',
              rows: [],
              total: url.searchParams.has('compare') ? ['300.0000', '1000.0000'] : ['300.0000'],
            },
          ],
          summary: {
            grossProfit: ['300.0000'],
            operatingProfit: ['300.0000'],
            netProfit: url.searchParams.has('compare') ? ['300.0000', '600.0000'] : ['300.0000'],
          },
        })(),
    });
    renderAt('/accounting/reports/profit-and-loss');
    expect((await screen.findByTestId('net-profit')).textContent).toBe('300.00');
    await user.type(screen.getByLabelText('From'), '2026-01-01');
    await user.type(screen.getByLabelText('To'), '2026-12-31');
    await user.selectOptions(screen.getByLabelText('Compare with'), 'previous_year');
    await user.selectOptions(screen.getByLabelText('Department'), 'v-sales');
    await user.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() => expect(screen.getByText(/Tagged activity only/)).toBeTruthy());
    const last = urls.filter((u) => u.pathname.endsWith('/profit-and-loss')).at(-1)!;
    expect(Object.fromEntries(last.searchParams)).toEqual({
      from: '2026-01-01',
      to: '2026-12-31',
      compare: 'previous_year',
      dimensionValueIds: 'v-sales',
    });
    expect(screen.getByTestId('integrity').textContent).toBe('Balancing checks not applicable');
    expect(screen.getByText('2025-01-01 – 2025-12-31')).toBeTruthy();
  });

  it('explains a missing Retained Earnings designation and out-of-balance states', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: REPORTS })),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/reports/balance-sheet': () => ({
        status: 409,
        body: {
          error: {
            code: 'DESIGNATION_REQUIRED',
            message:
              'Designate a Retained Earnings account (an active equity account) before viewing the Balance Sheet.',
            requestId: 'r',
          },
        },
      }),
      'GET /accounting/reports/trial-balance': ok({
        ...trialBalance,
        integrity: {
          status: 'OUT_OF_BALANCE',
          checks: [
            {
              name: 'closing_debits_equal_credits',
              status: 'FAIL',
              left: '10',
              right: '0',
              difference: '10.0000',
            },
          ],
        },
      }),
    });
    const router = renderAt('/accounting/reports/balance-sheet');
    expect(await screen.findByRole('link', { name: 'Designate system accounts' })).toBeTruthy();
    await router.navigate('/accounting/reports/trial-balance');
    expect((await screen.findByTestId('integrity')).textContent).toBe('Out of balance');
    expect(screen.getByText(/closing debits equal credits: difference 10.00/)).toBeTruthy();
  });

  it('opens the ledger from a drill-down link with the report filters', async () => {
    const urls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: FULL })),
      'GET /accounting/setup': ok(setup),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/dimensions': ok([]),
      'GET /accounting/ledger': ok({
        baseCurrency: 'MVR',
        openingBalance: '-300.0000',
        totals: { baseDebit: '0', baseCredit: '0' },
        truncated: false,
        rows: [],
        openingBasis: 'fiscal_year',
      }),
    });
    renderAt(
      '/accounting/ledger?accountId=s&fromDate=2026-03-01&toDate=2026-06-30&openingBasis=fiscal_year',
    );
    await waitFor(() =>
      expect(urls.some((u) => u.pathname.endsWith('/accounting/ledger'))).toBe(true),
    );
    const ledgerUrl = urls.find((u) => u.pathname.endsWith('/accounting/ledger'))!;
    expect(Object.fromEntries(ledgerUrl.searchParams)).toEqual({
      accountId: 's',
      fromDate: '2026-03-01',
      toDate: '2026-06-30',
      openingBasis: 'fiscal_year',
    });
  });
});
