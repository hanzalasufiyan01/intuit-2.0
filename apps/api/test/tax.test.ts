import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import { findRateOn, MIRA_VERIFICATION_NOTE } from '../src/modules/tax/index.js';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import {
  connectAs,
  createTestContext,
  MINUTE,
  type TestClient,
  type TestContext,
} from './helpers.js';

/** Phase 3B step 2: tax codes and effective-dated rates (Decisions 15, 33, 60; D4, D12). */

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(() => ctx.close());

interface TaxCodeView {
  id: string;
  code: string;
  name: string;
  taxAccountId: string;
  status: string;
  version: number;
  systemSeeded: boolean;
  rates: { id: string; rate: string; effectiveFrom: string; verificationNote: string | null }[];
}

async function codes(client: TestClient): Promise<TaxCodeView[]> {
  const res = await client.get('/tax/codes');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
}

async function createCode(org: AccountingOrg, body: object = {}) {
  const res = await org.owner.post('/tax/codes', {
    code: 'EXPORT',
    name: 'Zero-rated export',
    taxAccountId: org.accounts['2130'],
    rate: '0',
    effectiveFrom: '2026-01-01',
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as TaxCodeView;
}

async function createRole(owner: TestClient, name: string, permissionKeys: string[]) {
  const res = await owner.post('/organizations/current/roles', { name, permissionKeys });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
}

describe('Maldives localization seed (Decision 60, D4)', () => {
  it('seeds General GST 8% and Tourism GST 16% → 17%, marked for MIRA verification', async () => {
    const org = await setUpAccountingOrg(ctx);
    const seeded = await codes(org.owner);
    expect(seeded.map((c) => c.code)).toEqual(['GST', 'TGST']);
    const [gst, tgst] = seeded;
    for (const code of seeded) {
      expect(code).toMatchObject({
        taxAccountId: org.accounts['2130'],
        status: 'ACTIVE',
        systemSeeded: true,
      });
      for (const rate of code.rates) expect(rate.verificationNote).toBe(MIRA_VERIFICATION_NOTE);
    }
    expect(gst!.rates.map((r) => [r.rate, r.effectiveFrom])).toEqual([['8.0000', '2023-01-01']]);
    expect(tgst!.rates.map((r) => [r.rate, r.effectiveFrom])).toEqual([
      ['16.0000', '2023-01-01'],
      ['17.0000', '2025-07-01'],
    ]);

    // The version in effect on a date applies (Decision 15).
    const who = {
      organizationId: org.organizationId,
      userId: (await org.owner.get('/auth/session')).body.data.user.id,
    };
    const rateOn = (date: string) =>
      inTransaction(ctx.database.db, who, async (tx) => {
        await setDbContext(tx, who);
        return (await findRateOn(tx, org.organizationId, tgst!.id, date))?.rate ?? null;
      });
    expect(await rateOn('2022-12-31')).toBeNull();
    expect(await rateOn('2023-01-01')).toBe('16.0000');
    expect(await rateOn('2025-06-30')).toBe('16.0000');
    expect(await rateOn('2025-07-01')).toBe('17.0000');
    expect(await rateOn('2026-09-30')).toBe('17.0000');

    const owner = await connectAs('owner');
    try {
      const { rows } = await owner.query(
        `SELECT metadata FROM audit_events
          WHERE organization_id = $1 AND action = 'accounting.setup_completed'`,
        [org.organizationId],
      );
      expect(rows[0].metadata.taxCodesSeeded).toBe(2);
    } finally {
      await owner.end();
    }
  });

  it('seeds nothing for other charts of accounts', async () => {
    const org = await setUpAccountingOrg(ctx, { templateKey: 'uk', baseCurrency: 'GBP' });
    expect(await codes(org.owner)).toEqual([]);
  });
});

describe('tax code management', () => {
  it('creates, edits, archives and restores a code with version checks and audit', async () => {
    const org = await setUpAccountingOrg(ctx);
    const created = await createCode(org, { description: 'Exports of goods' });
    expect(created).toMatchObject({
      code: 'EXPORT',
      version: 1,
      systemSeeded: false,
      rates: [{ rate: '0.0000', effectiveFrom: '2026-01-01', verificationNote: null }],
    });
    const duplicate = await org.owner.post('/tax/codes', {
      code: 'EXPORT',
      name: 'Again',
      taxAccountId: org.accounts['2130'],
      rate: '0',
      effectiveFrom: '2026-01-01',
    });
    expect(duplicate.status).toBe(409);

    const renamed = await org.owner.patch(`/tax/codes/${created.id}`, {
      version: 1,
      name: 'Zero-rated',
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(renamed.body.data).toMatchObject({ name: 'Zero-rated', version: 2 });
    const stale = await org.owner.patch(`/tax/codes/${created.id}`, { version: 1, name: 'X' });
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');

    const archived = await org.owner.post(`/tax/codes/${created.id}/archive`, { version: 2 });
    expect(archived.body.data).toMatchObject({ status: 'ARCHIVED', version: 3 });
    const again = await org.owner.post(`/tax/codes/${created.id}/archive`, { version: 3 });
    expect(again.body.error.code).toBe('INVALID_STATE_TRANSITION');
    const restored = await org.owner.post(`/tax/codes/${created.id}/restore`, { version: 3 });
    expect(restored.body.data).toMatchObject({ status: 'ACTIVE', version: 4 });

    const owner = await connectAs('owner');
    try {
      const { rows } = await owner.query(
        `SELECT action FROM audit_events WHERE organization_id = $1 AND resource_id = $2
          ORDER BY occurred_at, id`,
        [org.organizationId, created.id],
      );
      expect(rows.map((r) => r.action).sort()).toEqual(
        ['tax_code.archived', 'tax_code.created', 'tax_code.restored', 'tax_code.updated'].sort(),
      );
    } finally {
      await owner.end();
    }
  });

  it('adds and removes rate versions; the last version stays', async () => {
    const org = await setUpAccountingOrg(ctx);
    const code = await createCode(org, { code: 'SVC', rate: '8', effectiveFrom: '2024-01-01' });
    const added = await org.owner.post(`/tax/codes/${code.id}/rates`, {
      rate: '12.5',
      effectiveFrom: '2027-01-01',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data.rates.map((r: { rate: string }) => r.rate)).toEqual([
      '8.0000',
      '12.5000',
    ]);
    const sameDay = await org.owner.post(`/tax/codes/${code.id}/rates`, {
      rate: '13',
      effectiveFrom: '2027-01-01',
    });
    expect(sameDay.status).toBe(409);
    for (const bad of ['100.1', '-1', '8.12345', 'abc']) {
      const res = await org.owner.post(`/tax/codes/${code.id}/rates`, {
        rate: bad,
        effectiveFrom: '2028-01-01',
      });
      expect(res.status, bad).toBe(400);
    }
    const [first, second] = added.body.data.rates;
    const removed = await org.owner.delete(`/tax/codes/${code.id}/rates/${second.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect(removed.body.data.rates).toHaveLength(1);
    const last = await org.owner.delete(`/tax/codes/${code.id}/rates/${first.id}`);
    expect(last.status).toBe(409);
  });

  it('requires an active, base-currency, non-control liability leaf as the tax account', async () => {
    const org = await setUpAccountingOrg(ctx);
    const attempt = (taxAccountId: string | undefined) =>
      org.owner.post('/tax/codes', {
        code: 'BAD',
        name: 'Bad',
        taxAccountId,
        rate: '8',
        effectiveFrom: '2026-01-01',
      });
    // Asset account, a parent (non-leaf) liability.
    for (const code of ['1140', '2100']) {
      const res = await attempt(org.accounts[code]);
      expect(res.status, code).toBe(400);
      expect(res.body.error.details.issues[0].path).toBe('taxAccountId');
    }
    const foreign = await org.owner.post('/accounting/accounts', {
      code: '2135',
      name: 'USD tax',
      type: 'LIABILITY',
      parentId: org.accounts['2100'],
      currencyCode: 'USD',
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(201);
    expect((await attempt(foreign.body.data.id)).status).toBe(400);

    const owner = await connectAs('owner');
    try {
      await owner.query(
        `UPDATE accounting_accounts SET is_control_account = true, control_subledger = 'sales' WHERE organization_id = $1 AND code = '2120'`,
        [org.organizationId],
      );
    } finally {
      await owner.end();
    }
    expect((await attempt(org.accounts['2120'])).status).toBe(400);
    expect((await attempt(org.accounts['2130'])).status).toBe(201);
  });

  it('rejects unknown fields and malformed codes', async () => {
    const org = await setUpAccountingOrg(ctx);
    const base = {
      code: 'OK',
      name: 'Ok',
      taxAccountId: org.accounts['2130'],
      rate: '8',
      effectiveFrom: '2026-01-01',
    };
    expect((await org.owner.post('/tax/codes', { ...base, extra: 1 })).status).toBe(400);
    expect((await org.owner.post('/tax/codes', { ...base, code: 'lower' })).status).toBe(400);
    expect(
      (await org.owner.post('/tax/codes', { ...base, effectiveFrom: '2026/01/01' })).status,
    ).toBe(400);
  });
});

describe('tax permissions and re-authentication (D12)', () => {
  it('lets Sales viewers read codes and only tax.codes.manage change them', async () => {
    const org = await setUpAccountingOrg(ctx);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await codes(member.client)).map((c) => c.code)).toEqual(['GST', 'TGST']);
    const denied = await member.client.post('/tax/codes', {
      code: 'M',
      name: 'M',
      taxAccountId: org.accounts['2130'],
      rate: '1',
      effectiveFrom: '2026-01-01',
    });
    expect(denied.status).toBe(403);

    await createRole(org.owner, 'Ledger only', ['accounting.accounts.view']);
    const ledger = await joinWithRole(ctx, org.owner, 'Ledger only');
    expect((await ledger.client.get('/tax/codes')).status).toBe(403);

    await createRole(org.owner, 'Tax admin', ['tax.codes.manage']);
    const taxAdmin = await joinWithRole(ctx, org.owner, 'Tax admin');
    const tgst = (await codes(taxAdmin.client)).find((c) => c.code === 'TGST')!;
    const added = await taxAdmin.client.post(`/tax/codes/${tgst.id}/rates`, {
      rate: '18',
      effectiveFrom: '2027-01-01',
    });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
  });

  it('requires a recent password confirmation for every change', async () => {
    const org = await setUpAccountingOrg(ctx);
    const gst = (await codes(org.owner)).find((c) => c.code === 'GST')!;
    ctx.clock.advance(16 * MINUTE);
    await org.owner.get('/auth/session');
    const attempts = [
      () =>
        org.owner.post('/tax/codes', {
          code: 'LATE',
          name: 'Late',
          taxAccountId: org.accounts['2130'],
          rate: '1',
          effectiveFrom: '2026-01-01',
        }),
      () => org.owner.patch(`/tax/codes/${gst.id}`, { version: 1, name: 'General' }),
      () => org.owner.post(`/tax/codes/${gst.id}/archive`, { version: 1 }),
      () =>
        org.owner.post(`/tax/codes/${gst.id}/rates`, { rate: '9', effectiveFrom: '2027-01-01' }),
      () => org.owner.delete(`/tax/codes/${gst.id}/rates/${gst.rates[0]!.id}`),
    ];
    for (const attempt of attempts) {
      const res = await attempt();
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
    }
    // Reading needs no confirmation.
    expect((await org.owner.get('/tax/codes')).status).toBe(200);
    await org.owner.reauthenticate();
    expect((await attempts[1]!()).status).toBe(200);
  });
});

describe('database protections', () => {
  it('isolates tenants, never deletes codes and keeps rate versions immutable', async () => {
    const org = await setUpAccountingOrg(ctx);
    const other = await setUpAccountingOrg(ctx);
    const [gst] = await codes(org.owner);
    const app = await connectAs('app');
    try {
      const inTenant = async (organizationId: string, statement: string) => {
        await app.query('BEGIN');
        try {
          await app.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
          return await app.query(statement);
        } finally {
          await app.query('ROLLBACK');
        }
      };
      const hidden = await inTenant(
        other.organizationId,
        `SELECT count(*)::int AS n FROM tax_codes WHERE id = '${gst!.id}'`,
      );
      expect(hidden.rows[0].n).toBe(0);
      await expect(
        inTenant(org.organizationId, `DELETE FROM tax_codes WHERE id = '${gst!.id}'`),
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        inTenant(org.organizationId, `UPDATE tax_codes SET code = 'VAT' WHERE id = '${gst!.id}'`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        inTenant(
          org.organizationId,
          `UPDATE tax_code_rates SET rate = 9 WHERE tax_code_id = '${gst!.id}'`,
        ),
      ).rejects.toThrow();
      await expect(
        inTenant(
          other.organizationId,
          `INSERT INTO tax_code_rates (organization_id, tax_code_id, rate, effective_from, created_at)
           VALUES ('${other.organizationId}', '${gst!.id}', 5, '2030-01-01', now())`,
        ),
      ).rejects.toThrow();
    } finally {
      await app.end();
    }
  });
});
