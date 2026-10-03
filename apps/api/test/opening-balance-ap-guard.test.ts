import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * ADR 0004 P4-36: the S8-07 opening-balance guard also rejects ACCOUNTS_PAYABLE accounts, whether
 * or not the account is (yet) the Purchases AP control account. Checked at draft save, import,
 * preview and post (application rule) and on every opening line written (database trigger). The
 * existing receivable, control, unclassified and other S8 rules are unchanged. Serial: the import
 * test drives the job worker.
 */

let ctx: TestContext;
let owner: pg.Client;
beforeAll(async () => {
  ctx = await createTestContext();
  owner = await connectAs('owner');
});
afterAll(async () => {
  await owner.end();
  await ctx.close();
});

const AP_MESSAGE = /Accounts payable cannot be given an opening balance here/;
const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

const side = (accountId: string, s: 'debit' | 'credit', amount: string) => ({
  accountId,
  debit: s === 'debit' ? amount : null,
  credit: s === 'credit' ? amount : null,
});

async function draft(client: TestClient) {
  const set = await client.put('/accounting/settings/conversion-date', {
    conversionDate: '2026-04-01',
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const created = await client.post('/accounting/opening-balances', { notes: 'Prior system' });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.data as { id: string; version: number };
}

async function save(client: TestClient, batchId: string, lines: unknown[]) {
  const current = (await client.get(`/accounting/opening-balances/${batchId}`)).body.data;
  return client.put(`/accounting/opening-balances/${batchId}/lines`, {
    version: current.version,
    lines,
  });
}

async function version(client: TestClient, batchId: string): Promise<number> {
  return (await client.get(`/accounting/opening-balances/${batchId}`)).body.data.version;
}

async function journalCount(o: AccountingOrg) {
  const { rows } = await owner.query(
    `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
    [o.organizationId],
  );
  return rows[0].n as number;
}

async function newAccount(o: AccountingOrg, body: Record<string, unknown>) {
  const res = await o.owner.post('/accounting/accounts', body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

describe('P4-36: payables cannot take generic opening balances', () => {
  it('rejects an AP account that is not (yet) the Purchases control account at save', async () => {
    const o = await setUpAccountingOrg(ctx);
    const batch = await draft(o.owner);
    expect(
      (await o.owner.get(`/accounting/accounts/${o.accounts['2110']}`)).body.data,
    ).toMatchObject({ subtype: 'ACCOUNTS_PAYABLE', isControlAccount: false });
    const res = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '100.00'),
      side(o.accounts['2110']!, 'credit', '100.00'),
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toContainEqual({
      path: 'lines.1.accountId',
      message: expect.stringMatching(AP_MESSAGE),
    });
    // A second, newly created payables account is refused the same way (subtype-based).
    const other = await newAccount(o, {
      code: '2115',
      name: 'Payables - projects',
      type: 'LIABILITY',
      parentId: o.accounts['2100'],
      subtype: 'ACCOUNTS_PAYABLE',
    });
    const again = await save(o.owner, batch.id, [side(other, 'credit', '5.00')]);
    expect(JSON.stringify(again.body)).toMatch(AP_MESSAGE);
    expect((await o.owner.get(`/accounting/opening-balances/${batch.id}`)).body.data.lines).toEqual(
      [],
    );
  });

  it('rejects the Purchases AP control account (control rule) and keeps AR rejected', async () => {
    const o = await setUpAccountingOrg(ctx);
    const purchases = await o.owner.put('/purchases/settings', {
      version: 0,
      apAccountId: o.accounts['2110'],
      defaultExpenseAccountId: null,
      defaultPaymentAccountId: null,
      defaultTaxCodeId: null,
      defaultTaxTreatment: 'exclusive',
      defaultPaymentTermsDays: 30,
    });
    expect(purchases.status, JSON.stringify(purchases.body)).toBe(200);
    const batch = await draft(o.owner);
    const ap = await save(o.owner, batch.id, [side(o.accounts['2110']!, 'credit', '1.00')]);
    expect(ap.status).toBe(400);
    expect(JSON.stringify(ap.body)).toMatch(
      /Control accounts are maintained through their subledger/,
    );
    // S8-07 unchanged: receivables (not yet a control account) and unclassified accounts.
    const ar = await save(o.owner, batch.id, [side(o.accounts['1130']!, 'debit', '1.00')]);
    expect(JSON.stringify(ar.body)).toMatch(/opening invoices/);
    const unclassified = await newAccount(o, {
      code: '2190',
      name: 'Old suspense',
      type: 'LIABILITY',
      parentId: o.accounts['2100'],
    });
    const plain = await save(o.owner, batch.id, [side(unclassified, 'credit', '1.00')]);
    expect(JSON.stringify(plain.body)).toMatch(/has no subtype/);
  });

  it('still accepts ordinary assets and liabilities, and posts and reverses them', async () => {
    const o = await setUpAccountingOrg(ctx);
    const batch = await draft(o.owner);
    const ok = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '1000.00'),
      side(o.accounts['1150']!, 'debit', '200.00'), // OTHER_CURRENT_ASSET (prepaid)
      side(o.accounts['2120']!, 'credit', '300.00'), // OTHER_CURRENT_LIABILITY (accrued)
      side(o.accounts['2510']!, 'credit', '400.00'), // LONG_TERM_LIABILITY
    ]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const preview = await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {});
    expect(preview.body.data.errors).toEqual([]);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.status).toBe('POSTED');
    const reversed = await o.owner.post(`/accounting/opening-balances/${batch.id}/reverse`, {
      reason: 'Wrong conversion figures',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data.status).toBe('REVERSED');
  });

  it('re-validates at preview and post: an account reclassified to AP after saving is refused', async () => {
    const o = await setUpAccountingOrg(ctx);
    const accrual = await newAccount(o, {
      code: '2125',
      name: 'Supplier accruals',
      type: 'LIABILITY',
      parentId: o.accounts['2100'],
      subtype: 'OTHER_CURRENT_LIABILITY',
    });
    const batch = await draft(o.owner);
    const saved = await save(o.owner, batch.id, [
      side(o.accounts['1110']!, 'debit', '50.00'),
      side(accrual, 'credit', '50.00'),
    ]);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    // Reclassified to payables after the line was saved (the line itself is not rewritten).
    const reclassified = await o.owner.patch(`/accounting/accounts/${accrual}`, {
      subtype: 'ACCOUNTS_PAYABLE',
    });
    expect(reclassified.status, JSON.stringify(reclassified.body)).toBe(200);
    const preview = await o.owner.post(`/accounting/opening-balances/${batch.id}/preview`, {});
    expect(preview.status).toBe(200);
    expect(preview.body.data.errors).toContainEqual({
      path: 'lines.1.accountId',
      message: expect.stringMatching(AP_MESSAGE),
    });
    const before = await journalCount(o);
    const posted = await o.owner.post(`/accounting/opening-balances/${batch.id}/post`, {
      version: await version(o.owner, batch.id),
    });
    expect(posted.status).toBe(400);
    expect(JSON.stringify(posted.body)).toMatch(AP_MESSAGE);
    // Nothing reached the ledger, and the batch is still a draft.
    expect(await journalCount(o)).toBe(before);
    expect((await o.owner.get(`/accounting/opening-balances/${batch.id}`)).body.data.status).toBe(
      'DRAFT',
    );
  });

  it('rejects AP rows in an opening-balance import', async () => {
    const o = await setUpAccountingOrg(ctx);
    await o.owner.put('/accounting/settings/conversion-date', { conversionDate: '2026-04-01' });
    const created = await o.owner.post('/imports', { domain: 'opening_balances', options: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    const up = await o.owner.upload(
      `/files?linkType=import_batch&linkId=${id}`,
      Buffer.from(
        csv(
          'Account,Debit,Credit,Base amount,Description',
          '1110,10.00,,,Cash',
          '2110,,10.00,,Supplier balances',
        ),
      ),
      'ob.csv',
    );
    expect(up.status, JSON.stringify(up.body)).toBe(201);
    const inspected = await o.owner.post(`/imports/${id}/inspect`, {});
    await o.owner.put(`/imports/${id}/mapping`, {
      version: inspected.body.data.batch.version,
      mapping: inspected.body.data.suggestedMapping,
    });
    let batch = (await o.owner.get(`/imports/${id}`)).body.data;
    for (let i = 0; i < 40 && ['validating', 'committing'].includes(batch.status); i++) {
      await ctx.worker.runOnce();
      batch = (await o.owner.get(`/imports/${id}`)).body.data;
    }
    expect(batch.counts).toMatchObject({ error: 1 });
    const errors = await o.owner.get(`/imports/${id}/rows?status=error&limit=10`);
    expect(JSON.stringify(errors.body)).toMatch(AP_MESSAGE);
  });

  it('is enforced by the database trigger and stays tenant-isolated', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const batch = await draft(a.owner);
    // Another organization's account is unknown here.
    const foreign = await save(a.owner, batch.id, [side(b.accounts['1110']!, 'debit', '1.00')]);
    expect(foreign.status).toBe(400);
    expect(JSON.stringify(foreign.body)).toMatch(/Unknown account/);
    // The backstop: a payables line written directly is refused by the trigger.
    await expect(
      owner.query(
        `INSERT INTO accounting_opening_balance_lines
           (organization_id, batch_id, line_number, account_id, credit)
         VALUES ($1, $2, 1, $3, 10)`,
        [a.organizationId, batch.id, a.accounts['2110']],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/Payable accounts cannot take opening balances/),
    });
    // RLS: organization B sees none of A's opening batches.
    const app = await connectAs('app');
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.organization_id', $1, true)`, [b.organizationId]);
      expect(
        (
          await app.query(`SELECT id FROM accounting_opening_balance_batches WHERE id = $1`, [
            batch.id,
          ])
        ).rows,
      ).toEqual([]);
    } finally {
      await app.query('ROLLBACK');
      await app.end();
    }
  });
});
