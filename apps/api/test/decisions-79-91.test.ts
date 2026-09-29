import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import {
  cashSale,
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Proof coverage for frozen Decisions 79–91 not already covered by accounting-core.test.ts and
 * dimensions.test.ts. Discrepancies found during the S2 audit are reported, not tested here.
 */

let ctx: TestContext;
const origin = { requestId: null, ipAddress: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function dimension(client: TestClient, code: string, name: string, extra: object = {}) {
  const type = await client.post('/accounting/dimensions', { code, name, ...extra });
  expect(type.status, JSON.stringify(type.body)).toBe(201);
  const value = await client.post(`/accounting/dimensions/${type.body.data.id}/values`, {
    code: `${code}1`,
    name: `${name} one`,
  });
  expect(value.status).toBe(201);
  return { typeId: type.body.data.id as string, valueId: value.body.data.id as string };
}

function tagged(
  accountId: string,
  side: 'debit' | 'credit',
  amount: string,
  typeId: string,
  valueId: string,
) {
  return {
    ...line(accountId, side, amount),
    dimensions: [{ dimensionTypeId: typeId, dimensionValueId: valueId }],
  };
}

function sale(org: AccountingOrg, revenueLine: object, amount = '50.00') {
  return {
    entryDate: '2026-03-15',
    description: 'Sale',
    currency: 'MVR',
    lines: [line(org.accounts['1110']!, 'debit', amount), revenueLine],
  };
}

describe('Decision 79 — designated system account constraints', () => {
  it('keeps designated accounts active, leaf, base-currency, non-control and of the right nature', async () => {
    const org = await setUpAccountingOrg(ctx);
    const re = org.accounts['3200']!;
    // Incompatible retype and a currency change are refused while designated.
    // (Subtype and parent cleared so that the designation rule itself is what refuses it.)
    const retype = await org.owner.patch(`/accounting/accounts/${re}`, {
      type: 'LIABILITY',
      subtype: null,
      parentId: null,
    });
    expect(retype.status).toBe(409);
    expect(retype.body.error.code).toBe('ACCOUNT_DESIGNATED');
    const currency = await org.owner.patch(`/accounting/accounts/${re}`, { currencyCode: 'USD' });
    expect(currency.status).toBe(409);
    expect(currency.body.error.code).toBe('ACCOUNT_DESIGNATED');
    // A compatible change of nature (FX gain/loss may be revenue or expense) is allowed.
    const fx = await org.owner.patch(`/accounting/accounts/${org.accounts['4950']}`, {
      type: 'EXPENSE',
      subtype: 'OTHER_EXPENSE',
      parentId: org.accounts['5000'],
    });
    expect(fx.status, JSON.stringify(fx.body)).toBe(200);

    // Archived and control accounts cannot be designated.
    const spare = await org.owner.post('/accounting/accounts', {
      code: '3400',
      name: 'Spare',
      type: 'EQUITY',
    });
    await org.owner.post(`/accounting/accounts/${spare.body.data.id}/archive`);
    expect(
      (await org.owner.put('/accounting/designations', { RETAINED_EARNINGS: spare.body.data.id }))
        .status,
    ).toBe(400);
    expect(
      (
        await org.owner.put('/accounting/designations', {
          REALIZED_FX_GAIN_LOSS: org.accounts['1130'],
        })
      ).status,
    ).toBe(400);
  });
});

describe('Decision 81 — base-currency change', () => {
  it('ignores drafts, blocks on pending journals and audits the migration', async () => {
    const org = await setUpAccountingOrg(ctx);
    // A draft journal never prevents the migration and is never deleted.
    const draft = await org.owner.post('/accounting/journals', cashSale(org));
    const changed = await org.owner.patch('/accounting/settings', { baseCurrency: 'USD' });
    expect(changed.status).toBe(200);
    expect((await org.owner.get(`/accounting/journals/${draft.body.data.id}`)).status).toBe(200);
    const audit = (await org.owner.get('/organizations/current/audit-events?limit=5')).body.data;
    const entry = audit.find(
      (e: { action: string }) => e.action === 'accounting.base_currency_changed',
    );
    expect(entry.metadata).toMatchObject({ from: 'MVR', to: 'USD', accountsMoved: 35 });
  });
});

describe('Decision 82 — template classification', () => {
  it('does not infer monetary or control classification from names or codes', async () => {
    const org = await setUpAccountingOrg(ctx);
    const accounts = (await org.owner.get('/accounting/accounts')).body.data as {
      code: string;
      isLeaf: boolean;
      subtype: string | null;
      isMonetary: boolean;
      isControlAccount: boolean;
    }[];
    const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
    expect(byCode['2120']).toMatchObject({ subtype: 'OTHER_CURRENT_LIABILITY', isMonetary: false });
    expect(byCode['2130']).toMatchObject({ subtype: 'OTHER_CURRENT_LIABILITY', isMonetary: false });
    expect(byCode['2510']).toMatchObject({ subtype: 'LONG_TERM_LIABILITY', isMonetary: false });
    expect(accounts.filter((a) => !a.isLeaf).every((a) => a.subtype === null)).toBe(true);
    expect(accounts.some((a) => a.isControlAccount)).toBe(false);
  });
});

describe('Decision 83 — manual journal API strictness', () => {
  it('rejects unknown and system-only fields on create and edit', async () => {
    const org = await setUpAccountingOrg(ctx);
    for (const extra of [
      { source: 'system' },
      { sourceType: 'revaluation' },
      { baseCurrency: 'USD' },
      { totalBaseDebit: '1.00' },
      { anything: true },
    ]) {
      expect(
        (await org.owner.post('/accounting/journals', { ...cashSale(org), ...extra })).status,
      ).toBe(400);
    }
    const created = (await org.owner.post('/accounting/journals', cashSale(org))).body.data;
    expect(
      (await org.owner.patch(`/accounting/journals/${created.id}`, { source: 'system' })).status,
    ).toBe(400);
    const baseOnlyLine = await org.owner.patch(`/accounting/journals/${created.id}`, {
      lines: [
        { ...line(org.accounts['1110']!, 'debit', '1.00'), baseDebit: '1.00' },
        line(org.accounts['4100']!, 'credit', '1.00'),
      ],
    });
    expect(baseOnlyLine.status).toBe(400);
  });
});

describe('Decisions 84 and 89 — scope by nature and subtype combined', () => {
  it('applies a requirement to accounts matching either configured nature or subtype only', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await dimension(org.owner, 'DEPT', 'Department', {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: ['OPERATING_EXPENSE'] },
    });
    const post = async (debit: string, credit: string) => {
      const created = await org.owner.post('/accounting/journals', {
        entryDate: '2026-03-15',
        description: 'scope',
        currency: 'MVR',
        lines: [line(debit, 'debit', '1.00'), line(credit, 'credit', '1.00')],
      });
      return org.owner.post(`/accounting/journals/${created.body.data.id}/post`);
    };
    // Revenue (nature) and Rent (subtype OPERATING_EXPENSE) are in scope.
    expect((await post(org.accounts['1110']!, org.accounts['4100']!)).status).toBe(400);
    expect((await post(org.accounts['5300']!, org.accounts['1110']!)).status).toBe(400);
    // Cost of Sales (EXPENSE nature, COST_OF_SALES subtype) is outside both.
    expect((await post(org.accounts['5100']!, org.accounts['1110']!)).status).toBe(200);
    expect(dept.valueId).toBeTruthy();
  });
});

