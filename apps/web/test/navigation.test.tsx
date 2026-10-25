import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, matchRoutes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { NAV_DEFAULT_EXPANDED } from '../src/app/navigation';
import { routes } from '../src/app/routes';
import { CLINIC_PERMISSIONS } from '../src/features/clinic/ClinicPages';
import { Permission } from '../src/permissions/permissions';
import { makeSession } from './fake-api';

/**
 * Grouped, collapsible navigation and the responsive drawer (UI phase 2). The links, their
 * destinations and their visibility rules are the ones the flat sidebar had; only the grouping,
 * the disclosure behaviour and the drawer are new.
 */

const ALL_PERMISSIONS = Object.values(Permission);
type Modules = { payroll: boolean; projects: boolean; clinic: boolean };
const NO_MODULES: Modules = { payroll: false, projects: false, clinic: false };
const ALL_MODULES: Modules = { payroll: true, projects: true, clinic: true };

/** The flat sidebar's destinations, from before the grouping: every one must remain, once. */
const ORIGINAL_DESTINATIONS = [
  '/',
  '/members',
  '/settings/branch-access',
  '/roles',
  '/audit',
  '/settings/company-profile',
  '/settings/ownership',
  '/settings/groups',
  '/settings/modules',
  '/settings/integrations',
  '/settings/webhooks',
  '/parties',
  '/accounting',
  '/sales',
  '/purchases',
  '/banking',
  '/inventory',
  '/payroll',
  '/projects',
  '/clinic',
  '/assets',
  '/claims',
  '/imports',
  '/exports',
  '/settings/approvals',
  '/settings/security',
];

const GROUPS: Record<string, { links: string[]; hrefs: string[] }> = {
  Finance: {
    links: ['Accounting', 'Banking', 'Fixed assets', 'Expense claims'],
    hrefs: ['/accounting', '/banking', '/assets', '/claims'],
  },
  Commerce: {
    links: ['Sales', 'Purchases', 'Inventory', 'Contacts'],
    hrefs: ['/sales', '/purchases', '/inventory', '/parties'],
  },
  'People & projects': {
    links: ['Payroll', 'Projects', 'Clinic'],
    hrefs: ['/payroll', '/projects', '/clinic'],
  },
  Data: { links: ['Import', 'Exports'], hrefs: ['/imports', '/exports'] },
  Organization: {
    links: [
      'Members',
      'Branch access',
      'Roles',
      'Company profile',
      'Ownership',
      'Entity groups',
      'Modules',
      'Approval policies',
    ],
    hrefs: [
      '/members',
      '/settings/branch-access',
      '/roles',
      '/settings/company-profile',
      '/settings/ownership',
      '/settings/groups',
      '/settings/modules',
      '/settings/approvals',
    ],
  },
  Integrations: {
    links: ['API integrations', 'Webhooks'],
    hrefs: ['/settings/integrations', '/settings/webhooks'],
  },
  'Security & audit': {
    links: ['Audit log', 'Security'],
    hrefs: ['/audit', '/settings/security'],
  },
};

function stubApi(permissions: string[], modules: Modules = NO_MODULES) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const state = { modulesServed: false };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      const key = `${init.method ?? 'GET'} ${path}`;
      if (key === 'GET /auth/session') return json(200, { data: makeSession({ permissions }) });
      if (key === 'GET /organizations/current/modules') {
        state.modulesServed = true;
        return json(200, { data: { modules } });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found', requestId: 'r' } });
    }),
  );
  return state;
}

/** Makes window.matchMedia answer for the compact (drawer) layout, and lets a test resize. */
function mockViewport(initialCompact: boolean) {
  let compact = initialCompact;
  const listeners = new Set<() => void>();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return compact;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }),
  });
  return {
    resize(next: boolean) {
      compact = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

async function renderShell(
  permissions: string[],
  options: { path?: string; modules?: Modules } = {},
) {
  const state = stubApi(permissions, options.modules);
  const router = createMemoryRouter(routes, { initialEntries: [options.path ?? '/'] });
  render(<App router={router} queryClient={createQueryClient()} />);
  const nav = await screen.findByRole('navigation', { name: 'Main' });
  // Module-dependent links appear once the organization's modules have loaded.
  if (permissions.includes('organization.read')) {
    await waitFor(() => expect(state.modulesServed).toBe(true));
    await act(async () => {});
  }
  return { router, nav };
}

const group = (name: string) => screen.getByRole('button', { name });
const queryGroup = (name: string) => screen.queryByRole('button', { name });
const expanded = (name: string) => group(name).getAttribute('aria-expanded') === 'true';

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.documentElement.removeAttribute('data-theme');
  document.body.removeAttribute('data-nav-open');
});

