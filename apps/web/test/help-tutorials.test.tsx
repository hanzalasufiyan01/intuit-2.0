import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, matchRoutes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { App, createQueryClient } from '../src/app/App';
import { routes } from '../src/app/routes';
import {
  availability,
  contextualTutorial,
  TUTORIALS,
  tutorialById,
  tutorialKey,
} from '../src/features/help/tutorials';
import { en } from '../src/i18n/messages.en';
import { Permission } from '../src/permissions/permissions';
import { progressRow, stubHelpApi, type HelpStubOptions } from './help-stub';

/**
 * Tutorial Centre: the catalogue (ten tutorials, text for every step, real routes), availability by
 * permission and module, and the player (navigation, progress saved per member, resume, repeat,
 * skip, exit, unavailable and failure states).
 */

const ALL = Object.values(Permission);
const EXPECTED_IDS = [
  'welcome',
  'dashboard',
  'business-settings',
  'customers-suppliers',
  'invoices',
  'expenses-payments',
  'reports',
  'banking',
  'inventory-appointments',
  'roles-security',
];

async function open(path: string, options: HelpStubOptions = {}) {
  const state = stubHelpApi({ permissions: ALL, ...options });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<App router={router} queryClient={createQueryClient()} />);
  return { state, router, user: userEvent.setup() };
}

const saves = (state: ReturnType<typeof stubHelpApi>) =>
  state.requests.filter((r) => r.method === 'PUT').map((r) => r.body);

describe('the catalogue', () => {
  it('has the ten tutorials, in order', () => {
    expect(TUTORIALS.map((t) => t.id)).toEqual(EXPECTED_IDS);
  });

  it('has text for every tutorial, prerequisite and step, and no orphan text', () => {
    const catalog = en as Record<string, string>;
    const used = new Set<string>();
    for (const tutorial of TUTORIALS) {
      const keys = [
        tutorialKey(tutorial.id, 'title'),
        tutorialKey(tutorial.id, 'summary'),
        tutorialKey(tutorial.id, 'objective'),
        ...Array.from({ length: tutorial.prerequisites }, (_, i) =>
          tutorialKey(tutorial.id, `prereq${i + 1}`),
        ),
        ...tutorial.steps.flatMap((_, i) => [
          tutorialKey(tutorial.id, `s${i + 1}.title`),
          tutorialKey(tutorial.id, `s${i + 1}.body`),
        ]),
      ];
      for (const key of keys) {
        expect(catalog[key], key).toBeTruthy();
        used.add(key);
      }
      expect(tutorial.steps.length, tutorial.id).toBeGreaterThanOrEqual(3);
    }
    const orphans = Object.keys(catalog).filter((k) => k.startsWith('help.t.') && !used.has(k));
    expect(orphans).toEqual([]);
  });

  it('points every step at a route that exists', () => {
    for (const tutorial of TUTORIALS) {
      for (const step of tutorial.steps) {
        if (step.route) expect(matchRoutes(routes, step.route), step.route).not.toBeNull();
      }
    }
  });

  it('finds the tutorial that helps with a page', () => {
    expect(contextualTutorial('/sales/invoices')?.id).toBe('invoices');
    expect(contextualTutorial('/sales/invoices/123')?.id).toBe('invoices');
    expect(contextualTutorial('/purchases/bills')?.id).toBe('expenses-payments');
    expect(contextualTutorial('/accounting/reports/trial-balance')?.id).toBe('reports');
    expect(contextualTutorial('/accounting/setup')?.id).toBe('business-settings');
    expect(contextualTutorial('/exports')).toBeNull();
  });
});