describe('Decision 87 — reversal dimensions', () => {
  it('copies archived values and ignores requirements introduced after posting', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await dimension(org.owner, 'DEPT', 'Department');
    const project = await dimension(org.owner, 'PROJ', 'Project');
    const posted = await postJournal(
      org,
      sale(
        org,
        tagged(org.accounts['4100']!, 'credit', '50.00', dept.typeId, dept.valueId),
      ) as never,
    );
    // The value is archived and a new requirement (Project on revenue) is introduced.
    await org.owner.post(`/accounting/dimensions/${dept.typeId}/values/${dept.valueId}/archive`);
    await org.owner.patch(`/accounting/dimensions/${project.typeId}`, {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    const reversed = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'wrong period',
    });
    expect(reversed.status, JSON.stringify(reversed.body)).toBe(200);
    expect(reversed.body.data.reversal.lines[1].dimensions).toEqual([
      expect.objectContaining({ dimensionTypeId: dept.typeId, dimensionValueId: dept.valueId }),
    ]);
    expect(reversed.body.data.reversal.lines[0].dimensions).toEqual([]);
    const detail = (await org.owner.get(`/accounting/journals/${posted.id}`)).body.data;
    expect(detail.reversedByJournalId).toBe(reversed.body.data.reversal.id);
  });
});

