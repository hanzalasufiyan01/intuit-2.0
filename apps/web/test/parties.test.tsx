import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import { makeSession } from './fake-api';

/** S4 UI: company profile and Party management, permission-aware. */

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

const ok = (data: unknown) => () => ({ status: 200, body: { data } });
const countries = [
  { code: 'MV', name: 'Maldives', isActive: true },
  { code: 'IN', name: 'India', isActive: true },
];
const emptyProfile = {
  version: 0,
  legalName: null,
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
  updatedAt: null,
};
const party = {
  id: 'p1',
  kind: 'organization',
  displayName: 'Blue Lagoon Traders',
  companyName: null,
  firstName: null,
  lastName: null,
  reference: 'C-001',
  tin: null,
  email: 'ap@blue.test',
  phone: null,
  website: null,
  notes: null,
  status: 'ACTIVE',
  roles: ['customer'],
  version: 3,
  contacts: [
    {
      id: 'c1',
      firstName: 'Aisha',
      lastName: null,
      jobTitle: null,
      email: null,
      phone: null,
      mobile: null,
      isPrimary: true,
      receivesDocuments: false,
    },
    {
      id: 'c2',
      firstName: 'Ibrahim',
      lastName: null,
      jobTitle: null,
      email: null,
      phone: null,
      mobile: null,
      isPrimary: false,
      receivesDocuments: false,
    },
  ],
  addresses: [],
  createdAt: '2026-09-28T00:00:00Z',
  updatedAt: '2026-09-28T00:00:00Z',
  archivedAt: null,
};

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return router;
}

describe('company profile', () => {
  it('is read-only without organization.update and hidden from navigation without organization.read', async () => {
    stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read'] })),
      'GET /organizations/current/profile': ok({
        ...emptyProfile,
        version: 2,
        legalName: 'Example Ltd',
      }),
      'GET /reference/countries': ok(countries),
    });
    renderAt('/settings/company-profile');
    expect(await screen.findByDisplayValue('Example Ltd')).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Save profile' })).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByText('Company profile'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).queryByText('Contacts'),
    ).toBeNull();
  });

  it('saves with the version and nulls for blanks, and explains a version conflict', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'organization.update'] }),
      ),
      'GET /organizations/current/profile': ok(emptyProfile),
      'GET /reference/countries': ok(countries),
      'PUT /organizations/current/profile': () => ({
        status: 409,
        body: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'The company profile was changed by someone else.',
            requestId: 'r',
          },
        },
      }),
    });
    renderAt('/settings/company-profile');
    await user.type(await screen.findByLabelText('Legal name'), 'Example Resorts Pvt Ltd');
    await user.type(screen.getByLabelText('TIN'), '1001234');
    await user.click(screen.getByLabelText('GST registered'));
    await user.type(screen.getByLabelText('GST registration number'), '1001234GST501');
    await user.type(screen.getByLabelText('Registered address line 1'), 'Orchid Magu');
    await user.selectOptions(screen.getByLabelText('Registered address country'), 'MV');
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(
      await screen.findByText('The company profile was changed by someone else.'),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      version: 0,
      legalName: 'Example Resorts Pvt Ltd',
      tradingName: null,
      tin: '1001234',
      gstRegistered: true,
      gstRegistrationNumber: '1001234GST501',
      registeredAddress: { line1: 'Orchid Magu', city: null, countryCode: 'MV' },
      businessAddress: null,
      identifiers: [],
    });
  });
});

describe('parties', () => {
  it('lists, searches and pages through contacts', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(makeSession({ permissions: ['organization.read', 'parties.view'] })),
      'GET /parties': (url) =>
        ok(
          url.searchParams.get('after')
            ? { items: [{ ...party, id: 'p2', displayName: 'Coral Bay' }], nextCursor: null }
            : { items: [party], nextCursor: 'cursor-1' },
        )(),
    });
    renderAt('/parties');
    expect(await screen.findByRole('link', { name: 'Blue Lagoon Traders' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New contact' })).toBeNull(); // no parties.create
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Coral Bay' })).toBeTruthy();
    expect(
      calls
        .filter((c) => c.url.pathname.endsWith('/parties'))
        .at(-1)!
        .url.searchParams.get('after'),
    ).toBe('cursor-1');
    await user.type(screen.getByLabelText('Search'), 'lagoon');
    await user.selectOptions(screen.getByLabelText('Role'), 'customer');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.searchParams.get('search') === 'lagoon' &&
            c.url.searchParams.get('role') === 'customer',
        ),
      ).toBe(true),
    );
  });

  it('creates a contact and shows possible duplicates on its page', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'parties.view', 'parties.create'] }),
      ),
      'GET /reference/countries': ok(countries),
      'POST /parties': () => ({
        status: 201,
        body: {
          data: {
            ...party,
            warnings: [
              {
                code: 'POSSIBLE_DUPLICATE',
                message: 'Other active parties have the same name, TIN or email.',
                matches: [{ partyId: 'p9', matchedOn: ['name'] }],
              },
            ],
          },
        },
      }),
      'GET /parties/p1': ok(party),
    });
    renderAt('/parties/new');
    await user.type(await screen.findByLabelText('Display name'), 'Blue Lagoon Traders');
    await user.click(screen.getByLabelText('Customer'));
    await user.click(screen.getByRole('button', { name: 'Create contact' }));
    expect(await screen.findByText(/Possible duplicate/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'view match' }).getAttribute('href')).toBe(
      '/parties/p9',
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      kind: 'organization',
      displayName: 'Blue Lagoon Traders',
      reference: null,
      roles: ['customer'],
    });
  });

  it('switches the primary contact and hides archive without parties.archive', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({ permissions: ['organization.read', 'parties.view', 'parties.update'] }),
      ),
      'GET /reference/countries': ok(countries),
      'GET /parties/p1': ok(party),
      'PATCH /parties/p1/contacts/c2': ok({
        ...party,
        contacts: party.contacts.map((c) => ({ ...c, isPrimary: c.id === 'c2' })),
      }),
    });
    renderAt('/parties/p1');
    await user.click(await screen.findByRole('button', { name: 'Make primary' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ isPrimary: true });
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('sends the party version on edit and explains a conflict', async () => {
    const user = userEvent.setup();
    const calls = stubApi({
      'GET /auth/session': ok(
        makeSession({
          permissions: ['organization.read', 'parties.view', 'parties.update', 'parties.archive'],
        }),
      ),
      'GET /reference/countries': ok(countries),
      'GET /parties/p1': ok(party),
      'PATCH /parties/p1': () => ({
        status: 409,
        body: {
          error: {
            code: 'VERSION_CONFLICT',
            message: 'This party was changed by someone else.',
            requestId: 'r',
          },
        },
      }),
    });
    renderAt('/parties/p1');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.clear(screen.getByLabelText('Display name'));
    await user.type(screen.getByLabelText('Display name'), 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/changed by someone else/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({
      version: 3,
      displayName: 'Renamed',
    });
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });
});
