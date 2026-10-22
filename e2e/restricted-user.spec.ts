import { expect, test } from '@playwright/test';
import {
  apiAs,
  configureSales,
  createCustomer,
  issueCreditNote,
  PASSWORD,
  refundCreditNote,
  register,
  setUpAccounting,
  trialBalanceRow,
  uniqueEmail,
} from './helpers';
import { inviteThroughApi, openInvitationLink } from './support/invite';

/**
 * A role-restricted second user (R-05). The owner invites a Member (the system role that can view
 * Sales but void nothing) through the real invitation service; the invitee accepts through the
 * real acceptance page and signs in with their own password. The void form is not offered to the
 * Member, and a direct void request with the Member's own session is refused with 403 and changes
 * nothing. The invitation token stays in memory: tracing is off here so it is never written to a
 * trace file (the acceptance link carries it), and a failed navigation to that link is reported
 * with the token masked (`openInvitationLink`).
 *
 * Not covered here: the password re-confirmation prompt. A browser session is always within the
 * re-authentication window, so the prompt cannot be reached without changing the shared test
 * environment; it is covered at API level (`customer-refunds.test.ts`, `receipts.test.ts`).
 */

test.use({ trace: 'off' });

test('a Member sees a refund but cannot void it, on the screen or through the API', async ({
  page,
  browser,
}) => {
  await register(page, 'Restricted Access Pvt Ltd');
  await setUpAccounting(page);
  await configureSales(page);
  await createCustomer(page, 'Restricted Customer');
  const creditUrl = await issueCreditNote(page, {
    customer: 'Restricted Customer',
    date: '2026-06-18',
    amount: '50.00',
  });
  const refundUrl = await refundCreditNote(page, {
    creditUrl,
    date: '2026-06-20',
    amount: '50.00',
  });
  const refundId = refundUrl.split('/').pop()!;
  const before = await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents();

  // The owner invites a Member; the invitee accepts in a browser of their own.
  const memberEmail = uniqueEmail();
  const token = await inviteThroughApi(page.context(), {
    email: memberEmail,
    roleName: 'Member',
  });
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  try {
    await openInvitationLink(member, token);
    await expect(member.getByText(/as Member/)).toBeVisible();
    await member.getByLabel('Your name').fill('Mariyam Viewer');
    await member.getByLabel('Choose a password').fill(PASSWORD);
    await member.getByRole('button', { name: 'Accept invitation' }).click();
    await expect(member.getByRole('navigation', { name: 'Main' })).toBeVisible();
    const session = JSON.parse((await apiAs(member, 'GET', '/auth/session')).text).data;
    expect(session.user.email).toBe(memberEmail);

    // The Member can open the refund but is offered no void.
    await member.goto(refundUrl);
    await expect(member.getByText('Restricted Customer').first()).toBeVisible();
    await expect(member.getByText('50.00').first()).toBeVisible();
    await expect(member.getByLabel('Void reason')).toHaveCount(0);
    await expect(member.getByRole('button', { name: 'Void', exact: true })).toHaveCount(0);

    // A direct void request with the Member's own session is refused.
    const refund = JSON.parse((await apiAs(member, 'GET', `/sales/refunds/${refundId}`)).text)
      .data as { version: number; status: string };
    expect(refund.status).toBe('RECORDED');
    const attempt = await apiAs(member, 'POST', `/sales/refunds/${refundId}/void`, {
      version: refund.version,
      reason: 'Not allowed',
    });
    expect(attempt.status).toBe(403);
    expect(attempt.text).not.toContain('"status":"VOID"');
  } finally {
    await memberContext.close();
  }

  // Nothing changed: the refund is still recorded, the cash is still paid out, no void audited.
  const after = JSON.parse((await apiAs(page, 'GET', `/sales/refunds/${refundId}`)).text).data;
  expect(after.status).toBe('RECORDED');
  expect(await (await trialBalanceRow(page, /1120 Bank Accounts/)).allTextContents()).toEqual(
    before,
  );
  await page.goto('/audit');
  await expect(page.getByRole('cell', { name: 'invitation.accepted', exact: true })).toHaveCount(1);
  await expect(page.getByRole('cell', { name: 'customer_refund.voided', exact: true })).toHaveCount(
    0,
  );
  // The owner still can: the void form is offered to them.
  await page.goto(refundUrl);
  await expect(page.getByLabel('Void reason')).toBeVisible();
});
