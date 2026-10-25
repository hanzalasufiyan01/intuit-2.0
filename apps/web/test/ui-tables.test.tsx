import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { Badge } from '../src/shared/ui/Badge';
import { DataTable, NumCell, NumHeader, RowActions } from '../src/shared/ui/Table';
import { makeSession } from './fake-api';

/**
 * UI phase 3, batch A: the table primitives, the typed badge, and the list pages that now use
 * them (Parties, Customers, Invoices, Bills, Purchase orders).
 */

describe('Badge', () => {
  it('renders the tone as a class and the text as its label', () => {
    render(<Badge tone="danger">Void</Badge>);
    const badge = screen.getByText('Void');
    expect(badge.className).toBe('badge badge--danger');
  });

  it('supports every tone', () => {
    for (const tone of ['success', 'warning', 'danger', 'info', 'neutral'] as const) {
      const { unmount } = render(<Badge tone={tone}>{tone}</Badge>);
      expect(screen.getByText(tone).classList.contains(`badge--${tone}`)).toBe(true);
      unmount();
    }
  });
});

describe('DataTable', () => {
  const renderTable = (extra: { className?: string } = {}) =>
    render(
      <DataTable label="Invoices" {...extra}>
        <thead>
          <tr>
            <th>Number</th>
            <NumHeader>Total</NumHeader>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>INV-1</td>
            <NumCell>1,080.00 MVR</NumCell>
            <RowActions>
              <button type="button">Remove</button>
            </RowActions>
          </tr>
        </tbody>
      </DataTable>,
    );

  it('puts the table in a named, focusable, scrolling region', () => {
    const { container } = renderTable();
    const region = screen.getByRole('region', { name: 'Invoices' });
    expect(region.classList.contains('table-scroll')).toBe(true);
    expect(region.getAttribute('tabindex')).toBe('0');
    // The existing browser tests locate tables as `.table-scroll table`.
    expect(container.querySelector('.table-scroll table.table')).not.toBeNull();
    expect(within(region).getByRole('table')).toBeTruthy();
  });

  it('adds extra table classes without losing the base one', () => {
    const { container } = renderTable({ className: 'table--editor' });
    expect(container.querySelector('table')!.className).toBe('table table--editor');
  });

  it('keeps numeric cells and headers as td.num and th.num, and actions in a normal cell', () => {
    const { container } = renderTable();
    expect(container.querySelector('td.num')!.textContent).toBe('1,080.00 MVR');
    expect(container.querySelector('th.num')!.textContent).toBe('Total');
    const cell = screen.getByRole('button', { name: 'Remove' }).closest('td')!;
    expect(cell.classList.contains('actions')).toBe(false); // the flex wrapper is inside the cell
    expect(cell.querySelector(':scope > div.actions')).not.toBeNull();
  });

  it('merges a caller class with num', () => {
    const { container } = render(
      <table>
        <tbody>
          <tr>
            <NumCell className="muted">1</NumCell>
          </tr>
        </tbody>
      </table>,
    );
    expect(container.querySelector('td')!.className).toBe('num muted');
  });
});

// --- migrated pages -------------------------------------------------------------------------------

type Handler = (url: URL) => { status: number; body?: unknown };
const ok = (data: unknown) => () => ({ status: 200, body: { data } });

function stubApi(table: Record<string, Handler>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
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
}

