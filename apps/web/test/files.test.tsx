import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createMemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { jobPollDelay, uploadFile, useJob } from '../src/features/files/files';
import { setCsrfToken } from '../src/services/api-client';
import { makeSession } from './fake-api';

/** S5 UI: FileUpload, AttachmentsCard (party, journal), company logo and useJob. */

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

/** Records raw uploads and answers them with a configured status and body. */
class FakeXhr {
  static sent: FakeXhr[] = [];
  static respond: { status: number; body: unknown } = { status: 201, body: {} };
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  withCredentials = false;
  status = 0;
  responseText = '';
  upload: {
    onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  send(body: unknown) {
    this.body = body;
    FakeXhr.sent.push(this);
    setTimeout(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = FakeXhr.respond.status;
      this.responseText = JSON.stringify(FakeXhr.respond.body);
      this.onload?.();
    }, 0);
  }
}

afterEach(() => {
  FakeXhr.sent = [];
  vi.unstubAllGlobals();
});

const ok = (data: unknown) => () => ({ status: 200, body: { data } });
const storedFile = (
  id: string,
  name: string,
  linkType = 'party',
  linkId: string | null = 'p1',
) => ({
  id,
  name,
  type: 'pdf',
  mimeType: 'application/pdf',
  size: 2048,
  sha256: 'a'.repeat(64),
  status: 'available',
  scanStatus: 'not_scanned',
  uploadedAt: '2026-09-28T10:00:00Z',
  uploadedBy: { id: 'u1', displayName: 'Aisha' },
  link: { type: linkType, id: linkId },
});
const party = {
  id: 'p1',
  kind: 'organization',
  displayName: 'Blue Lagoon Traders',
  companyName: null,
  firstName: null,
  lastName: null,
  reference: null,
  tin: null,
  email: null,
  phone: null,
  website: null,
  notes: null,
  status: 'ACTIVE',
  roles: ['customer'],
  version: 1,
  contacts: [],
  addresses: [],
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
  archivedAt: null,
};
const profile = {
  version: 1,
  legalName: 'Example Ltd',
  tradingName: null,
  tin: null,
  gstRegistered: false,
  gstRegistrationNumber: null,
  gstRegisteredFrom: null,
  email: null,
  phone: null,
  website: null,
  identifiers: [],
  registeredAddress: null,
  businessAddress: null,
  updatedAt: '2026-09-28T00:00:00Z',
  logo: null,
};
function journal(status: string) {
  return {
    id: 'j1',
    number: status === 'DRAFT' ? null : 7,
    status,
    source: 'manual',
    entryDate: '2026-03-15',
    description: 'Cash sale',
    reference: '',
    currency: 'MVR',
    exchangeRate: null,
    exchangeRateSource: null,
    baseCurrency: null,
    totalDebit: null,
    totalBaseDebit: null,
    createdByUserId: 'u1',
    submittedByUserId: null,
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
  };
}
const setupState = {
  isSetUp: true,
  settings: { baseCurrency: 'MVR', coaTemplateKey: 'maldives', baseCurrencyLocked: false },
  templates: [],
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('party attachments', () => {
  it('lists, uploads with progress and CSRF, and refreshes', async () => {
    const user = userEvent.setup();
    let files = [storedFile('f1', 'Contract.pdf')];
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['parties.view', 'parties.update'] })),
      'GET /parties/p1': ok(party),
      'GET /files': (url) => {
        expect(url.searchParams.get('linkType')).toBe('party');
        expect(url.searchParams.get('linkId')).toBe('p1');
        return { status: 200, body: { data: files } };
      },
    });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = { status: 201, body: { data: storedFile('f2', 'Invoice é.pdf') } };
    renderAt('/parties/p1');
    expect(await screen.findByRole('button', { name: 'Contract.pdf' })).toBeTruthy();
    const row = screen.getByRole('button', { name: 'Contract.pdf' }).closest('tr')!;
    expect(within(row).getByText('PDF')).toBeTruthy();
    expect(within(row).getByText('2.0 KB')).toBeTruthy();
    expect(within(row).getByText('Aisha')).toBeTruthy();

    files = [...files, storedFile('f2', 'Invoice é.pdf')];
    const file = new File(['%PDF-1.7'], 'Invoice é.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Attach a file'), file);
    expect(await screen.findByRole('button', { name: 'Invoice é.pdf' })).toBeTruthy();
    const sent = FakeXhr.sent[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/api/v1/files?linkType=party&linkId=p1');
    expect(sent.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent('Invoice é.pdf'),
      'x-csrf-token': 'csrf-token-for-s1',
    });
    expect(sent.body).toBe(file);
  });

  it('uploads a dropped file and checks the extension on the client first', async () => {
    let files: unknown[] = [];
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['parties.view', 'parties.update'] })),
      'GET /parties/p1': ok(party),
      'GET /files': () => ({ status: 200, body: { data: files } }),
    });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = { status: 201, body: { data: storedFile('f3', 'dropped.csv') } };
    renderAt('/parties/p1');
    const zone = await screen.findByTestId('file-drop-zone');

    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'script.exe')] } });
    expect(await screen.findByText('This file type is not accepted here.')).toBeTruthy();
    expect(FakeXhr.sent).toHaveLength(0);

    files = [storedFile('f3', 'dropped.csv')];
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['a,b'], 'dropped.csv')] } });
    expect(await screen.findByRole('button', { name: 'dropped.csv' })).toBeTruthy();
    expect(FakeXhr.sent[0]!.headers['x-file-name']).toBe('dropped.csv');
  });

  it('explains rejected types', async () => {
    const user = userEvent.setup();
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['parties.view', 'parties.update'] })),
      'GET /parties/p1': ok(party),
      'GET /files': ok([]),
    });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = {
      status: 415,
      body: { error: { code: 'UNSUPPORTED_FILE_TYPE', message: 'x', requestId: 'r' } },
    };
    renderAt('/parties/p1');
    await user.upload(
      await screen.findByLabelText('Attach a file'),
      new File(['x'], 'a.pdf', { type: 'application/pdf' }),
    );
    expect(
      await screen.findByText(
        'This file type is not accepted here, or the file does not match its extension.',
      ),
    ).toBeTruthy();
  });

  it('is read-only without parties.update', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['parties.view'] })),
      'GET /parties/p1': ok(party),
      'GET /files': ok([storedFile('f1', 'Contract.pdf')]),
    });
    renderAt('/parties/p1');
    expect(await screen.findByRole('button', { name: 'Contract.pdf' })).toBeTruthy();
    expect(screen.queryByLabelText('Attach a file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Contract.pdf' })).toBeNull();
  });

  it('opens files through a signed download URL', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['parties.view'] })),
      'GET /parties/p1': ok(party),
      'GET /files': ok([storedFile('f1', 'Contract.pdf')]),
      'GET /files/f1/download-url': ok({
        url: '/api/v1/files/content?token=t',
        expiresAt: '2026-09-28T10:05:00Z',
      }),
    });
    renderAt('/parties/p1');
    await user.click(await screen.findByRole('button', { name: 'Contract.pdf' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/v1/files/content?token=t'));
  });
});

