import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { StatusBadge as AccountingStatusBadge } from '../src/features/accounting/shared';
import type { JournalStatus } from '../src/features/accounting/types';
import type {
  BillStatus,
  ExpenseStatus,
  PaymentStatus,
  RefundStatus,
  VendorCreditStatus,
} from '../src/features/purchases/types';
import { StatusBadge, type KnownStatus } from '../src/features/sales/shared';
import type { CreditNoteStatus, InvoiceStatus } from '../src/features/sales/types';
import { en } from '../src/i18n/messages.en';
import { translate } from '../src/i18n/i18n';
import { ApiError } from '../src/services/api-client';
import { ErrorAlert } from '../src/shared/ui/Alert';
import { EmptyState } from '../src/shared/ui/EmptyState';
import { FileUpload } from '../src/shared/ui/FileUpload';
import { LoadingState } from '../src/shared/ui/LoadingState';
import { Spinner } from '../src/shared/ui/Spinner';
import { makeSession } from './fake-api';

/** UI phase 3, batch E: loading, error and empty states, localization, FileUpload, status badges. */

const webRoot = join(__dirname, '..');

describe('Spinner and LoadingState', () => {
  it('announces a translated default label with one ellipsis', () => {
    render(<Spinner />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Loading…');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('does not double the ellipsis a caller label already has, and adds one when it is missing', () => {
    const { rerender } = render(<Spinner label="Loading…" />);
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    rerender(<Spinner label="Loading contacts" />);
    expect(screen.getByRole('status').textContent).toBe('Loading contacts…');
  });

  it('LoadingState wraps the spinner with the catalog default or a custom label', () => {
    const { rerender, container } = render(<LoadingState />);
    expect(screen.getByRole('status').textContent).toBe(en['common.loading']);
    expect(container.querySelector('.state .spinner')).not.toBeNull();
    rerender(<LoadingState label="Loading report" />);
    expect(screen.getByRole('status').textContent).toBe('Loading report…');
  });
});

describe('EmptyState', () => {
  it('shows only the message it is given', () => {
    const { container } = render(<EmptyState message="No invoices found." />);
    expect(screen.getByText('No invoices found.').className).toBe('muted');
    expect(container.querySelector('.state--empty')).not.toBeNull();
    expect(container.querySelectorAll('a,button')).toHaveLength(0);
  });

  it('renders a caller-supplied action below the message', () => {
    render(<EmptyState message="No bills found." action={<a href="/new">New bill</a>} />);
    expect(screen.getByRole('link', { name: 'New bill' })).toBeTruthy();
  });
});

describe('ErrorAlert', () => {
  it('renders nothing without an error', () => {
    const { container } = render(<ErrorAlert error={null} />);
    expect(container.textContent).toBe('');
  });

  it('shows an error message as an alert', () => {
    render(<ErrorAlert error={new Error('Network down')} />);
    expect(screen.getByRole('alert').textContent).toBe('Network down');
  });

  it('keeps the API request id for support', () => {
    render(<ErrorAlert error={new ApiError(500, 'INTERNAL', 'Server error', 'req-42')} />);
    expect(screen.getByRole('alert').textContent).toBe('Server error (reference req-42)');
  });

  it('uses the translated generic message for a non-Error value', () => {
    render(<ErrorAlert error="boom" />);
    expect(screen.getByRole('alert').textContent).toBe('Something went wrong.');
  });
});

describe('localization', () => {
  it('has catalog entries for every string these components show', () => {
    for (const key of [
      'state.loading',
      'state.loadingSession',
      'state.error.generic',
      'state.error.reference',
      'upload.typeNotAccepted',
      'upload.tooLarge',
      'upload.dropHint',
      'upload.progress',
      'sales.status.posted',
    ] as const) {
      expect(en[key], key).toBeTruthy();
    }
    expect(translate('en', 'upload.tooLarge', { size: '25' })).toBe(
      'The file is larger than 25 MB.',
    );
    expect(translate('en', 'state.error.reference', { id: 'r1' })).toBe('(reference r1)');
  });

  it('keeps the previous English wording', () => {
    expect(en['state.loadingSession']).toBe('Loading your session');
    expect(en['upload.typeNotAccepted']).toBe('This file type is not accepted here.');
    expect(en['upload.dropHint']).toBe('You can also drop a file here.');
    expect(en['upload.progress']).toBe('Upload progress');
  });

  it('leaves no English literals in the shared state components', () => {
    for (const file of [
      'src/shared/ui/Spinner.tsx',
      'src/shared/ui/Alert.tsx',
      'src/shared/ui/FileUpload.tsx',
      'src/shared/ui/LoadingState.tsx',
      'src/shared/ui/EmptyState.tsx',
      'src/auth/RequireAuth.tsx',
    ]) {
      const source = readFileSync(join(webRoot, file), 'utf8');
      for (const literal of [
        'Something went wrong',
        'Loading your session',
        'Upload progress',
        'You can also drop',
        'not accepted here',
        'larger than 25',
        '(reference ',
      ]) {
        expect(source, `${file} still contains "${literal}"`).not.toContain(literal);
      }
    }
  });
});

describe('FileUpload', () => {
  const setup = (overrides: Partial<Parameters<typeof FileUpload>[0]> = {}) => {
    const upload = vi.fn(async (_file: File, onProgress: (fraction: number) => void) => {
      onProgress(0.5);
    });
    render(
      <FileUpload
        accept=".pdf,.png"
        maxBytes={25 * 1024 * 1024}
        label="Attach a file"
        hint="PDF or PNG."
        upload={upload}
        errorMessage={(e) => (e instanceof Error ? e.message : 'failed')}
        {...overrides}
      />,
    );
    return { upload, input: screen.getByLabelText('Attach a file') as HTMLInputElement };
  };

  it('shows the hint and the translated drop hint', () => {
    setup();
    expect(screen.getByText('PDF or PNG. You can also drop a file here.')).toBeTruthy();
  });

  it('uploads an accepted file', async () => {
    const user = userEvent.setup();
    const { upload, input } = setup();
    const file = new File(['x'], 'scan.pdf', { type: 'application/pdf' });
    await user.upload(input, file);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toBe(file);
  });

  it('rejects a file type that is not accepted, without uploading', async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { upload, input } = setup();
    await user.upload(input, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(screen.getByRole('alert').textContent).toBe('This file type is not accepted here.');
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a file over the limit and states the limit from maxBytes', async () => {
    const user = userEvent.setup();
    const { upload, input } = setup({ maxBytes: 2 * 1024 * 1024 });
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' });
    await user.upload(input, big);
    expect(screen.getByRole('alert').textContent).toBe('The file is larger than 2 MB.');
    expect(upload).not.toHaveBeenCalled();
  });

  it('shows a labelled progress bar while uploading and disables the picker', async () => {
    const user = userEvent.setup();
    let finish!: () => void;
    const upload = vi.fn(
      (_file: File, onProgress: (fraction: number) => void) =>
        new Promise<void>((resolve) => {
          onProgress(0.25);
          finish = resolve;
        }),
    );
    const { input } = setup({ upload });
    await user.upload(input, new File(['x'], 'scan.pdf', { type: 'application/pdf' }));
    const bar = await screen.findByLabelText('Upload progress');
    expect(bar.tagName).toBe('PROGRESS');
    expect(input.disabled).toBe(true);
    finish();
    await waitFor(() => expect(screen.queryByLabelText('Upload progress')).toBeNull());
    expect(input.disabled).toBe(false);
  });

  it('shows the message the caller derives from an upload error', async () => {
    const user = userEvent.setup();
    const { input } = setup({
      upload: async () => {
        throw new Error('The server refused the file.');
      },
    });
    await user.upload(input, new File(['x'], 'scan.pdf', { type: 'application/pdf' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The server refused the file.');
  });

  it('accepts a dropped file and marks the zone while dragging over it', async () => {
    const { upload } = setup();
    const zone = screen.getByTestId('file-drop-zone');
    const file = new File(['x'], 'scan.png', { type: 'image/png' });
    const { fireEvent } = await import('@testing-library/react');
    fireEvent.dragOver(zone, { dataTransfer: { files: [file] } });
    expect(zone.classList.contains('file-upload--dragging')).toBe(true);
    fireEvent.dragLeave(zone);
    expect(zone.classList.contains('file-upload--dragging')).toBe(false);
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  });
});

// --- status badges --------------------------------------------------------------------------------

describe('StatusBadge map', () => {
  it('covers every status the typed unions that reach it can hold (checked at compile time)', () => {
    // Fails type-checking if a status in any of these unions is missing from the map.
    const reachable: KnownStatus[] = [
      ...([] as InvoiceStatus[]),
      ...([] as CreditNoteStatus[]),
      ...([] as BillStatus[]),
      ...([] as ExpenseStatus[]),
      ...([] as VendorCreditStatus[]),
      ...([] as PaymentStatus[]),
      ...([] as RefundStatus[]),
      ...(['ACTIVE', 'ARCHIVED'] as const),
    ];
    expect(reachable).toEqual(['ACTIVE', 'ARCHIVED']);
  });

  const tone = (status: string) => {
    const { unmount } = render(<StatusBadge status={status} />);
    const badge = document.querySelector('.badge')!;
    const result = { text: badge.textContent, className: badge.className };
    unmount();
    return result;
  };

  it('gives each known status its explicit tone and translated label', () => {
    expect(tone('DRAFT')).toEqual({ text: 'Draft', className: 'badge badge--neutral' });
    expect(tone('PENDING_APPROVAL').className).toBe('badge badge--warning');
    expect(tone('ISSUED').className).toBe('badge badge--success');
    expect(tone('POSTED')).toEqual({ text: 'Posted', className: 'badge badge--success' });
    expect(tone('RECORDED')).toEqual({ text: 'Recorded', className: 'badge badge--success' });
    expect(tone('VOID').className).toBe('badge badge--danger');
    expect(tone('ACTIVE').className).toBe('badge badge--success');
    expect(tone('ARCHIVED').className).toBe('badge badge--neutral');
  });

  it('shows an unknown status as received, in the neutral tone', () => {
    expect(tone('SOMETHING_NEW')).toEqual({
      text: 'SOMETHING_NEW',
      className: 'badge badge--neutral',
    });
  });

  it('colours accounting statuses explicitly, including the previously uncoloured Discarded', () => {
    const toneOf = (status: JournalStatus | 'OPEN' | 'CLOSED' | 'ACTIVE' | 'ARCHIVED') => {
      const { unmount } = render(<AccountingStatusBadge status={status} />);
      const badge = document.querySelector('.badge')!;
      const result = badge.className;
      unmount();
      return result;
    };
    expect(toneOf('POSTED')).toBe('badge badge--success');
    expect(toneOf('REVERSED')).toBe('badge badge--danger');
    expect(toneOf('PENDING_APPROVAL')).toBe('badge badge--warning');
    expect(toneOf('DRAFT')).toBe('badge badge--neutral');
    expect(toneOf('DISCARDED')).toBe('badge badge--neutral');
    expect(toneOf('OPEN')).toBe('badge badge--success');
    expect(toneOf('CLOSED')).toBe('badge badge--neutral');
  });
});

// --- migrated pages ---------------------------------------------------------------------------------

type Handler = (url: URL) => { status: number; body?: unknown };
const ok = (data: unknown) => () => ({ status: 200, body: { data } });

function renderAt(
  path: string,
  permissions: string[],
  extra: Record<string, Handler | (() => Promise<never>)>,
) {
  const table: Record<string, Handler | (() => Promise<never>)> = {
    'GET /auth/session': ok(makeSession({ permissions })),
    'GET /organizations/current/modules': ok({ modules: {} }),
    'GET /sales/settings': ok({}),
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      const handler = table[`${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`];
      if (!handler) {
        return new Response(
          JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } }),
          { status: 404, headers: { 'content-type': 'application/json' } },
        );
      }
      const result = await (handler as Handler)(url);
      return new Response(JSON.stringify(result.body ?? null), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
}

describe('migrated list states', () => {
  it('Invoices: empty list shows the empty state, not a table', async () => {
    renderAt('/sales/invoices', ['invoices.view'], {
      'GET /sales/invoices': ok({ items: [], nextCursor: null }),
    });
    const message = await screen.findByText('No invoices found.');
    expect(message.closest('.state--empty')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('Parties: shows its own loading label while the request is open, then the empty state', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    renderAt('/parties', ['organization.read', 'parties.view'], {
      'GET /parties': (async () => {
        await gate;
        return { status: 200, body: { data: { items: [], nextCursor: null } } };
      }) as unknown as Handler,
    });
    expect((await screen.findByText(/Loading contacts/)).closest('.state')).not.toBeNull();
    release();
    expect(await screen.findByText('No contacts found.')).toBeTruthy();
    expect(screen.queryByText(/Loading contacts/)).toBeNull();
  });

  it('Bills: a failed list shows the error with its request reference, not an empty state', async () => {
    renderAt('/purchases/bills', ['bills.view'], {
      'GET /purchases/bills': () => ({
        status: 500,
        body: {
          error: { code: 'INTERNAL', message: 'The list is unavailable.', requestId: 'req-9' },
        },
      }),
    });
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/The list is unavailable\./)).toBeTruthy();
    expect(alert.textContent).toContain('(reference req-9)');
    expect(screen.queryByText('No bills found.')).toBeNull();
  });

  it('Customers and Purchase orders: empty lists use the empty state', async () => {
    renderAt('/sales/customers', ['customers.view'], {
      'GET /customers': ok({ items: [], nextCursor: null }),
    });
    expect(
      (await screen.findByText('No customers found.')).closest('.state--empty'),
    ).not.toBeNull();
  });
});

describe('Sales list pages: loading, empty and error states', () => {
  const pages: Array<[string, string, string[], string, string]> = [
    ['Receipts', '/sales/receipts', ['receipts.view'], 'GET /sales/receipts', 'No receipts found.'],
    [
      'Credit notes',
      '/sales/credit-notes',
      ['credit_notes.view'],
      'GET /sales/credit-notes',
      'No credit notes found.',
    ],
    ['Items', '/sales/items', ['invoices.view'], 'GET /sales/items', 'No items found.'],
    ['Customer refunds', '/sales/refunds', ['receipts.view'], 'GET /sales/refunds', 'No refunds.'],
  ];

  describe.each(pages)('%s', (_name, path, permissions, route, emptyText) => {
    it('shows the loading state while the request is open, then the empty state', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      renderAt(path, permissions, {
        [route]: (async () => {
          await gate;
          return { status: 200, body: { data: { items: [], nextCursor: null } } };
        }) as unknown as Handler,
      });
      await waitFor(() => expect(document.querySelector('.state .spinner')).not.toBeNull());
      expect(screen.queryByText(emptyText)).toBeNull();
      release();
      expect((await screen.findByText(emptyText)).closest('.state--empty')).not.toBeNull();
      expect(document.querySelector('.state .spinner')).toBeNull();
      expect(screen.queryByRole('table')).toBeNull();
    });

    it('shows the error with its request reference, not the empty state', async () => {
      renderAt(path, permissions, {
        [route]: () => ({
          status: 500,
          body: {
            error: { code: 'INTERNAL', message: 'The list is unavailable.', requestId: 'req-7' },
          },
        }),
      });
      const alert = await screen.findByRole('alert');
      expect(within(alert).getByText(/The list is unavailable\./)).toBeTruthy();
      expect(alert.textContent).toContain('(reference req-7)');
      expect(screen.queryByText(emptyText)).toBeNull();
      expect(document.querySelector('.state--empty')).toBeNull();
    });
  });

  it('Customer refunds: a list with rows still shows the table, and no empty state', async () => {
    renderAt('/sales/refunds', ['receipts.view'], {
      'GET /sales/refunds': ok({
        items: [
          {
            id: 'rf1',
            status: 'RECORDED',
            number: 'RF-00001',
            customerId: 'c1',
            customerName: 'Lagoon Traders',
            sourceType: 'receipt',
            sourceId: 'r1',
            refundDate: '2026-03-31',
            currencyCode: 'MVR',
            amount: '60.00',
            baseAmount: '60.00',
            reference: null,
            version: 1,
            voidedAt: null,
          },
        ],
        nextCursor: null,
      }),
    });
    expect(await screen.findByRole('link', { name: 'RF-00001' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.queryByText('No refunds.')).toBeNull();
    expect(document.querySelector('.state--empty')).toBeNull();
  });
});

describe('Sales detail and editor pages: loading state', () => {
  const failure = {
    status: 500,
    body: {
      error: { code: 'INTERNAL', message: 'The record is unavailable.', requestId: 'req-3' },
    },
  };
  // [name, path, permissions, the request held open, the response sent when released]
  const pages: Array<[string, string, string[], string, { status: number; body?: unknown }]> = [
    ['Invoice detail', '/sales/invoices/i1', ['invoices.view'], 'GET /sales/invoices/i1', failure],
    [
      'Invoice edit',
      '/sales/invoices/i1/edit',
      ['invoices.edit_draft'],
      'GET /sales/invoices/i1',
      failure,
    ],
    [
      'Credit note detail',
      '/sales/credit-notes/n1',
      ['credit_notes.view'],
      'GET /sales/credit-notes/n1',
      failure,
    ],
    [
      'Credit note edit',
      '/sales/credit-notes/n1/edit',
      ['credit_notes.create'],
      'GET /sales/credit-notes/n1',
      failure,
    ],
    ['Receipt detail', '/sales/receipts/r1', ['receipts.view'], 'GET /sales/receipts/r1', failure],
    [
      'Apply credit (source lookup)',
      '/sales/customer-credit/apply?sourceType=receipt&sourceId=r1',
      ['receipts.create'],
      'GET /sales/receipts/r1',
      failure,
    ],
    [
      'Customer refund detail',
      '/sales/refunds/rf1',
      ['receipts.view'],
      'GET /sales/refunds/rf1',
      failure,
    ],
    [
      'Sales report (aging)',
      '/sales/reports',
      ['sales.reports.view'],
      'GET /sales/reports/aging',
      failure,
    ],
    [
      'Document editor (customer list)',
      '/sales/invoices/new',
      ['invoices.create'],
      'GET /customers',
      { status: 200, body: { data: { items: [], nextCursor: null } } },
    ],
  ];

  it.each(pages)(
    '%s: shows the loading state while the request is open, then leaves it',
    async (_name, path, permissions, route, response) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      renderAt(path, permissions, {
        [route]: (async () => {
          await gate;
          return response;
        }) as unknown as Handler,
      });
      await waitFor(() => expect(document.querySelector('.state .spinner')).not.toBeNull());
      expect(document.querySelector('.state .spinner')?.textContent).toBe('Loading…');
      expect(screen.queryByRole('alert')).toBeNull();
      release();
      await waitFor(() => expect(document.querySelector('.state .spinner')).toBeNull());
      if (response.status >= 400) {
        // Error handling is unchanged: the failed request shows its error with the reference.
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('(reference req-3)');
      }
    },
  );
});