function renderAt(path: string, permissions: string[], extra: Record<string, Handler>) {
  stubApi({
    'GET /auth/session': ok(makeSession({ permissions })),
    'GET /organizations/current/modules': ok({ modules: {} }),
    ...extra,
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

/** The scrolling region around the one table in the page's content area. */
const contentRegion = (name: string) =>
  screen.findByRole('region', { name }).then((region) => {
    expect(region.classList.contains('table-scroll')).toBe(true);
    expect(region.querySelector('table.table')).not.toBeNull();
    return region;
  });

describe('migrated list pages', () => {
  it('Parties: wraps the list, and keeps the Archived badge neutral', async () => {
    renderAt('/parties', ['organization.read', 'parties.view'], {
      'GET /parties': ok({
        items: [
          {
            id: 'p1',
            displayName: 'Blue Lagoon Traders',
            reference: 'C-1',
            roles: ['customer'],
            email: 'a@example.test',
            status: 'ARCHIVED',
          },
        ],
        nextCursor: null,
      }),
    });
    const region = await contentRegion('Contacts');
    expect(within(region).getByRole('link', { name: 'Blue Lagoon Traders' })).toBeTruthy();
    const badge = within(region).getByText('archived', { selector: '.badge' });
    expect(badge.classList.contains('badge--neutral')).toBe(true);
  });

  it('Customers: wraps the list and shows an Active status as success', async () => {
    renderAt('/sales/customers', ['customers.view'], {
      'GET /sales/settings': ok({}),
      'GET /customers': ok({
        items: [
          {
            id: 'c1',
            displayName: 'Coral Bay',
            reference: 'C-2',
            email: 'c@example.test',
            currencyCode: 'MVR',
            status: 'ACTIVE',
          },
        ],
        nextCursor: null,
      }),
    });
    const region = await contentRegion('Customers');
    expect(within(region).getByRole('link', { name: 'Coral Bay' })).toBeTruthy();
    expect(
      within(region)
        .getByText('Active', { selector: '.badge' })
        .classList.contains('badge--success'),
    ).toBe(true);
  });

  it('Invoices: numbers stay td.num, and each status keeps its meaning', async () => {
    const invoice = (id: string, status: string, number: string | null) => ({
      id,
      number,
      kind: 'standard',
      customerName: 'Blue Lagoon Traders',
      invoiceDate: '2026-10-01',
      dueDate: '2026-10-31',
      total: '1080.00',
      amountDue: status === 'ISSUED' ? '1080.00' : null,
      currencyCode: 'MVR',
      status,
    });
    renderAt('/sales/invoices', ['invoices.view'], {
      'GET /sales/settings': ok({}),
      'GET /sales/invoices': ok({
        items: [
          invoice('i1', 'ISSUED', 'INV-00001'),
          invoice('i2', 'VOID', 'INV-00002'),
          invoice('i3', 'DRAFT', null),
          invoice('i4', 'PENDING_APPROVAL', null),
        ],
        nextCursor: null,
      }),
    });
    const region = await contentRegion('Invoices');
    const tone = (label: string) =>
      within(region).getByText(label, { selector: '.badge' }).className.replace('badge ', '');
    expect(tone('Issued')).toBe('badge--success');
    expect(tone('Void')).toBe('badge--danger');
    expect(tone('Draft')).toBe('badge--neutral');
    expect(tone('Pending approval')).toBe('badge--warning');
    expect(region.querySelectorAll('thead th.num')).toHaveLength(2);
    const first = within(region).getByRole('link', { name: 'INV-00001' }).closest('tr')!;
    expect(first.querySelectorAll('td.num')).toHaveLength(2);
    expect(first.querySelector('td.num')!.textContent).toContain('1,080.00 MVR');
  });

  it('Bills: wraps the list and keeps Posted as success', async () => {
    renderAt('/purchases/bills', ['bills.view'], {
      'GET /purchases/bills': ok({
        items: [
          {
            id: 'b1',
            number: 'BILL-00001',
            vendorName: 'Island Supplies',
            vendorReference: 'V-9',
            billDate: '2026-10-01',
            dueDate: '2026-10-31',
            total: '540.00',
            currencyCode: 'MVR',
            status: 'POSTED',
          },
        ],
        nextCursor: null,
      }),
    });
    const region = await contentRegion('Bills');
    expect(
      within(region)
        .getByText('Posted', { selector: '.badge' })
        .classList.contains('badge--success'),
    ).toBe(true);
    expect(region.querySelectorAll('td.num')).toHaveLength(1);
  });

  it('Purchase orders: maps each order status to a tone', async () => {
    const order = (id: string, status: string, number: string) => ({
      id,
      number,
      vendorName: 'Island Supplies',
      orderDate: '2026-10-01',
      expectedDate: null,
      total: '100.00',
      currencyCode: 'MVR',
      status,
    });
    renderAt('/purchases/orders', ['purchase_orders.view'], {
      'GET /purchases/orders': ok({
        items: [
          order('o1', 'CLOSED', 'PO-1'),
          order('o2', 'DRAFT', 'PO-2'),
          order('o3', 'PENDING_APPROVAL', 'PO-3'),
          order('o4', 'APPROVED', 'PO-4'),
        ],
        nextCursor: null,
      }),
    });
    const region = await contentRegion('Purchase orders');
    const toneOfRow = (number: string) =>
      within(within(region).getByRole('link', { name: number }).closest('tr')!)
        .getByText(/./, { selector: '.badge' })
        .className.replace('badge ', '');
    expect(toneOfRow('PO-1')).toBe('badge--danger');
    expect(toneOfRow('PO-2')).toBe('badge--neutral');
    expect(toneOfRow('PO-3')).toBe('badge--warning');
    expect(toneOfRow('PO-4')).toBe('badge--success');
  });
});