describe('journal attachments (S5-20)', () => {
  const perms = ['accounting.journals.view', 'accounting.journals.edit_draft'];

  it('removes attachments of a draft after confirmation', async () => {
    const user = userEvent.setup();
    let files = [storedFile('f1', 'Receipt.pdf', 'journal', 'j1')];
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: perms })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(journal('DRAFT')),
      'GET /files': () => ({ status: 200, body: { data: files } }),
      'DELETE /files/f1': () => ((files = []), { status: 204 }),
    });
    renderAt('/accounting/journals/j1');
    await user.click(await screen.findByRole('button', { name: 'Remove Receipt.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Confirm remove Receipt.pdf' }));
    expect(await screen.findByText('No attachments.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/v1/files/f1')).toBe(
      true,
    );
  });

  it('shows view-only users the list without controls or the draft-only note', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['accounting.journals.view'] })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(journal('DRAFT')),
      'GET /files': ok([storedFile('f1', 'Receipt.pdf', 'journal', 'j1')]),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByRole('button', { name: 'Receipt.pdf' })).toBeTruthy();
    expect(screen.queryByLabelText('Attach a file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Receipt.pdf' })).toBeNull();
    expect(
      screen.queryByText('Attachments stay with the journal once it leaves draft.'),
    ).toBeNull();
  });

  it('allows attaching but not removing once posted', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: perms })),
      'GET /accounting/setup': ok(setupState),
      'GET /accounting/accounts': ok([]),
      'GET /accounting/journals/j1': ok(journal('POSTED')),
      'GET /files': ok([storedFile('f1', 'Receipt.pdf', 'journal', 'j1')]),
    });
    renderAt('/accounting/journals/j1');
    expect(await screen.findByRole('button', { name: 'Receipt.pdf' })).toBeTruthy();
    expect(screen.getByLabelText('Attach a file')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove Receipt.pdf' })).toBeNull();
    expect(
      screen.getByText('Attachments stay with the journal once it leaves draft.'),
    ).toBeTruthy();
  });
});