describe('grouping and route coverage', () => {
  it('shows every original link exactly once, each in its own group', async () => {
    const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });

    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toHaveLength(ORIGINAL_DESTINATIONS.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual([...ORIGINAL_DESTINATIONS].sort());

    for (const [name, expectedGroup] of Object.entries(GROUPS)) {
      const panel = document.getElementById(group(name).getAttribute('aria-controls')!)!;
      const links = [...panel.querySelectorAll('a')];
      expect(
        links.map((a) => a.textContent),
        name,
      ).toEqual(expectedGroup.links);
      expect(
        links.map((a) => a.getAttribute('href')),
        name,
      ).toEqual(expectedGroup.hrefs);
    }
    // Overview stands alone, above the groups.
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('href')).toBe('/');
  });

  it('points every destination at a route that exists', () => {
    for (const to of ORIGINAL_DESTINATIONS) {
      expect(matchRoutes(routes, to), to).not.toBeNull();
    }
  });

  it('keeps the account-security link in the top bar, not in the sidebar', async () => {
    const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    expect(within(nav).queryByRole('link', { name: 'Account security' })).toBeNull();
    const banner = screen.getByRole('link', { name: 'Account security' });
    expect(banner.closest('header.topbar')).not.toBeNull();
  });
});

describe('permission and module gating', () => {
  it('shows only what a member with limited permissions could see before, and no empty group', async () => {
    const { nav } = await renderShell(['organization.read', 'members.read']);
    const links = [...nav.querySelectorAll('a')].map((a) => a.textContent);
    expect(links).toEqual([
      'Overview',
      'Exports',
      'Members',
      'Branch access',
      'Company profile',
      'Ownership',
      'Entity groups',
      'Modules',
    ]);
    expect(queryGroup('Data')).not.toBeNull();
    expect(queryGroup('Organization')).not.toBeNull();
    for (const hidden of [
      'Finance',
      'Commerce',
      'People & projects',
      'Integrations',
      'Security & audit',
    ]) {
      expect(queryGroup(hidden), hidden).toBeNull();
    }
  });

  it('leaves a group out when none of its links is allowed', async () => {
    const { nav } = await renderShell(['audit.read']);
    expect(queryGroup('Security & audit')).not.toBeNull();
    expect(within(nav).getByRole('link', { name: 'Audit log' })).toBeTruthy();
    expect(queryGroup('Organization')).toBeNull();
    expect(within(nav).queryByText('Roles')).toBeNull();
  });

  it('shows Payroll and Projects by module alone, and Clinic only with its module and a permission', async () => {
    const { nav } = await renderShell(['organization.read'], { modules: ALL_MODULES });
    expect(within(nav).getByText('Payroll')).toBeTruthy();
    expect(within(nav).getByText('Projects')).toBeTruthy();
    expect(within(nav).queryByText('Clinic')).toBeNull();
  });

  it('shows Clinic when both its module and a clinic permission are present', async () => {
    const { nav } = await renderShell(['organization.read', CLINIC_PERMISSIONS[0]], {
      modules: { ...NO_MODULES, clinic: true },
    });
    expect(within(nav).getByRole('link', { name: 'Clinic' })).toBeTruthy();
    expect(within(nav).queryByText('Payroll')).toBeNull();
  });

  it('hides Clinic when the permission is present but the module is off, and drops the empty group', async () => {
    const { nav } = await renderShell(['organization.read', CLINIC_PERMISSIONS[0]]);
    expect(within(nav).queryByText('Clinic')).toBeNull();
    expect(queryGroup('People & projects')).toBeNull();
  });

  it('shows only Overview and Exports to a user with no permissions', async () => {
    const { nav } = await renderShell([]);
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Overview',
      'Exports',
    ]);
  });
});

