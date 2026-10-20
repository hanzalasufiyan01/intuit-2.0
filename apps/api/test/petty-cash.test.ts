import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Petty cash funds and counts (migration 0093; ADR 0015): a count compares the cash counted with
 * the ledger balance and posts a difference to the over/short account the organization chose.
 * Real PostgreSQL.
 */

let ctx: TestContext;
let db: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  db = await connectAs('owner');
});
afterAll(async () => {
  await db.end();
  await ctx.close();
});

const today = () => ctx.clock.now().toISOString().slice(0, 10);

/** An organization whose cash account (1110) holds 1000.00 after one posted sale. */
async function org() {
  const o = await setUpAccountingOrg(ctx);
  await postJournal(o, cashSale(o, '1000.00', today()));
  return o;
}

async function balanceOf(o: AccountingOrg, accountId: string) {
  const r = await db.query(
    `SELECT coalesce(sum(coalesce(l.base_debit, 0) - coalesce(l.base_credit, 0)), 0)::numeric(28,2) AS b
       FROM accounting_journal_lines l
       JOIN accounting_journal_entries j ON j.id = l.journal_id AND j.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.account_id = $2 AND j.status IN ('POSTED', 'REVERSED')`,
    [o.organizationId, accountId],
  );
  return Number(r.rows[0].b);
}

const fundBody = (o: AccountingOrg, extra: object = {}) => ({
  name: 'Front desk',
  accountId: o.accounts['1110'],
  custodianName: 'Aisha',
  floatAmount: '1000',
  ...extra,
});