describe('company logo', () => {
  const perms = ['organization.read', 'organization.update'];

  it('asks for a saved profile first', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: perms })),
      'GET /organizations/current/profile': ok({ ...profile, version: 0, legalName: null }),
      'GET /reference/countries': ok([]),
    });
    renderAt('/settings/company-profile');
    expect(await screen.findByText('Save the company profile before adding a logo.')).toBeTruthy();
  });

  it('uploads an image, sets it as the logo, previews it and removes it', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: perms })),
      'GET /organizations/current/profile': ok(profile),
      'GET /reference/countries': ok([]),
      'PUT /organizations/current/profile/logo': (_url, body) => ({
        status: 200,
        body: { data: { logo: { fileId: (body as { fileId: string }).fileId } } },
      }),
      'GET /files/logo1/download-url': ok({
        url: '/api/v1/files/content?token=logo',
        expiresAt: '2026-09-28T10:05:00Z',
      }),
      'DELETE /organizations/current/profile/logo': ok({ logo: null }),
    });
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    FakeXhr.respond = {
      status: 201,
      body: { data: storedFile('logo1', 'logo.png', 'organization_logo', null) },
    };
    renderAt('/settings/company-profile');
    const input = await screen.findByLabelText('Upload logo');
    expect(input.getAttribute('accept')).toBe('.png,.jpg,.jpeg,.webp');
    await user.upload(input, new File(['png'], 'logo.png', { type: 'image/png' }));
    const img = await screen.findByRole('img', { name: 'Company logo' });
    expect(img.getAttribute('src')).toBe('/api/v1/files/content?token=logo');
    expect(FakeXhr.sent[0]!.url).toBe('/api/v1/files?linkType=organization_logo');
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ fileId: 'logo1' });
    // The profile form keeps its version: the logo is outside the profile save.
    expect(screen.getByDisplayValue('Example Ltd')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Remove logo' }));
    expect(await screen.findByText('No logo.')).toBeTruthy();
  });

  it('shows the logo read-only without organization.update', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })),
      'GET /organizations/current/profile': ok({ ...profile, logo: { fileId: 'logo1' } }),
      'GET /reference/countries': ok([]),
      'GET /files/logo1/download-url': ok({ url: '/api/v1/files/content?token=x', expiresAt: 'x' }),
    });
    renderAt('/settings/company-profile');
    const card = (await screen.findByRole('img', { name: 'Company logo' })).closest('section')!;
    expect(within(card).queryByRole('button', { name: 'Remove logo' })).toBeNull();
    expect(within(card).queryByLabelText(/logo/i)).toBeNull();
  });
});

describe('upload client and useJob', () => {
  it('refuses files over 25 MB before sending', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 });
    await expect(uploadFile({ linkType: 'party', linkId: 'p1', file: big })).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('reports progress', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    setCsrfToken('t');
    FakeXhr.respond = { status: 201, body: { data: storedFile('f9', 'a.pdf') } };
    const progress: number[] = [];
    const stored = await uploadFile({
      linkType: 'party',
      linkId: 'p1',
      file: new File(['x'], 'a.pdf'),
      onProgress: (f) => progress.push(f),
    });
    expect(stored.id).toBe('f9');
    expect(progress).toEqual([0.5]);
    setCsrfToken(null);
  });

  it('backs job polling off from 1 s to 5 s', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map((n) => jobPollDelay(n))).toEqual([
      1000, 1500, 2250, 3375, 5000, 5000, 5000,
    ]);
  });

  it('polls a job until it finishes', async () => {
    let polls = 0;
    stubApi({
      'GET /jobs/job1': () => {
        polls += 1;
        return {
          status: 200,
          body: {
            data: {
              id: 'job1',
              status: polls < 3 ? 'running' : 'succeeded',
              progress: polls < 3 ? 50 : 100,
              result: polls < 3 ? null : { purged: 2 },
            },
          },
        };
      },
    });
    const client = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useJob('job1', 10, 20), { wrapper });
    await waitFor(() => expect(result.current.data?.status).toBe('succeeded'));
    const settled = polls;
    await new Promise((r) => setTimeout(r, 50));
    expect(polls).toBe(settled);
    expect(result.current.data?.result).toEqual({ purged: 2 });
  });
});
