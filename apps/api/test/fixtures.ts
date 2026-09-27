import { expect } from 'vitest';
import {
  TEST_PASSWORD,
  tokenFromEmail,
  uniqueEmail,
  type TestClient,
  type TestContext,
} from './helpers.js';

export interface AccountingOrg {
  owner: TestClient;
  ownerEmail: string;
  organizationId: string;
  ownerMembershipId: string;
  /** Account ids by code (template accounts). */
  accounts: Record<string, string>;
  periods: { id: string; name: string; startDate: string; endDate: string; status: string }[];
}

/** Registers an organization, sets up accounting (MVR, Maldives template) and FY 2026. */
export async function setUpAccountingOrg(
  ctx: TestContext,
  options: { baseCurrency?: string; templateKey?: string; fiscalYear?: boolean } = {},
): Promise<AccountingOrg> {
  const owner = ctx.client();
  const { email, session } = await owner.register();
  const setup = await owner.post('/accounting/setup', {
    baseCurrency: options.baseCurrency ?? 'MVR',
    templateKey: options.templateKey ?? 'maldives',
  });
  expect(setup.status, JSON.stringify(setup.body)).toBe(201);
  let periods: AccountingOrg['periods'] = [];
  if (options.fiscalYear !== false) {
    const fy = await owner.post('/accounting/fiscal-years', {
      name: 'FY2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(fy.status, JSON.stringify(fy.body)).toBe(201);
    periods = fy.body.data.periods;
  }
  const accounts = await owner.get('/accounting/accounts');
  return {
    owner,
    ownerEmail: email,
    organizationId: session.activeOrganization.id,
    ownerMembershipId: session.activeOrganization.membershipId,
    accounts: Object.fromEntries(
      accounts.body.data.map((a: { code: string; id: string }) => [a.code, a.id]),
    ),
    periods,
  };
}

/** Invites a new person into the owner's active organization with a role; returns their client. */
export async function joinWithRole(ctx: TestContext, owner: TestClient, roleName: string) {
  const roles = (await owner.get('/organizations/current/roles')).body.data as {
    id: string;
    name: string;
  }[];
  const role = roles.find((r) => r.name === roleName);
  if (!role) throw new Error(`role ${roleName} missing`);
  const email = uniqueEmail('member');
  const invited = await owner.post('/organizations/current/invitations', {
    email,
    roleId: role.id,
  });
  expect(invited.status).toBe(201);
  const client = ctx.client();
  const accepted = await client.post('/invitations/accept', {
    token: tokenFromEmail(ctx.email, email),
    displayName: `${roleName} person`,
    password: TEST_PASSWORD,
  });
  expect(accepted.status).toBe(200);
  return {
    client,
    email,
    userId: accepted.body.data.user.id as string,
    membershipId: accepted.body.data.activeOrganization.membershipId as string,
    roleId: role.id,
  };
}

export function line(
  accountId: string,
  side: 'debit' | 'credit',
  amount: string,
  description = '',
) {
  return {
    accountId,
    description,
    debit: side === 'debit' ? amount : null,
    credit: side === 'credit' ? amount : null,
  };
}

/** A balanced two-line journal: debit cash, credit sales revenue. */
export function cashSale(
  org: AccountingOrg,
  amount = '100.00',
  entryDate = '2026-03-15',
  currency = 'MVR',
) {
  return {
    entryDate,
    description: 'Cash sale',
    currency,
    lines: [
      line(org.accounts['1110']!, 'debit', amount),
      line(org.accounts['4100']!, 'credit', amount),
    ],
  };
}

/** Creates and posts a journal directly (no approval policy configured). */
export async function postJournal(org: AccountingOrg, body = cashSale(org)) {
  const created = await org.owner.post('/accounting/journals', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const posted = await org.owner.post(`/accounting/journals/${created.body.data.id}/post`);
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return posted.body.data;
}