describe('availability', () => {
  const none = { permissions: [], modules: null };

  it('keeps the general tutorials for everyone and hides what a member cannot use', () => {
    expect(availability(tutorialById('welcome')!, none).available).toBe(true);
    expect(availability(tutorialById('invoices')!, none).available).toBe(false);
    expect(availability(tutorialById('banking')!, none).available).toBe(false);
    const welcome = availability(tutorialById('welcome')!, none);
    // Without accounting.setup the "Set up accounting first" step is left out.
    expect(welcome.available && welcome.steps.map((s) => s.number)).toEqual([1, 2, 3, 5]);
  });

  it('shows the clinic steps only with the module on and a clinic permission', () => {
    const tutorial = tutorialById('inventory-appointments')!;
    const base = { permissions: [Permission.InventoryView], modules: null };
    const inventoryOnly = availability(tutorial, base);
    expect(inventoryOnly.available && inventoryOnly.steps.map((s) => s.number)).toEqual([1, 2, 3]);
    const withClinic = availability(tutorial, {
      permissions: [Permission.InventoryView, Permission.ClinicPatientsView],
      modules: { payroll: false, projects: false, clinic: true },
    });
    expect(withClinic.available && withClinic.steps.map((s) => s.number)).toEqual([1, 2, 3, 5, 6]);
  });
});

