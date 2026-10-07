import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cashSale,
  joinWithRole,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/**
 * Banking: bank accounts, statement import (CSV and OFX), duplicate detection, matching, bank
 * entries (categorize), transfers, reconciliation and rules. Banking never writes the ledger
 * directly; a reconciliation never touches a posted journal line.
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

const CSV_MAPPING = {
  dateColumn: 'Date',
  descriptionColumn: 'Description',
  amountColumn: 'Amount',
  balanceColumn: 'Balance',
  dateFormat: 'YYYY-MM-DD',
  decimalSeparator: '.',
  delimiter: 'auto',
};

const statementCsv = (rows: [string, string, string][]) =>
  ['Date,Description,Amount,Balance', ...rows.map(([d, t, a]) => `${d},${t},${a},`)].join('\n');

interface BankOrg extends AccountingOrg {
  bankId: string;
}

async function bankOrg(options: { opening?: string } = {}): Promise<BankOrg> {
  const org = await setUpAccountingOrg(ctx);
  const res = await org.owner.post('/banking/accounts', {
    accountId: org.accounts['1110'],
    name: 'Main account',
    openingBalance: options.opening ?? '1000.00',
    openingBalanceDate: '2026-03-01',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { ...org, bankId: res.body.data.id };
}

async function importCsv(
  client: TestClient,
  bankId: string,
  rows: [string, string, string][],
  headers = {},
) {
  return client.post(
    `/banking/accounts/${bankId}/statements`,
    { format: 'csv', content: statementCsv(rows), mapping: CSV_MAPPING },
    headers,
  );
}

async function transactions(client: TestClient, bankId: string, query = '') {
  const res = await client.get(`/banking/accounts/${bankId}/transactions${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.items as {
    id: string;
    date: string;
    description: string;
    amount: string;
    status: string;
    match: { source: string; journalId: string } | null;
    suggestion: { categoryAccountId: string; ruleName: string } | null;
  }[];
}

async function journalOf(o: AccountingOrg, journalId: string) {
  return (await o.owner.get(`/accounting/journals/${journalId}`)).body.data as {
    status: string;
    currency: string;
    exchangeRate: string | null;
    sourceDocument: { documentType: string; number: string } | null;
    lines: {
      accountId: string;
      debit: string | null;
      credit: string | null;
      baseDebit: string | null;
      baseCredit: string | null;
    }[];
  };
}

/** A digest of every posted journal line of the organization, to prove nothing was rewritten. */
async function ledgerDigest(organizationId: string) {
  const { rows } = await owner.query(
    `SELECT l.id, l.journal_id, l.account_id, l.debit, l.credit, l.base_debit, l.base_credit
       FROM accounting_journal_lines l WHERE l.organization_id = $1 ORDER BY l.id`,
    [organizationId],
  );
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

async function auditActions(o: AccountingOrg, resourceType: string, resourceId: string) {
  const { rows } = await owner.query(
    `SELECT action FROM audit_events
      WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3 ORDER BY occurred_at, id`,
    [o.organizationId, resourceType, resourceId],
  );
  return (rows as { action: string }[]).map((r) => r.action);
}

async function usdBank(o: AccountingOrg, code = '1128') {
  const res = await o.owner.post('/accounting/accounts', {
    code,
    name: 'USD bank',
    type: 'ASSET',
    subtype: 'BANK',
    currencyCode: 'USD',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.id as string;
}

/** Makes the AP account a control account (Purchases settings), as the subledgers do. */
async function makeApControl(o: AccountingOrg) {
  const res = await o.owner.put('/purchases/settings', {
    version: 0,
    apAccountId: o.accounts['2110'],
    defaultExpenseAccountId: o.accounts['5400'],
    defaultPaymentAccountId: o.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'exclusive',
    defaultPaymentTermsDays: 30,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function reauth(client: TestClient) {
  ctx.clock.advance(16 * MINUTE);
  await client.get('/auth/session');
  expect((await client.reauthenticate()).status).toBe(200);
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

describe('bank accounts', () => {
  it('follows a bank, cash or card account of the chart, with its currency', async () => {
    const o = await setUpAccountingOrg(ctx);
    const revenue = await o.owner.post('/banking/accounts', { accountId: o.accounts['4100'] });
    expect(revenue.status).toBe(400);
    expect(revenue.body.error.details.issues[0].path).toBe('accountId');
    const usd = await usdBank(o);
    const created = await o.owner.post('/banking/accounts', {
      accountId: usd,
      name: 'Dollar account',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      currencyCode: 'USD',
      name: 'Dollar account',
      status: 'ACTIVE',
      unmatchedCount: 0,
    });
    const duplicate = await o.owner.post('/banking/accounts', { accountId: usd });
    expect(duplicate.status).toBe(400);
    // A starting balance needs its date.
    const noDate = await o.owner.post('/banking/accounts', {
      accountId: o.accounts['1110'],
      openingBalance: '500.00',
    });
    expect(noDate.body.error.details.issues[0].path).toBe('openingBalanceDate');
    expect((await o.owner.get('/banking/accounts')).body.data.items).toHaveLength(1);
  });

  it('archives and restores, and fixes the opening balance once statements arrive', async () => {
    const o = await bankOrg();
    const account = (await o.owner.get(`/banking/accounts/${o.bankId}`)).body.data;
    const edited = await o.owner.patch(`/banking/accounts/${o.bankId}`, {
      version: account.version,
      openingBalance: '1200.00',
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await importCsv(o.owner, o.bankId, [['2026-03-10', 'Deposit', '50.00']])).status).toBe(
      201,
    );
    const locked = await o.owner.patch(`/banking/accounts/${o.bankId}`, {
      version: edited.body.data.version,
      openingBalance: '0',
    });
    expect(locked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const archived = await o.owner.post(`/banking/accounts/${o.bankId}/archive`, {
      version: edited.body.data.version,
    });
    expect(archived.body.data.status).toBe('ARCHIVED');
    const blocked = await importCsv(o.owner, o.bankId, [['2026-03-11', 'Deposit', '5.00']]);
    expect(blocked.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const restored = await o.owner.post(`/banking/accounts/${o.bankId}/restore`, {
      version: archived.body.data.version,
    });
    expect(restored.body.data.status).toBe('ACTIVE');
    expect(await auditActions(o, 'bank_account', o.bankId)).toEqual(
      expect.arrayContaining([
        'bank_account.created',
        'bank_account.archived',
        'bank_account.restored',
      ]),
    );
  });

  it('is tenant-isolated and permissioned', async () => {
    const a = await bankOrg();
    const b = await bankOrg();
    expect((await b.owner.get(`/banking/accounts/${a.bankId}`)).status).toBe(404);
    expect((await b.owner.get(`/banking/accounts/${a.bankId}/transactions`)).status).toBe(404);
    expect((await importCsv(b.owner, a.bankId, [['2026-03-10', 'x', '1.00']])).status).toBe(404);
    const member = await joinWithRole(ctx, a.owner, 'Member');
    expect((await member.client.get('/banking/accounts')).status).toBe(200);
    expect(
      (await member.client.post('/banking/accounts', { accountId: a.accounts['1120'] })).status,
    ).toBe(403);
    expect((await importCsv(member.client, a.bankId, [['2026-03-10', 'x', '1.00']])).status).toBe(
      403,
    );
    const txns = await transactions(a.owner, a.bankId);
    expect(txns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Statement import
// ---------------------------------------------------------------------------

describe('statement import', () => {
  it('imports a CSV statement, signed from the account side, and recognizes duplicates on re-import', async () => {
    const o = await bankOrg();
    const first = await importCsv(o.owner, o.bankId, [
      ['2026-03-10', 'Customer deposit', '100.00'],
      ['2026-03-11', 'Office supplies', '-45.50'],
      ['2026-03-11', 'Office supplies', '-45.50'],
    ]);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data).toMatchObject({
      imported: 3,
      duplicates: 0,
      periodStart: '2026-03-10',
      periodEnd: '2026-03-11',
    });
    // An overlapping statement: two old lines and one new.
    const second = await importCsv(o.owner, o.bankId, [
      ['2026-03-11', 'Office supplies', '-45.50'],
      ['2026-03-11', 'Office supplies', '-45.50'],
      ['2026-03-12', 'Bank fee', '-5.00'],
    ]);
    expect(second.body.data).toMatchObject({ imported: 1, duplicates: 2 });
    const rows = await transactions(o.owner, o.bankId);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.amount).sort()).toEqual(['-45.50', '-45.50', '-5.00', '100.00']);
    const imports = (await o.owner.get(`/banking/accounts/${o.bankId}/statements`)).body.data.items;
    expect(imports).toHaveLength(2);
    // Nothing reached the ledger.
    const { rows: journals } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(journals[0].n).toBe(0);
  });

  it('refuses a statement with unreadable rows entirely, with the row numbers', async () => {
    const o = await bankOrg();
    const res = await importCsv(o.owner, o.bankId, [
      ['2026-03-10', 'Good', '10.00'],
      ['not-a-date', 'Bad date', '10.00'],
      ['2026-03-12', 'Zero', '0'],
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues.length).toBe(2);
    expect(await transactions(o.owner, o.bankId)).toHaveLength(0);
    const noMapping = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'csv',
      content: statementCsv([['2026-03-10', 'x', '1']]),
    });
    expect(noMapping.status).toBe(400);
    const badColumn = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'csv',
      content: statementCsv([['2026-03-10', 'x', '1']]),
      mapping: { ...CSV_MAPPING, amountColumn: 'Nope' },
    });
    expect(badColumn.status).toBe(400);
  });

  it('reads separate debit and credit columns and a comma decimal separator', async () => {
    const o = await bankOrg();
    const content = 'Datum;Text;Soll;Haben\n10/03/2026;Rent;1.250,00;\n12/03/2026;Refund;;75,5';
    const res = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'csv',
      content,
      mapping: {
        dateColumn: 'Datum',
        descriptionColumn: 'Text',
        debitColumn: 'Soll',
        creditColumn: 'Haben',
        dateFormat: 'DD/MM/YYYY',
        decimalSeparator: ',',
        delimiter: ';',
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const rows = await transactions(o.owner, o.bankId);
    expect(rows.map((r) => [r.date, r.amount]).sort()).toEqual([
      ['2026-03-10', '-1250.00'],
      ['2026-03-12', '75.50'],
    ]);
  });

  it('previews the columns of a CSV statement', async () => {
    const o = await bankOrg();
    const res = await o.owner.post('/banking/statements/preview', {
      content: statementCsv([['2026-03-10', 'x', '1']]),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.columns).toEqual(['Date', 'Description', 'Amount', 'Balance']);
  });

  it('imports OFX with the bank transaction id as a second duplicate check, and refuses unsafe or foreign files', async () => {
    const o = await bankOrg();
    const ofx = (fitid: string, memo: string, amount: string, currency = 'MVR') => `OFXHEADER:100
DATA:OFXSGML
VERSION:102

<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${currency}
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260312120000<TRNAMT>${amount}<FITID>${fitid}<NAME>Shop<MEMO>${memo}
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
    const first = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'ofx',
      content: ofx('F-1', 'Groceries', '-20.00'),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.imported).toBe(1);
    // The same FITID with a re-worded memo is still the same transaction.
    const again = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'ofx',
      content: ofx('F-1', 'Groceries (posted)', '-20.00'),
    });
    expect(again.body.data).toMatchObject({ imported: 0, duplicates: 1 });
    const wrongCurrency = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'ofx',
      content: ofx('F-2', 'x', '-1.00', 'USD'),
    });
    expect(wrongCurrency.status).toBe(400);
    const doctype = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'ofx',
      content: `<!DOCTYPE foo [<!ENTITY x "y">]>${ofx('F-3', 'x', '-1.00')}`,
    });
    expect(doctype.status).toBe(400);
    const notOfx = await o.owner.post(`/banking/accounts/${o.bankId}/statements`, {
      format: 'ofx',
      content: 'hello world',
    });
    expect(notOfx.status).toBe(400);
  });

  it('replays an idempotent import', async () => {
    const o = await bankOrg();
    const key = randomUUID();
    const rows: [string, string, string][] = [['2026-03-10', 'Deposit', '10.00']];
    const first = await importCsv(o.owner, o.bankId, rows, { 'Idempotency-Key': key });
    const replay = await importCsv(o.owner, o.bankId, rows, { 'Idempotency-Key': key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);
    expect(await transactions(o.owner, o.bankId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

describe('matching', () => {
  it('suggests posted journal lines of the same amount, matches, unmatches, excludes and restores', async () => {
    const o = await bankOrg();
    const journal = await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await postJournal(o, cashSale(o, '75.00', '2026-03-15'));
    await importCsv(o.owner, o.bankId, [
      ['2026-03-16', 'Customer deposit', '100.00'],
      ['2026-03-17', 'Mystery', '33.00'],
    ]);
    const [deposit, mystery] = [
      (await transactions(o.owner, o.bankId)).find((t) => t.amount === '100.00')!,
      (await transactions(o.owner, o.bankId)).find((t) => t.amount === '33.00')!,
    ];
    const suggestions = await o.owner.get(`/banking/transactions/${deposit.id}/suggestions`);
    expect(suggestions.body.data.items).toHaveLength(1);
    expect(suggestions.body.data.items[0]).toMatchObject({
      journalId: journal.id,
      amount: '100.00',
    });
    expect(
      (await o.owner.get(`/banking/transactions/${mystery.id}/suggestions`)).body.data.items,
    ).toHaveLength(0);

    const before = await ledgerDigest(o.organizationId);
    const lineId = suggestions.body.data.items[0].journalLineId;
    const matched = await o.owner.post(`/banking/transactions/${deposit.id}/match`, {
      journalLineId: lineId,
    });
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect(matched.body.data).toMatchObject({
      status: 'MATCHED',
      match: { source: 'manual', journalId: journal.id },
    });
    // A matched line is no longer offered, and a transaction matches once.
    const twice = await o.owner.post(`/banking/transactions/${deposit.id}/match`, {
      journalLineId: lineId,
    });
    expect(twice.status).toBe(409);
    const unmatched = await o.owner.post(`/banking/transactions/${deposit.id}/unmatch`);
    expect(unmatched.body.data).toMatchObject({ status: 'UNMATCHED', match: null });
    // The ledger is exactly as it was.
    expect(await ledgerDigest(o.organizationId)).toBe(before);

    const excluded = await o.owner.post(`/banking/transactions/${mystery.id}/exclude`, {
      reason: 'Personal',
    });
    expect(excluded.body.data).toMatchObject({ status: 'EXCLUDED', excludedReason: 'Personal' });
    expect(
      (await o.owner.post(`/banking/transactions/${mystery.id}/exclude`, { reason: 'again' }))
        .status,
    ).toBe(409);
    expect(
      (await o.owner.post(`/banking/transactions/${mystery.id}/restore`)).body.data.status,
    ).toBe('UNMATCHED');
    expect(await auditActions(o, 'bank_transaction', deposit.id)).toEqual(
      expect.arrayContaining(['bank_transaction.matched', 'bank_transaction.unmatched']),
    );
  });

  it('refuses a line of another account or another amount', async () => {
    const o = await bankOrg();
    const sale = await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await importCsv(o.owner, o.bankId, [['2026-03-16', 'Other amount', '90.00']]);
    const [txn] = await transactions(o.owner, o.bankId);
    const detail = await journalOf(o, sale.id);
    const cashLine = (await o.owner.get(`/banking/accounts/${o.bankId}/register`)).body.data
      .items[0].journalLineId;
    const wrongAmount = await o.owner.post(`/banking/transactions/${txn!.id}/match`, {
      journalLineId: cashLine,
    });
    expect(wrongAmount.status).toBe(400);
    const { rows } = await owner.query(
      `SELECT l.id FROM accounting_journal_lines l WHERE l.journal_id = $1 AND l.account_id = $2`,
      [sale.id, o.accounts['4100']],
    );
    const revenueLine = rows[0].id as string;
    const wrongAccount = await o.owner.post(`/banking/transactions/${txn!.id}/match`, {
      journalLineId: revenueLine,
    });
    expect(wrongAccount.status).toBe(400);
    expect(detail.lines).toHaveLength(2);
  });

  it('auto-matches only unambiguous lines', async () => {
    const o = await bankOrg();
    await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await postJournal(o, cashSale(o, '60.00', '2026-03-15'));
    await postJournal(o, cashSale(o, '60.00', '2026-03-16'));
    await importCsv(o.owner, o.bankId, [
      ['2026-03-16', 'Deposit', '100.00'],
      ['2026-03-16', 'Two possible', '60.00'],
    ]);
    const res = await o.owner.post(`/banking/accounts/${o.bankId}/auto-match`);
    expect(res.body.data).toEqual({ matched: 1, remaining: 1 });
    const rows = await transactions(o.owner, o.bankId);
    expect(rows.find((r) => r.amount === '100.00')!.status).toBe('MATCHED');
    expect(rows.find((r) => r.amount === '60.00')!.status).toBe('UNMATCHED');
  });

  it('shows the bank register with a running balance and matched markers', async () => {
    const o = await bankOrg();
    await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await postJournal(o, cashSale(o, '40.00', '2026-03-18'));
    const res = await o.owner.get(`/banking/accounts/${o.bankId}/register`);
    expect(res.status).toBe(200);
    expect(
      res.body.data.items.map((i: { amount: string; runningBalance: string }) => [
        i.amount,
        i.runningBalance,
      ]),
    ).toEqual([
      ['40.00', '140.00'],
      ['100.00', '100.00'],
    ]);
    expect(
      (await o.owner.get(`/banking/accounts/${o.bankId}/register?unmatchedOnly=true`)).body.data
        .items,
    ).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Categorizing (bank entries)
// ---------------------------------------------------------------------------

describe('bank entries', () => {
  it('posts Dr expense / Cr bank through the accounting event and matches the transaction', async () => {
    const o = await bankOrg();
    await importCsv(o.owner, o.bankId, [['2026-03-20', 'Stationery shop', '-250.00']]);
    const [txn] = await transactions(o.owner, o.bankId);
    const before = await ledgerDigest(o.organizationId);
    const res = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
      memo: 'Stationery',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'BE-00001',
      direction: 'out',
      amount: '250.00',
      status: 'POSTED',
    });
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal.status).toBe('POSTED');
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['5400'], debit: '250.0000' }),
        expect.objectContaining({ accountId: o.accounts['1110'], credit: '250.0000' }),
      ]),
    );
    expect(journal.sourceDocument).toMatchObject({ documentType: 'entry', number: 'BE-00001' });
    expect(await ledgerDigest(o.organizationId)).not.toBe(before);
    const after = (await transactions(o.owner, o.bankId))[0]!;
    expect(after).toMatchObject({
      status: 'MATCHED',
      match: { source: 'entry', journalId: res.body.data.journalId },
    });
    // The entry's match is not undone by hand; the entry is voided instead.
    const unmatch = await o.owner.post(`/banking/transactions/${txn!.id}/unmatch`);
    expect(unmatch.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const again = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    expect(again.status).toBe(409);
    // A money-in line posts the other way.
    await importCsv(o.owner, o.bankId, [['2026-03-21', 'Interest', '12.00']]);
    const interest = (await transactions(o.owner, o.bankId)).find((t) => t.amount === '12.00')!;
    const inbound = await o.owner.post(`/banking/transactions/${interest.id}/categorize`, {
      categoryAccountId: o.accounts['4100'],
    });
    expect(inbound.body.data).toMatchObject({ number: 'BE-00002', direction: 'in' });
    const j2 = await journalOf(o, inbound.body.data.journalId);
    expect(j2.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1110'], debit: '12.0000' }),
        expect.objectContaining({ accountId: o.accounts['4100'], credit: '12.0000' }),
      ]),
    );
    expect(await auditActions(o, 'bank_entry', res.body.data.id)).toContain('bank_entry.posted');
  });

  it('refuses a control account, the bank account itself, another bank account and a closed period', async () => {
    const o = await bankOrg();
    const other = await o.owner.post('/banking/accounts', { accountId: o.accounts['1120'] });
    expect(other.status).toBe(201);
    await makeApControl(o);
    await importCsv(o.owner, o.bankId, [['2026-03-20', 'Move', '-10.00']]);
    const [txn] = await transactions(o.owner, o.bankId);
    for (const accountId of [o.accounts['2110'], o.accounts['1110'], o.accounts['1120']]) {
      const res = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
        categoryAccountId: accountId,
      });
      expect(res.status, accountId).toBe(400);
    }
    const period = o.periods.find((p) => p.startDate <= '2026-03-20' && p.endDate >= '2026-03-20')!;
    expect((await o.owner.post(`/accounting/periods/${period.id}/close`)).status).toBe(200);
    const closed = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    expect(closed.body.error.code).toBe('PERIOD_CLOSED');
    expect((await transactions(o.owner, o.bankId))[0]!.status).toBe('UNMATCHED');
  });

  it('replays an idempotent categorize and needs its own permission', async () => {
    const o = await bankOrg();
    await importCsv(o.owner, o.bankId, [['2026-03-20', 'Fee', '-8.00']]);
    const [txn] = await transactions(o.owner, o.bankId);
    const key = randomUUID();
    const body = { categoryAccountId: o.accounts['5400'] };
    const first = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, body, {
      'Idempotency-Key': key,
    });
    const replay = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, body, {
      'Idempotency-Key': key,
    });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    const { rows } = await owner.query(
      `SELECT count(*)::int AS n FROM banking_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(rows[0].n).toBe(1);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (await member.client.post(`/banking/transactions/${txn!.id}/categorize`, body)).status,
    ).toBe(403);
  });

  it('voids through Banking with re-authentication, freeing the transaction to be categorized again', async () => {
    const o = await bankOrg();
    await importCsv(o.owner, o.bankId, [['2026-03-20', 'Wrong category', '-60.00']]);
    const [txn] = await transactions(o.owner, o.bankId);
    const entry = (
      await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
        categoryAccountId: o.accounts['5400'],
      })
    ).body.data;
    // The generic journal reversal refuses a Banking journal.
    const generic = await o.owner.post(`/accounting/journals/${entry.journalId}/reverse`, {
      reason: 'Reverse it',
    });
    expect(generic.status).toBe(409);
    expect(generic.body.error.code).toBe('SYSTEM_JOURNAL');
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const stale = await o.owner.post(`/banking/entries/${entry.id}/void`, {
      version: entry.version,
      reason: 'Wrong',
    });
    expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    expect((await o.owner.reauthenticate()).status).toBe(200);
    const voided = await o.owner.post(`/banking/entries/${entry.id}/void`, {
      version: entry.version,
      reason: 'Wrong',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'VOID', voidReason: 'Wrong' });
    expect((await journalOf(o, entry.journalId)).status).toBe('REVERSED');
    expect((await transactions(o.owner, o.bankId))[0]).toMatchObject({
      status: 'UNMATCHED',
      match: null,
    });
    const second = await o.owner.post(`/banking/transactions/${txn!.id}/categorize`, {
      categoryAccountId: o.accounts['5500'] ?? o.accounts['5400'],
    });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.data.number).toBe('BE-00002');
    const again = await o.owner.post(`/banking/entries/${entry.id}/void`, {
      version: voided.body.data.version,
      reason: 'x',
    });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await auditActions(o, 'bank_entry', entry.id)).toEqual(
      expect.arrayContaining(['bank_entry.posted', 'bank_entry.voided']),
    );
  });
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

describe('transfers', () => {
  it('posts Dr destination / Cr source in the same currency, and voids by reversal', async () => {
    const o = await bankOrg();
    const second = await o.owner.post('/banking/accounts', {
      accountId: o.accounts['1120'],
      name: 'Savings',
    });
    const res = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: second.body.data.id,
      fromAmount: '300.00',
      memo: 'Top up',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      number: 'TR-00001',
      fromAmount: '300.00',
      toAmount: '300.00',
      status: 'POSTED',
    });
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: o.accounts['1120'], debit: '300.0000' }),
        expect.objectContaining({ accountId: o.accounts['1110'], credit: '300.0000' }),
      ]),
    );
    expect(journal.sourceDocument).toMatchObject({ documentType: 'transfer', number: 'TR-00001' });
    const same = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: o.bankId,
      fromAmount: '1',
    });
    expect(same.status).toBe(400);
    const mismatched = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: second.body.data.id,
      fromAmount: '10',
      toAmount: '11',
    });
    expect(mismatched.status).toBe(400);
    await reauth(o.owner);
    const voided = await o.owner.post(`/banking/transfers/${res.body.data.id}/void`, {
      version: res.body.data.version,
      reason: 'Entered twice',
    });
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    expect((await journalOf(o, res.body.data.journalId)).status).toBe('REVERSED');
    expect((await o.owner.get('/banking/transfers')).body.data.items).toHaveLength(1);
  });

  it('transfers between a foreign account and the base account at the implied rate', async () => {
    const o = await bankOrg();
    const usdId = await usdBank(o);
    const usd = (await o.owner.post('/banking/accounts', { accountId: usdId })).body.data
      .id as string;
    const noAmount = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: usd,
      fromAmount: '1542.00',
    });
    expect(noAmount.body.error.details.issues[0].path).toBe('toAmount');
    const res = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: usd,
      fromAmount: '1542.00',
      toAmount: '100.00',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      exchangeRateSource: 'implied',
      baseAmount: '1542.0000',
      fromAmount: '1542.00',
      toAmount: '100.00',
    });
    expect(Number(res.body.data.exchangeRate)).toBeCloseTo(15.42, 8);
    const journal = await journalOf(o, res.body.data.journalId);
    expect(journal.currency).toBe('USD');
    expect(journal.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: usdId, debit: '100.0000', baseDebit: '1542.0000' }),
        expect.objectContaining({
          accountId: o.accounts['1110'],
          credit: '100.0000',
          baseCredit: '1542.0000',
        }),
      ]),
    );
    // A same-currency foreign transfer needs a table rate.
    const usd2 = (
      await o.owner.post('/banking/accounts', {
        accountId: await usdBank(o, '1129'),
        name: 'USD two',
      })
    ).body.data.id;
    const noRate = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: usd,
      toBankingAccountId: usd2,
      fromAmount: '10.00',
    });
    expect(noRate.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    await o.owner.post('/accounting/exchange-rates', {
      fromCurrency: 'USD',
      rateDate: '2026-03-01',
      rate: '15.42',
    });
    const ok = await o.owner.post('/banking/transfers', {
      transferDate: '2026-03-20',
      fromBankingAccountId: usd,
      toBankingAccountId: usd2,
      fromAmount: '10.00',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({ exchangeRateSource: 'table', baseAmount: '154.2000' });
  });

  it('is permissioned and idempotent', async () => {
    const o = await bankOrg();
    const second = (await o.owner.post('/banking/accounts', { accountId: o.accounts['1120'] })).body
      .data.id;
    const body = {
      transferDate: '2026-03-20',
      fromBankingAccountId: o.bankId,
      toBankingAccountId: second,
      fromAmount: '5.00',
    };
    const key = randomUUID();
    const first = await o.owner.post('/banking/transfers', body, { 'Idempotency-Key': key });
    const replay = await o.owner.post('/banking/transfers', body, { 'Idempotency-Key': key });
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data.id).toBe(first.body.data.id);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.post('/banking/transfers', body)).status).toBe(403);
    expect((await o.owner.get('/banking/transfers')).body.data.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

describe('reconciliation', () => {
  it('completes only when the statement balances, without touching a posted journal line', async () => {
    const o = await bankOrg({ opening: '1000.00' });
    await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await importCsv(o.owner, o.bankId, [
      ['2026-03-16', 'Customer deposit', '100.00'],
      ['2026-03-20', 'Stationery shop', '-250.00'],
    ]);
    const rows = await transactions(o.owner, o.bankId);
    const deposit = rows.find((r) => r.amount === '100.00')!;
    const spend = rows.find((r) => r.amount === '-250.00')!;
    const preview = (statementBalance: string) =>
      o.owner.post(`/banking/accounts/${o.bankId}/reconciliation/preview`, {
        statementDate: '2026-03-31',
        statementBalance,
      });
    // Nothing is matched yet.
    const empty = await preview('850.00');
    expect(empty.body.data).toMatchObject({
      openingBalance: '1000.00',
      clearedTotal: '0.00',
      difference: '-150.00',
      unmatchedCount: 2,
      canComplete: false,
    });
    const lineId = (await o.owner.get(`/banking/transactions/${deposit.id}/suggestions`)).body.data
      .items[0].journalLineId;
    await o.owner.post(`/banking/transactions/${deposit.id}/match`, { journalLineId: lineId });
    await o.owner.post(`/banking/transactions/${spend.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    const full = await preview('850.00');
    expect(full.body.data).toMatchObject({
      clearedTotal: '-150.00',
      difference: '0.00',
      canComplete: true,
      unmatchedCount: 0,
    });
    expect(full.body.data.items).toHaveLength(2);
    const wrong = await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
      statementDate: '2026-03-31',
      statementBalance: '900.00',
    });
    expect(wrong.status).toBe(400);
    const digest = await ledgerDigest(o.organizationId);
    const done = await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
      statementDate: '2026-03-31',
      statementBalance: '850.00',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    expect(done.body.data).toMatchObject({
      status: 'COMPLETED',
      itemCount: 2,
      clearedTotal: '-150.00',
      openingBalance: '1000.00',
    });
    // Reconciling is not an accounting event.
    expect(await ledgerDigest(o.organizationId)).toBe(digest);
    // The next statement starts from this one.
    await importCsv(o.owner, o.bankId, [['2026-04-02', 'Deposit', '20.00']]);
    const next = await o.owner.post(`/banking/accounts/${o.bankId}/reconciliation/preview`, {
      statementDate: '2026-04-30',
      statementBalance: '850.00',
    });
    expect(next.body.data).toMatchObject({ openingBalance: '850.00', clearedTotal: '0.00' });
    // A reconciled transaction cannot be released or voided.
    const unmatch = await o.owner.post(`/banking/transactions/${deposit.id}/unmatch`);
    expect(unmatch.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const entry = (await o.owner.get('/banking/entries')).body.data.items[0];
    await reauth(o.owner);
    const voidEntry = await o.owner.post(`/banking/entries/${entry.id}/void`, {
      version: entry.version,
      reason: 'x',
    });
    expect(voidEntry.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // Not re-reconcilable for an earlier or the same date.
    const old = await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
      statementDate: '2026-03-31',
      statementBalance: '850.00',
    });
    expect(old.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(
      (await o.owner.get(`/banking/accounts/${o.bankId}/reconciliations`)).body.data.items,
    ).toHaveLength(1);
    const detail = (await o.owner.get(`/banking/reconciliations/${done.body.data.id}`)).body.data;
    expect(detail.items).toHaveLength(2);
    expect(await auditActions(o, 'bank_reconciliation', done.body.data.id)).toContain(
      'bank_reconciliation.completed',
    );
  });

  it('reopens only the latest reconciliation, with a reason and re-authentication', async () => {
    const o = await bankOrg({ opening: '0.00' });
    await importCsv(o.owner, o.bankId, [['2026-03-05', 'Fee', '-10.00']]);
    const txn = (await transactions(o.owner, o.bankId))[0]!;
    await o.owner.post(`/banking/transactions/${txn.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    const first = (
      await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
        statementDate: '2026-03-31',
        statementBalance: '-10.00',
      })
    ).body.data;
    await importCsv(o.owner, o.bankId, [['2026-04-05', 'Fee', '-4.00']]);
    const second = (await transactions(o.owner, o.bankId)).find((t) => t.amount === '-4.00')!;
    await o.owner.post(`/banking/transactions/${second.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    const latest = (
      await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
        statementDate: '2026-04-30',
        statementBalance: '-14.00',
      })
    ).body.data;
    await reauth(o.owner);
    const notLatest = await o.owner.post(`/banking/reconciliations/${first.id}/reopen`, {
      version: first.version,
      reason: 'Mistake',
    });
    expect(notLatest.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const reopened = await o.owner.post(`/banking/reconciliations/${latest.id}/reopen`, {
      version: latest.version,
      reason: 'Wrong statement',
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(reopened.body.data).toMatchObject({
      status: 'REOPENED',
      reopenReason: 'Wrong statement',
    });
    // Its transactions are free again; the earlier reconciliation now is the latest.
    expect((await o.owner.post(`/banking/transactions/${second.id}/unmatch`)).body.error.code).toBe(
      'INVALID_STATE_TRANSITION',
    ); // an entry match
    const retry = await o.owner.post(`/banking/accounts/${o.bankId}/reconciliations`, {
      statementDate: '2026-04-30',
      statementBalance: '-14.00',
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const stale = await o.owner.post(`/banking/reconciliations/${latest.id}/reopen`, {
      version: reopened.body.data.version,
      reason: 'Again',
    });
    expect(stale.body.error.code).toBe('INVALID_STATE_TRANSITION');
    // Without a recent password confirmation, reopening is refused.
    ctx.clock.advance(16 * MINUTE);
    await o.owner.get('/auth/session');
    const unauth = await o.owner.post(`/banking/reconciliations/${retry.body.data.id}/reopen`, {
      version: retry.body.data.version,
      reason: 'x',
    });
    expect(unauth.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
  });

  it('lists the transactions not yet reconciled', async () => {
    const o = await bankOrg();
    await importCsv(o.owner, o.bankId, [
      ['2026-03-05', 'A', '-10.00'],
      ['2026-03-06', 'B', '-20.00'],
    ]);
    const a = (await transactions(o.owner, o.bankId)).find((t) => t.amount === '-10.00')!;
    await o.owner.post(`/banking/transactions/${a.id}/categorize`, {
      categoryAccountId: o.accounts['5400'],
    });
    const res = await o.owner.get(`/banking/accounts/${o.bankId}/unreconciled`);
    expect(res.body.data.unmatched).toHaveLength(1);
    expect(res.body.data.matchedNotReconciled).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('categorization rules', () => {
  it('suggests a category for an unmatched transaction by priority, never posting by itself', async () => {
    const o = await bankOrg();
    const broad = await o.owner.post('/banking/rules', {
      name: 'Anything out',
      direction: 'out',
      categoryAccountId: o.accounts['5400'],
      priority: 200,
    });
    expect(broad.status, JSON.stringify(broad.body)).toBe(201);
    const specific = await o.owner.post('/banking/rules', {
      name: 'Fuel',
      descriptionContains: 'FUEL',
      maxAmount: '500',
      categoryAccountId: o.accounts['5500'] ?? o.accounts['5400'],
      priority: 10,
    });
    expect(specific.status).toBe(201);
    await importCsv(o.owner, o.bankId, [
      ['2026-03-05', 'Island Fuel Station', '-80.00'],
      ['2026-03-06', 'Other shop', '-20.00'],
      ['2026-03-07', 'Deposit', '30.00'],
    ]);
    const rows = await transactions(o.owner, o.bankId);
    expect(rows.find((r) => r.amount === '-80.00')!.suggestion).toMatchObject({ ruleName: 'Fuel' });
    expect(rows.find((r) => r.amount === '-20.00')!.suggestion).toMatchObject({
      ruleName: 'Anything out',
    });
    expect(rows.find((r) => r.amount === '30.00')!.suggestion).toBeNull();
    const { rows: journals } = await owner.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(journals[0].n).toBe(0);
    // Archiving a rule removes its suggestion; a rule needs a condition and a postable category.
    const archived = await o.owner.post(`/banking/rules/${broad.body.data.id}/archive`, {
      version: broad.body.data.version,
    });
    expect(archived.body.data.status).toBe('ARCHIVED');
    expect(
      (await transactions(o.owner, o.bankId)).find((r) => r.amount === '-20.00')!.suggestion,
    ).toBeNull();
    const noCondition = await o.owner.post('/banking/rules', {
      name: 'Empty',
      categoryAccountId: o.accounts['5400'],
    });
    expect(noCondition.status).toBe(400);
    await makeApControl(o);
    const control = await o.owner.post('/banking/rules', {
      name: 'Control',
      direction: 'in',
      categoryAccountId: o.accounts['2110'],
    });
    expect(control.status).toBe(400);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect(
      (
        await member.client.post('/banking/rules', {
          name: 'x',
          direction: 'in',
          categoryAccountId: o.accounts['5400'],
        })
      ).status,
    ).toBe(403);
    expect((await member.client.get('/banking/rules')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Database guards
// ---------------------------------------------------------------------------

describe('database guards', () => {
  it('keeps bank facts immutable and refuses a match with the wrong amount or account', async () => {
    const o = await bankOrg();
    const sale = await postJournal(o, cashSale(o, '100.00', '2026-03-15'));
    await importCsv(o.owner, o.bankId, [
      ['2026-03-16', 'Deposit', '100.00'],
      ['2026-03-16', 'Other', '55.00'],
    ]);
    const rows = await transactions(o.owner, o.bankId);
    const deposit = rows.find((r) => r.amount === '100.00')!;
    const other = rows.find((r) => r.amount === '55.00')!;
    await expect(
      owner.query(`UPDATE banking_transactions SET amount = 1 WHERE id = $1`, [deposit.id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      owner.query(`DELETE FROM banking_transactions WHERE id = $1`, [deposit.id]),
    ).rejects.toThrow(/never deleted/);
    const { rows: lines } = await owner.query(
      `SELECT id, account_id FROM accounting_journal_lines WHERE journal_id = $1`,
      [sale.id],
    );
    const cash = lines.find((l: { account_id: string }) => l.account_id === o.accounts['1110'])!
      .id as string;
    const revenue = lines.find((l: { account_id: string }) => l.account_id === o.accounts['4100'])!
      .id as string;
    const insert = (txn: string, line: string) =>
      owner.query(
        `INSERT INTO banking_matches (organization_id, banking_transaction_id, journal_id, journal_line_id, source, matched_by_user_id, matched_at)
         SELECT $1, $2, $3, $4, 'manual', created_by_user_id, now() FROM banking_accounts WHERE id = $5`,
        [o.organizationId, txn, sale.id, line, o.bankId],
      );
    await expect(insert(other.id, cash)).rejects.toThrow(/amount differs/);
    await expect(insert(deposit.id, revenue)).rejects.toThrow(/not on the bank account/);
    await insert(deposit.id, cash);
    await expect(
      owner.query(`DELETE FROM banking_matches WHERE journal_line_id = $1`, [cash]),
    ).rejects.toThrow(/never deleted/);
    await expect(
      owner.query(`UPDATE banking_matches SET journal_id = $1 WHERE journal_line_id = $2`, [
        randomUUID(),
        cash,
      ]),
    ).rejects.toThrow();
    // A line has one active match.
    await expect(insert(other.id, cash)).rejects.toThrow();
  });

  it('tenant-isolates every banking table through row level security', async () => {
    const a = await bankOrg();
    const b = await bankOrg();
    await importCsv(a.owner, a.bankId, [['2026-03-16', 'Deposit', '10.00']]);
    const client = await connectAs('app');
    try {
      await client.query(`SELECT set_config('app.organization_id', $1, false)`, [b.organizationId]);
      for (const table of [
        'banking_accounts',
        'banking_transactions',
        'banking_statement_imports',
      ]) {
        const { rows } = await client.query(`SELECT organization_id FROM ${table}`);
        expect(
          rows.every((r: { organization_id: string }) => r.organization_id === b.organizationId),
          table,
        ).toBe(true);
      }
    } finally {
      await client.end();
    }
  });
});
