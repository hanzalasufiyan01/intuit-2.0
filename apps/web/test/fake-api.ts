import { vi } from 'vitest';
import type { SessionState } from '../src/services/types';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

const ALL_PERMISSIONS = [
  'audit.read',
  'members.invite',
  'members.manage',
  'members.read',
  'organization.read',
  'organization.update',
  'roles.manage',
  'roles.read',
];

export function makeSession(
  overrides: { permissions?: string[]; activeOrgId?: string } = {},
): SessionState {
  const organizations = [
    { id: 'org-a', name: 'Alpha Traders', membershipId: 'm-a' },
    { id: 'org-b', name: 'Beta Resorts', membershipId: 'm-b' },
  ];
  const active = organizations.find((o) => o.id === (overrides.activeOrgId ?? 'org-a'))!;
  return {
    user: {
      id: 'u1',
      email: 'owner@example.test',
      displayName: 'Aisha',
      status: 'active',
      emailVerified: false,
    },
    session: {
      id: 's1',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z',
      idleExpiresAt: '2026-01-01T00:30:00Z',
      reauthenticatedAt: '2026-01-01T00:00:00Z',
      reauthenticationValidUntil: '2026-01-01T00:15:00Z',
    },
    organizations,
    activeOrganization: {
      ...active,
      isOwner: true,
      permissions: overrides.permissions ?? ALL_PERMISSIONS,
    },
    csrfToken: 'csrf-token-for-s1',
  };
}

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });

/**
 * In-memory stand-in for the API used by frontend tests (UI behavior only; the real API is
 * covered by integration tests against PostgreSQL).
 */
export function installFakeApi(initial: { session: SessionState | null; password?: string }) {
  const state = {
    session: initial.session,
    password: initial.password ?? 'correct horse battery staple',
  };
  const requests: RecordedRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>),
    );
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, headers, body });
    const path = url.replace(/^\/api\/v1/, '');

    const unauthorized = () =>
      json(401, {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication is required.',
          requestId: 'req-test',
        },
      });

    if (method === 'GET' && path === '/auth/session') {
      return state.session ? json(200, { data: state.session }) : unauthorized();
    }
    if (method === 'POST' && path === '/auth/login') {
      const { password } = body as { email: string; password: string };
      if (password !== state.password) {
        return json(401, {
          error: {
            code: 'INVALID_CREDENTIALS',
            message: 'The email or password is incorrect.',
            requestId: 'req-test',
          },
        });
      }
      state.session = makeSession();
      return json(200, { data: state.session });
    }
    if (!state.session) return unauthorized();
    if (method === 'POST' && path === '/auth/logout') {
      state.session = null;
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && path === '/auth/session/organization') {
      const { organizationId } = body as { organizationId: string };
      state.session = makeSession({ activeOrgId: organizationId });
      return json(200, { data: state.session });
    }
    if (method === 'GET' && path === '/organizations/current/members') {
      const org = state.session.activeOrganization!;
      return json(200, {
        data: [
          {
            membershipId: org.membershipId,
            userId: 'u1',
            email: `owner@${org.id}.test`,
            displayName: `Owner of ${org.name}`,
            status: 'active',
            isOwner: true,
            roles: [{ id: 'r1', name: 'Owner', isOwner: true }],
            joinedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    }
    if (method === 'GET' && path === '/organizations/current/roles') {
      return json(200, {
        data: [
          {
            id: 'r2',
            name: 'Member',
            isOwner: false,
            isSystem: true,
            permissionKeys: [],
            description: '',
            templateKey: 'member',
          },
        ],
      });
    }
    if (method === 'GET' && path === '/organizations/current/invitations') {
      return json(200, { data: [] });
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'req-test' } });
  });

  vi.stubGlobal('fetch', fetchMock);
  return { state, requests };
}