describe('Help centre', () => {
  it('lists the tutorials with the member progress', async () => {
    await open('/help', {
      progress: [progressRow('welcome', 'completed', 5), progressRow('invoices', 'in_progress', 2)],
    });
    expect(await screen.findByRole('heading', { name: 'Help centre', level: 1 })).toBeTruthy();
    expect(await screen.findByText('1 of 10 tutorials completed')).toBeTruthy();
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByText(/In progress, step 3 of/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Resume the tutorial: Creating and managing invoices' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Repeat the tutorial: Welcome and first sign-in' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Start the tutorial: Dashboard overview' }),
    ).toBeTruthy();
  });

  it('marks tutorials the member cannot use as unavailable instead of offering them', async () => {
    await open('/help', { permissions: [] });
    await screen.findByText('0 of 10 tutorials completed');
    expect(screen.getAllByText('Not available to you').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByRole('link', { name: /Start the tutorial: Banking/ })).toBeNull();
    expect(screen.getByRole('link', { name: /Start the tutorial: Welcome/ })).toBeTruthy();
  });

  it('still lists the tutorials when progress cannot be loaded', async () => {
    await open('/help', { progressFails: true });
    expect(await screen.findByText('Your tutorial progress could not be loaded.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Start the tutorial: Welcome/ })).toBeTruthy();
  });
});

describe('tutorial player', () => {
  it('walks the steps with Next and Back, saving progress each time', async () => {
    const { state, user } = await open('/help/tutorials/dashboard');
    expect(await screen.findByRole('heading', { name: 'What Overview shows' })).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
    // The first step shows the objective and prerequisites.
    expect(screen.getByText('Objective')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('heading', { name: 'Switch organization' })).toBeTruthy();
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
    expect(screen.queryByText('Objective')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'What Overview shows' })).toBeTruthy();

    await waitFor(() =>
      expect(saves(state)).toEqual([
        { status: 'in_progress', step: 1 },
        { status: 'in_progress', step: 0 },
      ]),
    );
  });

  it('moves focus to the step heading when the step changes', async () => {
    const { user } = await open('/help/tutorials/dashboard');
    await screen.findByRole('heading', { name: 'What Overview shows' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const heading = await screen.findByRole('heading', { name: 'Switch organization' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  it('shows a page link on steps that have one, with the member allowed to open it', async () => {
    await open('/help/tutorials/dashboard');
    await screen.findByRole('heading', { name: 'What Overview shows' });
    expect(screen.getByRole('link', { name: 'Open this page' }).getAttribute('href')).toBe('/');
  });

  it('finishes with completion feedback, then repeats from the start', async () => {
    const { state, user } = await open('/help/tutorials/dashboard');
    await screen.findByRole('heading', { name: 'What Overview shows' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Finish' }));

    expect(await screen.findByText('Tutorial complete')).toBeTruthy();
    expect(screen.getByText(/You finished/)).toBeTruthy();
    expect(saves(state).at(-1)).toEqual({ status: 'completed', step: 3 });

    await user.click(screen.getByRole('button', { name: 'Repeat the tutorial' }));
    expect(await screen.findByText('Step 1 of 3')).toBeTruthy();
    await waitFor(() => expect(saves(state).at(-1)).toEqual({ status: 'in_progress', step: 0 }));
  });

  it('opens a completed tutorial on its summary and a started one on the saved step', async () => {
    await open('/help/tutorials/dashboard', {
      progress: [progressRow('dashboard', 'completed', 3)],
    });
    expect(await screen.findByText('Tutorial complete')).toBeTruthy();
  });

  it('resumes where the member left off', async () => {
    await open('/help/tutorials/dashboard', {
      progress: [progressRow('dashboard', 'in_progress', 2)],
    });
    expect(await screen.findByRole('heading', { name: 'Find your numbers' })).toBeTruthy();
    expect(screen.getByText('Step 3 of 3')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Finish' })).toBeTruthy();
  });

  it('keeps a saved step in range when fewer steps apply than before', async () => {
    await open('/help/tutorials/dashboard', {
      permissions: [],
      progress: [progressRow('dashboard', 'in_progress', 9)],
    });
    // Without the reports permission the last step is left out, so the view shows step 2 of 2.
    expect(await screen.findByText('Step 2 of 2')).toBeTruthy();
    expect(screen.getByText('Some steps are left out', { exact: false })).toBeTruthy();
  });

  it('skips the tutorial and offers to start again', async () => {
    const { state, user } = await open('/help/tutorials/dashboard');
    await screen.findByRole('heading', { name: 'What Overview shows' });
    await user.click(screen.getByRole('button', { name: 'Skip tutorial' }));
    expect(await screen.findByText('Tutorial skipped')).toBeTruthy();
    expect(saves(state).at(-1)).toEqual({ status: 'skipped', step: 0 });
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy();
  });

  it('exits to the Help centre, keeping the saved place', async () => {
    const { router, user } = await open('/help/tutorials/dashboard');
    await screen.findByRole('heading', { name: 'What Overview shows' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Switch organization' });
    await user.click(screen.getByRole('button', { name: 'Exit' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/help'));
    expect(await screen.findByText(/In progress, step 2 of 3/)).toBeTruthy();
  });

  it('says so, and keeps going, when progress cannot be saved', async () => {
    const { user } = await open('/help/tutorials/dashboard', { progressFails: true });
    await screen.findByRole('heading', { name: 'What Overview shows' });
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText(/progress could not be saved/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Switch organization' })).toBeTruthy();
  });

  it('does not run a tutorial the member cannot use, and explains why', async () => {
    await open('/help/tutorials/banking', { permissions: [] });
    expect(await screen.findByText(/cover[s]? features your role cannot use/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  it('handles an unknown tutorial', async () => {
    await open('/help/tutorials/nothing-here');
    expect(await screen.findByText('There is no tutorial with that name.')).toBeTruthy();
  });
});

describe('welcome prompt and contextual help', () => {
  it('offers the welcome tutorial on Overview until the member acts on it', async () => {
    const { state, user } = await open('/');
    const prompt = await screen.findByRole('region', { name: 'New to Intuit 2.0?' });
    expect(within(prompt).getByRole('link', { name: 'Start the welcome tutorial' })).toBeTruthy();
    await user.click(within(prompt).getByRole('button', { name: 'Not now' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'New to Intuit 2.0?' })).toBeNull(),
    );
    expect(saves(state)).toEqual([{ status: 'skipped', step: 0 }]);
  });

  it('does not offer it again once the member has any progress', async () => {
    const { state } = await open('/', { progress: [progressRow('welcome', 'completed', 5)] });
    await screen.findByText('You are the Owner of this organization.');
    await waitFor(() =>
      expect(state.requests.some((r) => r.path === '/tutorials/progress')).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'New to Intuit 2.0?' })).toBeNull();
  });

  it('links to the tutorial for the current page from the top bar', async () => {
    await open('/sales/invoices');
    const link = await screen.findByRole('link', {
      name: 'Open the tutorial: Creating and managing invoices',
    });
    expect(link.getAttribute('href')).toBe('/help/tutorials/invoices');
  });

  it('shows no contextual link on a page no tutorial covers', async () => {
    await open('/exports');
    await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.queryByRole('link', { name: 'Help for this page' })).toBeNull();
  });
});