describe('petty cash', () => {
  it('records exact, short and over counts, posting only differences to the chosen account', async () => {
    const o = await org();
    const fund = await o.owner.post('/petty-cash/funds', fundBody(o));
    expect(fund.status, JSON.stringify(fund.body)).toBe(201);
    const fundId = fund.body.data.id as string;
    const listed = (await o.owner.get('/petty-cash/funds')).body.data;
    expect(listed[0]).toMatchObject({
      name: 'Front desk',
      floatAmount: '1000',
      bookBalance: '1000',
    });

    // An exact count posts nothing.
    const exact = await o.owner.post(`/petty-cash/funds/${fundId}/counts`, {
      countDate: today(),
      countedAmount: '1000',
    });
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);
    expect(exact.body.data).toMatchObject({
      number: 'PCC-00001',
      difference: '0',
      journalId: null,
    });

    // A difference needs the over/short account first.
    const noAccount = await o.owner.post(`/petty-cash/funds/${fundId}/counts`, {
      countDate: today(),
      countedAmount: '950',
    });
    expect(noAccount.status).toBe(400);
    expect(noAccount.body.error.details.issues[0].path).toBe('settings');
    expect((await o.owner.get('/petty-cash/counts')).body.data).toHaveLength(1);
    const settings = await o.owner.put('/petty-cash/settings', {
      overShortAccountId: o.accounts['5400'],
      version: 0,
    });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);

    // Short by 50: Dr over/short, Cr cash. The ledger balance follows the count.
    const short = await o.owner.post(`/petty-cash/funds/${fundId}/counts`, {
      countDate: today(),
      countedAmount: '950',
      memo: 'Receipts missing',
    });
    expect(short.status, JSON.stringify(short.body)).toBe(201);
    expect(short.body.data).toMatchObject({ bookBalance: '1000', difference: '-50' });
    const journal = (await o.owner.get(`/accounting/journals/${short.body.data.journalId}`)).body
      .data;
    expect(journal.status).toBe('POSTED');
    const byAccount = Object.fromEntries(
      journal.lines.map((l: { accountId: string; debit: string | null; credit: string | null }) => [
        l.accountId,
        [Number(l.debit ?? 0), Number(l.credit ?? 0)],
      ]),
    );
    expect(byAccount[o.accounts['5400']!]).toEqual([50, 0]);
    expect(byAccount[o.accounts['1110']!]).toEqual([0, 50]);
    expect(await balanceOf(o, o.accounts['1110']!)).toBe(950);

    // Over by 150 against the new book balance: Dr cash, Cr over/short.
    const over = await o.owner.post(`/petty-cash/funds/${fundId}/counts`, {
      countDate: today(),
      countedAmount: '1100',
    });
    expect(over.body.data).toMatchObject({ bookBalance: '950', difference: '150' });
    expect(await balanceOf(o, o.accounts['1110']!)).toBe(1100);
    expect(await balanceOf(o, o.accounts['5400']!)).toBe(-100);

    // Counts are final and every posted journal balances.
    await expect(
      db.query(`UPDATE petty_cash_counts SET counted_amount = 1 WHERE id = $1`, [
        over.body.data.id,
      ]),
    ).rejects.toThrow(/append-only|not permitted/);
    const unbalanced = await db.query(
      `SELECT j.id FROM accounting_journal_entries j WHERE j.organization_id = $1
          AND (SELECT coalesce(sum(base_debit), 0) - coalesce(sum(base_credit), 0)
                 FROM accounting_journal_lines l WHERE l.journal_id = j.id) <> 0`,
      [o.organizationId],
    );
    expect(unbalanced.rows).toEqual([]);
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'petty_cash.%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'petty_cash.fund_created',
        'petty_cash.settings_updated',
        'petty_cash.counted',
      ]),
    );
  });

  it('validates funds and counts, and refuses closed periods, future dates and archived funds', async () => {
    const o = await org();
    for (const bad of [
      fundBody(o, { accountId: o.accounts['4100'] }), // not an asset
      fundBody(o, { accountId: o.accounts['1130'] }), // receivables are not cash
      fundBody(o, { floatAmount: '-1' }),
      fundBody(o, { name: ' ' }),
    ]) {
      expect((await o.owner.post('/petty-cash/funds', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const fund = await o.owner.post('/petty-cash/funds', fundBody(o));
    // One active fund per cash account, and unique names.
    expect((await o.owner.post('/petty-cash/funds', fundBody(o, { name: 'Other' }))).status).toBe(
      409,
    );
    const fundId = fund.body.data.id as string;
    await o.owner.put('/petty-cash/settings', {
      overShortAccountId: o.accounts['5400'],
      version: 0,
    });
    expect(
      (
        await o.owner.put('/petty-cash/settings', {
          overShortAccountId: o.accounts['1110'],
          version: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (await o.owner.put('/petty-cash/settings', { overShortAccountId: null, version: 0 })).status,
    ).toBe(409);
    for (const bad of [
      { countDate: '2999-01-01', countedAmount: '10' },
      { countDate: today(), countedAmount: '-5' },
      { countDate: 'x', countedAmount: '10' },
    ]) {
      expect(
        (await o.owner.post(`/petty-cash/funds/${fundId}/counts`, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    // The cash account of a fund cannot change; archiving frees it and stops counts.
    await expect(
      db.query(`UPDATE petty_cash_funds SET account_id = $1 WHERE id = $2`, [
        o.accounts['1120'],
        fundId,
      ]),
    ).rejects.toThrow(/cannot change/);
    const archived = await o.owner.patch(`/petty-cash/funds/${fundId}`, {
      version: 1,
      status: 'ARCHIVED',
    });
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(
      (
        await o.owner.post(`/petty-cash/funds/${fundId}/counts`, {
          countDate: today(),
          countedAmount: '1',
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.owner.post('/petty-cash/funds', fundBody(o, { name: 'Reopened' }))).status,
    ).toBe(201);
  });

  it('needs banking permissions and stays inside the tenant', async () => {
    const o = await org();
    const fund = await o.owner.post('/petty-cash/funds', fundBody(o));
    const fundId = fund.body.data.id as string;
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/petty-cash/funds')).status).toBe(200);
    expect((await member.client.post('/petty-cash/funds', fundBody(o, { name: 'x' }))).status).toBe(
      403,
    );
    expect(
      (
        await member.client.post(`/petty-cash/funds/${fundId}/counts`, {
          countDate: today(),
          countedAmount: '1000',
        })
      ).status,
    ).toBe(403);
    expect(
      (await member.client.put('/petty-cash/settings', { overShortAccountId: null, version: 0 }))
        .status,
    ).toBe(403);
    const stranger = await org();
    expect((await stranger.owner.get('/petty-cash/funds')).body.data).toEqual([]);
    expect(
      (
        await stranger.owner.post(`/petty-cash/funds/${fundId}/counts`, {
          countDate: today(),
          countedAmount: '1',
        })
      ).status,
    ).toBe(404);
    expect(
      (await stranger.owner.patch(`/petty-cash/funds/${fundId}`, { version: 1, name: 'x' })).status,
    ).toBe(404);
  });
});