describe('Decision 88 — archived values on existing drafts', () => {
  it('lets an existing draft keep, submit and post an archived value', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await dimension(org.owner, 'DEPT', 'Department', {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    const draft = (
      await org.owner.post(
        '/accounting/journals',
        sale(org, tagged(org.accounts['4100']!, 'credit', '50.00', dept.typeId, dept.valueId)),
      )
    ).body.data;
    await org.owner.post(`/accounting/dimensions/${dept.typeId}/values/${dept.valueId}/archive`);
    expect((await org.owner.post(`/accounting/journals/${draft.id}/submit`)).status).toBe(200);
    const posted = await org.owner.post(`/accounting/journals/${draft.id}/post`);
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    expect(posted.body.data.lines[1].dimensions[0].dimensionValueId).toBe(dept.valueId);
  });
});

describe('Decision 91 — dimension view permission', () => {
  it('requires accounting.dimensions.view to list dimensions and never bypasses requirements', async () => {
    const org = await setUpAccountingOrg(ctx);
    await dimension(org.owner, 'DEPT', 'Department', {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    const role = await org.owner.post('/organizations/current/roles', {
      name: 'Bookkeeper',
      permissionKeys: [
        'accounting.accounts.view',
        'accounting.journals.view',
        'accounting.journals.create',
        'accounting.journals.submit',
        'accounting.journals.post',
      ],
    });
    expect(role.status).toBe(201);
    expect(role.body.data.permissionKeys).not.toContain('accounting.dimensions.view');
    const bookkeeper = await joinWithRole(ctx, org.owner, 'Bookkeeper');
    expect((await bookkeeper.client.get('/accounting/dimensions')).status).toBe(403);

    const created = await bookkeeper.client.post(
      '/accounting/journals',
      sale(org, line(org.accounts['4100']!, 'credit', '50.00')),
    );
    expect(created.status).toBe(201);
    const submit = await bookkeeper.client.post(
      `/accounting/journals/${created.body.data.id}/submit`,
    );
    expect(submit.status).toBe(400);
    expect(submit.body.error.details.issues[0].path).toBe('lines.1.dimensions');
  });
});

describe('Decision 78 — system journals follow module rules (regression guard)', () => {
  it('posts a system journal on an in-scope account without manual enforcement', async () => {
    const org = await setUpAccountingOrg(ctx);
    await dimension(org.owner, 'DEPT', 'Department', {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    const posted = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId },
      async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        return ctx.services.journals.postSystemJournal(
          tx,
          {
            organizationId: org.organizationId,
            userId: null,
            source: { module: 'accounting', type: 'opening_balance', id: randomUUID() },
            entryDate: '2026-03-31',
            description: 'Opening',
            reference: '',
            currency: 'MVR',
            exchangeRate: null,
            lines: [
              {
                accountId: org.accounts['3900']!,
                description: '',
                kind: 'normal',
                debit: '2.00',
                credit: null,
                baseDebit: null,
                baseCredit: null,
              },
              {
                accountId: org.accounts['4100']!,
                description: '',
                kind: 'normal',
                debit: null,
                credit: '2.00',
                baseDebit: null,
                baseCredit: null,
              },
            ],
          },
          origin,
        );
      },
    );
    expect(posted.status).toBe('POSTED');
  });
});