describe('active route and active group', () => {
  it('starts with the expected groups open and marks the current page', async () => {
    const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    for (const [id, label] of [
      ['finance', 'Finance'],
      ['commerce', 'Commerce'],
      ['people', 'People & projects'],
      ['organization', 'Organization'],
      ['security', 'Security & audit'],
      ['data', 'Data'],
      ['integrations', 'Integrations'],
    ] as const) {
      expect(expanded(label), label).toBe(NAV_DEFAULT_EXPANDED[id]);
    }
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // A collapsed group's links are out of reach until it is opened.
    expect(within(nav).queryByRole('link', { name: 'Exports' })).toBeNull();
  });

  it('opens the group of the page it starts on', async () => {
    const { nav } = await renderShell(ALL_PERMISSIONS, {
      path: '/exports',
      modules: ALL_MODULES,
    });
    expect(expanded('Data')).toBe(true);
    const link = within(nav).getByRole('link', { name: 'Exports' });
    expect(link.getAttribute('aria-current')).toBe('page');
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      null,
    );
  });

  it('keeps nested pages active, such as an import batch inside Import', async () => {
    const { nav } = await renderShell(ALL_PERMISSIONS, {
      path: '/imports/some-batch',
      modules: ALL_MODULES,
    });
    expect(expanded('Data')).toBe(true);
    expect(within(nav).getByRole('link', { name: 'Import' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('opens the group of the page it navigates to, and lets the user collapse it afterwards', async () => {
    const user = userEvent.setup();
    const { router } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    expect(expanded('Data')).toBe(false);

    await act(async () => {
      await router.navigate('/exports');
    });
    expect(expanded('Data')).toBe(true);

    await user.click(group('Data'));
    expect(expanded('Data')).toBe(false); // the user's choice stands until the next navigation
    await act(async () => {
      await router.navigate('/imports');
    });
    expect(expanded('Data')).toBe(true);
  });

  it('follows a click on a link', async () => {
    const user = userEvent.setup();
    const { router, nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(within(nav).getByRole('link', { name: 'Roles' }));
    expect(router.state.location.pathname).toBe('/roles');
    expect(within(nav).getByRole('link', { name: 'Roles' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
      null,
    );
  });
});

describe('group expand and collapse (accessibility)', () => {
  it('uses buttons with aria-expanded that control the list they show', async () => {
    const user = userEvent.setup();
    const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    const button = group('Organization');
    const panelId = button.getAttribute('aria-controls')!;
    const panel = document.getElementById(panelId)!;
    expect(panel).not.toBeNull();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hasAttribute('hidden')).toBe(false);
    expect(within(nav).getByRole('link', { name: 'Members' })).toBeTruthy();

    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hasAttribute('hidden')).toBe(true);
    expect(within(nav).queryByRole('link', { name: 'Members' })).toBeNull();

    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(within(nav).getByRole('link', { name: 'Members' })).toBeTruthy();
  });

  it('can be operated from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    const button = group('Data');
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard('{Enter}');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard(' ');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the group buttons and links in the tab order, and hides decorative icons', async () => {
    const user = userEvent.setup();
    const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    within(nav).getByRole('link', { name: 'Overview' }).focus();
    await user.tab();
    expect(document.activeElement).toBe(group('Finance'));
    await user.tab();
    expect(document.activeElement).toBe(within(nav).getByRole('link', { name: 'Accounting' }));
    for (const icon of nav.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('collapses a group without losing the others', async () => {
    const user = userEvent.setup();
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(group('Finance'));
    expect(expanded('Finance')).toBe(false);
    expect(expanded('Commerce')).toBe(true);
    expect(expanded('Organization')).toBe(true);
  });
});

describe('navigation drawer (tablet and mobile)', () => {
  const dialog = () => screen.queryByRole('dialog', { name: 'Navigation menu' });
  const menuButton = () => screen.getByRole('button', { name: 'Open navigation menu' });
  const main = () => document.querySelector('.main')!;

  it('is closed until the menu button is used, and the page is not locked', async () => {
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
    expect(menuButton().getAttribute('aria-controls')).toBe('app-sidebar');
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-nav-open')).toBe(false);
    expect(document.querySelector('.nav-backdrop')).toBeNull();
  });

  it('opens as a modal dialog, blocks the page behind it and moves focus into it', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(menuButton());

    const drawer = dialog()!;
    expect(drawer).not.toBeNull();
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.id).toBe('app-sidebar');
    expect(drawer.classList.contains('sidebar--open')).toBe(true);
    expect(menuButton().getAttribute('aria-expanded')).toBe('true');
    expect(main().hasAttribute('inert')).toBe(true);
    expect(document.body.hasAttribute('data-nav-open')).toBe(true);
    expect(document.querySelector('.nav-backdrop')).not.toBeNull();
    expect(document.activeElement).toBe(
      within(drawer).getByRole('button', { name: 'Close navigation menu' }),
    );
    // The navigation, organization selector and sign-out remain reachable.
    expect(within(drawer).getByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(within(drawer).getByLabelText('Organization').id).toBe('organization-switcher');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('keeps focus inside the drawer when tabbing from its close button', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(menuButton());
    await user.tab();
    expect((document.activeElement as HTMLElement).id).toBe('organization-switcher');
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Overview' }));
    await user.tab();
    expect(document.activeElement).toBe(group('Finance'));
  });

  it('closes on Escape and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(menuButton());
    await user.keyboard('{Escape}');

    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-nav-open')).toBe(false);
    expect(document.activeElement).toBe(menuButton());
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes with its close button and with a click on the backdrop', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });

    await user.click(menuButton());
    await user.click(screen.getByRole('button', { name: 'Close navigation menu' }));
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(menuButton());

    await user.click(menuButton());
    await user.click(document.querySelector('.nav-backdrop')!);
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
  });

  it('closes after navigating, for a new page and for the current one', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    const { router } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });

    await user.click(menuButton());
    await user.click(within(dialog()!).getByRole('link', { name: 'Members' }));
    expect(router.state.location.pathname).toBe('/members');
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);

    await user.click(menuButton());
    await user.click(within(dialog()!).getByRole('link', { name: 'Members' }));
    expect(router.state.location.pathname).toBe('/members');
    expect(dialog()).toBeNull();
  });

  it('closes when the viewport grows to the desktop layout, and does not reopen on its own', async () => {
    const user = userEvent.setup();
    const viewport = mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(menuButton());
    expect(dialog()).not.toBeNull();

    viewport.resize(false);
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-nav-open')).toBe(false);

    viewport.resize(true);
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
  });

  it('does nothing on the desktop layout, where the sidebar is always shown', async () => {
    const user = userEvent.setup();
    mockViewport(false);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.click(menuButton());
    expect(dialog()).toBeNull();
    expect(main().hasAttribute('inert')).toBe(false);
    expect(document.body.hasAttribute('data-nav-open')).toBe(false);
  });

  it('leaves the other Escape uses alone while the drawer is closed', async () => {
    const user = userEvent.setup();
    mockViewport(true);
    await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });
    await user.keyboard('{Escape}');
    expect(dialog()).toBeNull();
    expect(menuButton().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('light and dark themes', () => {
  it.each(['light', 'dark', null])(
    'groups, collapses and opens the drawer the same way with theme %s',
    async (theme) => {
      if (theme) document.documentElement.setAttribute('data-theme', theme);
      const user = userEvent.setup();
      mockViewport(true);
      const { nav } = await renderShell(ALL_PERMISSIONS, { modules: ALL_MODULES });

      expect(within(nav).getByRole('link', { name: 'Members' })).toBeTruthy();
      await user.click(group('Organization'));
      expect(expanded('Organization')).toBe(false);

      await user.click(screen.getByRole('button', { name: 'Open navigation menu' }));
      expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toBeTruthy();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      // The theme control still sits in the top bar next to the navigation controls.
      expect(screen.getByRole('group', { name: 'Theme' }).closest('header.topbar')).not.toBeNull();
    },
  );
});
