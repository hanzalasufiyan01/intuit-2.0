import { expect, test } from '@playwright/test';
import { PASSWORD, register } from './helpers';
import { totp, untilNextStep } from './totp';

/**
 * Browser smoke tests (FP-20): registration with the mandatory owner two-step verification
 * enrolment, navigation by permission, sign-out and sign-in (password then authenticator code),
 * a rejected sign-in, and the pages added in the completion work that need no accounting setup.
 * Each test registers its own user, so the tests do not depend on each other or on seed data.
 */

test('registers an owner, enrols two-step verification, and shows the owner navigation', async ({
  page,
}) => {
  await register(page, 'Atoll Trading Pvt Ltd');
  await expect(page.locator('header').getByText('Atoll Trading Pvt Ltd').first()).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Overview', 'Members', 'Roles', 'Audit log', 'Branch access']) {
    await expect(nav.getByRole('link', { name })).toBeVisible();
  }
});

test('lists the system roles and the owner as the only member', async ({ page }) => {
  await register(page);
  await page.getByRole('link', { name: 'Roles' }).click();
  await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
  await expect(page.getByText('Administrator').first()).toBeVisible();
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByText('Aisha Tester').first()).toBeVisible();
});

test('signs out, refuses a wrong password, and signs back in with the authenticator code', async ({
  page,
}) => {
  const { email, secret } = await register(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not the right password at all');
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('alert').first()).toBeVisible();

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  // A code that was used for enrolment is not accepted twice: wait for the next 30 s window.
  await untilNextStep();
  await page.getByLabel('Code from your authenticator app').fill(totp(secret));
  await page.getByRole('button', { name: /verify|sign in|continue/i }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('a signed-out visitor is sent to the sign-in page', async ({ page }) => {
  await page.goto('/members');
  await expect(page).toHaveURL(/\/login/);
});

test('an owner can open the branch access and entity group pages and create a group', async ({
  page,
}) => {
  await register(page);
  await page.getByRole('link', { name: 'Branch access' }).click();
  await expect(page.getByRole('heading', { name: 'Branch access' })).toBeVisible();
  await page.getByRole('link', { name: 'Entity groups' }).click();
  await expect(page.getByRole('heading', { name: 'Legal entity groups' })).toBeVisible();
  await page.getByLabel('Group name').fill('Holding');
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByText('Holding').first()).toBeVisible();
});
