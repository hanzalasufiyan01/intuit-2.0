import type { BrowserContext, Page } from '@playwright/test';
import { buildApp } from '../../apps/api/src/app.js';
import { createDatabase } from '../../apps/api/src/database/client.js';
import { systemClock } from '../../apps/api/src/infrastructure/clock.js';
import { loadConfig } from '../../apps/api/src/infrastructure/config/config.js';
import { loadEnvFile } from '../../apps/api/src/infrastructure/config/load-env.js';
import { MockEmailProvider } from '../../apps/api/src/infrastructure/email/email-provider.js';
import { createArgon2idPasswordHasher } from '../../apps/api/src/infrastructure/security/password-hasher.js';

/**
 * Invites a second user through the API's real InvitationService (R-05). The dev API started by
 * Playwright keeps its mock e-mail in its own memory, so the invitation link cannot be read from a
 * browser. This builds the same services in the Playwright process, against the same development
 * database (the repository `.env`), with a mock provider of its own, as the dev seed does
 * (`seed-dev.ts`). The owner acts through their real browser session; nothing is bypassed: the
 * invitation is created, audited and accepted exactly as from the Members page and the e-mailed
 * link. The token is returned in memory only and never logged or written to a file.
 */
export async function inviteThroughApi(
  ownerContext: BrowserContext,
  input: { email: string; roleName: string },
): Promise<string> {
  loadEnvFile();
  const config = loadConfig({ ...process.env, LOG_LEVEL: 'warn' });
  if (config.appEnv !== 'development' && config.appEnv !== 'testing') {
    throw new Error(`Refusing to create test invitations in APP_ENV=${config.appEnv}.`);
  }
  const cookie = (await ownerContext.cookies()).find((c) => c.name === config.session.cookieName);
  if (!cookie) throw new Error('The owner has no session cookie in this browser context.');

  const database = createDatabase({ connectionString: config.database.url, poolMax: 1 });
  const email = new MockEmailProvider(config.email.from);
  const origin = { requestId: 'e2e-invite', ipAddress: null, userAgent: 'e2e-invite' };
  const { app, services } = await buildApp({
    deps: {
      db: database.db,
      config,
      clock: systemClock,
      passwordHasher: createArgon2idPasswordHasher(),
      emailProvider: email,
    },
  });
  try {
    const owner = await services.auth.authenticate(cookie.value, origin);
    if (!owner) throw new Error('The owner session could not be validated.');
    const role = (await services.roles.listRoles(owner)).find((r) => r.name === input.roleName);
    if (!role) throw new Error(`No role named ${input.roleName}.`);
    await services.invitations.createInvitation(
      owner,
      { email: input.email, roleId: role.id },
      origin,
    );
    const token = email.lastTo(input.email)?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error('No invitation e-mail was captured.');
    return token;
  } finally {
    await app.close();
    await database.close();
  }
}

/**
 * Opens the acceptance link in a page. The link carries the token in its fragment, and when a
 * navigation fails Playwright prints the full URL in the error and its call log, so a failure here
 * is rethrown with the token masked. Failures after the page has loaded never contain the URL, and
 * the rest of Playwright's diagnostics (screenshots, error context) are left as they are.
 */
export async function openInvitationLink(page: Page, token: string): Promise<void> {
  try {
    await page.goto(`/invitations/accept#token=${token}`);
  } catch (error) {
    throw maskToken(error, token);
  }
}

function maskToken(error: unknown, token: string): Error {
  const mask = (text: string) => text.split(token).join('<invitation token>');
  if (!(error instanceof Error)) return new Error(mask(String(error)));
  const masked = new Error(mask(error.message));
  masked.name = error.name;
  if (error.stack) masked.stack = mask(error.stack);
  return masked;
}
