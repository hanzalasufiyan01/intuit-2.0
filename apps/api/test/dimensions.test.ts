import { randomInt, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction, setDbContext } from '../src/application/unit-of-work.js';
import {
  joinWithRole,
  line,
  postJournal,
  setUpAccountingOrg,
  type AccountingOrg,
} from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Phase 3A S2 — dimensions (Decisions 3, 16, 55, 67, 78, 84, 85, 86): generic types, values and
 * journal-line assignments; required dimensions by account-classification scope, enforced at
 * submission and again at posting; posted assignments immutable; tenant isolation; reporting
 * filters with the "tagged activity only" indication.
 */

let ctx: TestContext;
const origin = { requestId: null, ipAddress: null, userAgent: null };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

interface DimType {
  id: string;
  code: string;
  isRequired: boolean;
  scope: { accountTypes: string[]; accountSubtypes: string[] };
  values: { id: string; code: string; status: string }[];
}

async function createType(client: TestClient, body: Record<string, unknown>): Promise<DimType> {
  const response = await client.post('/accounting/dimensions', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data;
}

async function createValue(client: TestClient, typeId: string, code: string, name = code) {
  const response = await client.post(`/accounting/dimensions/${typeId}/values`, { code, name });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** Department (optional until configured) with values SALES and OPS. */
async function department(org: AccountingOrg, extra: Record<string, unknown> = {}) {
  const type = await createType(org.owner, { code: 'DEPT', name: 'Department', ...extra });
  const sales = await createValue(org.owner, type.id, 'SALES', 'Sales');
  const ops = await createValue(org.owner, type.id, 'OPS', 'Operations');
  return { type, sales, ops };
}

function tagged(
  accountId: string,
  side: 'debit' | 'credit',
  amount: string,
  dims: [string, string][],
) {
  return {
    ...line(accountId, side, amount),
    dimensions: dims.map(([dimensionTypeId, dimensionValueId]) => ({
      dimensionTypeId,
      dimensionValueId,
    })),
  };
}

function saleBody(org: AccountingOrg, revenueLine: object, amount = '100.00') {
  return {
    entryDate: '2026-03-15',
    description: 'Sale',
    currency: 'MVR',
    lines: [line(org.accounts['1110']!, 'debit', amount), revenueLine],
  };
}

async function draft(org: AccountingOrg, body: object) {
  const response = await org.owner.post('/accounting/journals', body);
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data as { id: string; lines: { dimensions: unknown[] }[] };
}

async function asApp<T>(organizationId: string, work: (db: pg.Client) => Promise<T>): Promise<T> {
  const db = await connectAs('app');
  try {
    await db.query('BEGIN');
    await db.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
    return await work(db);
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
}

describe('dimension configuration', () => {
  it('creates generic types and values with audit, uniqueness and strict schemas', async () => {
    const org = await setUpAccountingOrg(ctx);
    const project = await createType(org.owner, {
      code: 'PROJ',
      name: 'Project',
      description: 'Client projects',
    });
    expect(project).toMatchObject({
      isRequired: false,
      scope: { accountTypes: [], accountSubtypes: [] },
      status: 'ACTIVE',
    });
    // Any number of custom types; none is hard-coded.
    await createType(org.owner, { code: 'BR', name: 'Branch' });
    await createType(org.owner, { code: 'CC', name: 'Cost Center' });

    expect(
      (await org.owner.post('/accounting/dimensions', { code: 'PROJ', name: 'Other' })).status,
    ).toBe(409);
    expect(
      (await org.owner.post('/accounting/dimensions', { code: 'P2', name: 'project' })).status,
    ).toBe(409);
    expect(
      (
        await org.owner.post('/accounting/dimensions', {
          code: 'X',
          name: 'X',
          organizationId: randomUUID(),
        })
      ).status,
    ).toBe(400);

    const alpha = await createValue(org.owner, project.id, 'ALPHA', 'Alpha');
    expect(
      (
        await org.owner.post(`/accounting/dimensions/${project.id}/values`, {
          code: 'ALPHA',
          name: 'Again',
        })
      ).status,
    ).toBe(409);
    const renamed = await org.owner.patch(`/accounting/dimensions/${project.id}/values/${alpha}`, {
      name: 'Alpha Resort',
    });
    expect(renamed.body.data).toMatchObject({ name: 'Alpha Resort' });

    const list = (await org.owner.get('/accounting/dimensions')).body.data as DimType[];
    expect(list.map((t) => t.code)).toEqual(['BR', 'CC', 'PROJ']);
    expect(list.find((t) => t.code === 'PROJ')!.values).toHaveLength(1);

    const audit = (await org.owner.get('/organizations/current/audit-events?limit=20')).body
      .data as { action: string }[];
    const actions = audit.map((e) => e.action);
    for (const action of [
      'dimension_type.created',
      'dimension_value.created',
      'dimension_value.updated',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('configures required state and account scope, audited as affecting posting', async () => {
    const org = await setUpAccountingOrg(ctx);
    const { type } = await department(org);
    const updated = await org.owner.patch(`/accounting/dimensions/${type.id}`, {
      isRequired: true,
      scope: { accountTypes: ['REVENUE', 'EXPENSE'], accountSubtypes: [] },
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.data).toMatchObject({
      isRequired: true,
      scope: { accountTypes: ['REVENUE', 'EXPENSE'], accountSubtypes: [] },
    });
    const badScope = await org.owner.patch(`/accounting/dimensions/${type.id}`, {
      scope: { accountTypes: ['INCOME'], accountSubtypes: [] },
    });
    expect(badScope.status).toBe(400);

    const audit = (await org.owner.get('/organizations/current/audit-events?limit=5')).body.data;
    const entry = audit.find((e: { action: string }) => e.action === 'dimension_type.updated');
    expect(entry.metadata).toMatchObject({
      affectsPosting: true,
      before: { isRequired: false, scopeAccountTypes: [] },
      after: { isRequired: true, scopeAccountTypes: ['REVENUE', 'EXPENSE'] },
    });
  });

  it('require accounting.dimensions.manage to change and .view to read', async () => {
    const org = await setUpAccountingOrg(ctx);
    const { type } = await department(org);
    const member = await joinWithRole(ctx, org.owner, 'Member');
    expect((await member.client.get('/accounting/dimensions')).status).toBe(200);
    expect(
      (await member.client.post('/accounting/dimensions', { code: 'X', name: 'X' })).status,
    ).toBe(403);
    expect(
      (await member.client.patch(`/accounting/dimensions/${type.id}`, { isRequired: true })).status,
    ).toBe(403);
    expect(
      (
        await member.client.post(`/accounting/dimensions/${type.id}/values`, {
          code: 'Y',
          name: 'Y',
        })
      ).status,
    ).toBe(403);
    const admin = await joinWithRole(ctx, org.owner, 'Administrator');
    expect(
      (
        await admin.client.post(`/accounting/dimensions/${type.id}/values`, {
          code: 'HR',
          name: 'HR',
        })
      ).status,
    ).toBe(201);
  });
});

describe('journal-line assignments', () => {
  it('assigns one value per type per line and shows them on the journal', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const project = await createType(org.owner, { code: 'PROJ', name: 'Project' });
    const alpha = await createValue(org.owner, project.id, 'ALPHA');
    const journal = await draft(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '100.00', [
          [dept.type.id, dept.sales],
          [project.id, alpha],
        ]),
      ),
    );
    expect(journal.lines[1]!.dimensions).toEqual([
      expect.objectContaining({ typeCode: 'DEPT', valueCode: 'SALES' }),
      expect.objectContaining({ typeCode: 'PROJ', valueCode: 'ALPHA' }),
    ]);
    expect(journal.lines[0]!.dimensions).toEqual([]);

    const twice = await org.owner.post(
      '/accounting/journals',
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '100.00', [
          [dept.type.id, dept.sales],
          [dept.type.id, dept.ops],
        ]),
      ),
    );
    expect(twice.status).toBe(400);
    expect(JSON.stringify(twice.body)).toContain('only one value per dimension type');

    const mismatched = await org.owner.post(
      '/accounting/journals',
      saleBody(org, tagged(org.accounts['4100']!, 'credit', '100.00', [[project.id, dept.sales]])),
    );
    expect(mismatched.status).toBe(400);

    // Editing a draft without sending lines keeps its assignments.
    const edited = await org.owner.patch(`/accounting/journals/${journal.id}`, {
      description: 'Renamed',
    });
    expect(edited.body.data.lines[1].dimensions).toHaveLength(2);

    // The database enforces one value per type per line as well.
    await asApp(org.organizationId, async (db) => {
      const { rows } = await db.query(
        `SELECT id FROM accounting_journal_lines WHERE journal_id = $1 AND line_number = 2`,
        [journal.id],
      );
      await expect(
        db.query(
          `INSERT INTO accounting_journal_line_dimensions
             (organization_id, journal_line_id, dimension_type_id, dimension_value_id)
           VALUES ($1, $2, $3, $4)`,
          [org.organizationId, rows[0].id, dept.type.id, dept.ops],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('never assigns archived values or types anew, but keeps existing draft assignments', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const journal = await draft(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '10.00', [[dept.type.id, dept.ops]]),
        '10.00',
      ),
    );
    expect(
      (await org.owner.post(`/accounting/dimensions/${dept.type.id}/values/${dept.ops}/archive`))
        .status,
    ).toBe(200);

    const fresh = await org.owner.post(
      '/accounting/journals',
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '10.00', [[dept.type.id, dept.ops]]),
        '10.00',
      ),
    );
    expect(fresh.status).toBe(400);
    expect(JSON.stringify(fresh.body)).toContain('archived');

    // The existing draft may keep (and still post) its assignment.
    const kept = await org.owner.patch(`/accounting/journals/${journal.id}`, {
      lines: [
        line(org.accounts['1110']!, 'debit', '10.00'),
        tagged(org.accounts['4100']!, 'credit', '10.00', [[dept.type.id, dept.ops]]),
      ],
    });
    expect(kept.status, JSON.stringify(kept.body)).toBe(200);
    expect((await org.owner.post(`/accounting/journals/${journal.id}/post`)).status).toBe(200);

    // Archived type: none of its values can be newly assigned; restoring allows it again.
    await org.owner.post(`/accounting/dimensions/${dept.type.id}/archive`);
    const archivedType = await org.owner.post(
      '/accounting/journals',
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '10.00', [[dept.type.id, dept.sales]]),
        '10.00',
      ),
    );
    expect(archivedType.status).toBe(400);
    expect(
      (
        await org.owner.post(`/accounting/dimensions/${dept.type.id}/values`, {
          code: 'NEW',
          name: 'New',
        })
      ).status,
    ).toBe(400);
    await org.owner.post(`/accounting/dimensions/${dept.type.id}/restore`);
    expect(
      (
        await org.owner.post(
          '/accounting/journals',
          saleBody(
            org,
            tagged(org.accounts['4100']!, 'credit', '10.00', [[dept.type.id, dept.sales]]),
            '10.00',
          ),
        )
      ).status,
    ).toBe(201);

    const actions = (
      (await org.owner.get('/organizations/current/audit-events?limit=30')).body.data as {
        action: string;
      }[]
    ).map((e) => e.action);
    for (const action of [
      'dimension_value.archived',
      'dimension_type.archived',
      'dimension_type.restored',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('are line-level only for manual journals: header dimensions are rejected (Decision 85)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const withHeader = await org.owner.post('/accounting/journals', {
      ...saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')),
      dimensions: [{ dimensionTypeId: dept.type.id, dimensionValueId: dept.sales }],
    });
    expect(withHeader.status).toBe(400);
    const journal = await draft(
      org,
      saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')),
    );
    const patchHeader = await org.owner.patch(`/accounting/journals/${journal.id}`, {
      dimensions: [{ dimensionTypeId: dept.type.id, dimensionValueId: dept.sales }],
    });
    expect(patchHeader.status).toBe(400);
  });

  it('makes posted assignments immutable, even through forged SQL', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const posted = await postJournal(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '100.00', [[dept.type.id, dept.sales]]),
      ) as never,
    );
    await asApp(org.organizationId, async (db) => {
      const { rows } = await db.query(
        `SELECT l.id FROM accounting_journal_lines l WHERE l.journal_id = $1 ORDER BY line_number`,
        [posted.id],
      );
      const attempts: [string, unknown[]][] = [
        [
          `UPDATE accounting_journal_line_dimensions SET dimension_value_id = $2 WHERE journal_line_id = $1`,
          [rows[1].id, dept.ops],
        ],
        [`DELETE FROM accounting_journal_line_dimensions WHERE journal_line_id = $1`, [rows[1].id]],
        [
          `INSERT INTO accounting_journal_line_dimensions
             (organization_id, journal_line_id, dimension_type_id, dimension_value_id)
           VALUES ($1, $2, $3, $4)`,
          [org.organizationId, rows[0].id, dept.type.id, dept.ops],
        ],
      ];
      for (const [text, params] of attempts) {
        await db.query('SAVEPOINT a');
        await expect(db.query(text, params)).rejects.toMatchObject({ code: '42501' });
        await db.query('ROLLBACK TO SAVEPOINT a');
      }
    });
    const owner = await connectAs('owner');
    try {
      await expect(
        owner.query('TRUNCATE accounting_journal_line_dimensions'),
      ).rejects.toMatchObject({
        code: '42501',
      });
    } finally {
      await owner.end();
    }
  });

  it('are copied to reversal journals so tagged activity nets to zero', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const posted = await postJournal(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '40.00', [[dept.type.id, dept.sales]]),
        '40.00',
      ) as never,
    );
    const reversed = await org.owner.post(`/accounting/journals/${posted.id}/reverse`, {
      reason: 'wrong department',
    });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.reversal.lines[1].dimensions).toEqual([
      expect.objectContaining({ dimensionValueId: dept.sales }),
    ]);
    const ledger = await org.owner.get(
      `/accounting/ledger?accountId=${org.accounts['4100']}&dimensionValueIds=${dept.sales}`,
    );
    expect(ledger.body.data.totals).toEqual({ baseDebit: '40.0000', baseCredit: '40.0000' });
  });
});

describe('required dimensions (Decisions 55, 67, 78, 84, 86)', () => {
  async function requiredDepartment(org: AccountingOrg, scope: object) {
    const dept = await department(org);
    const res = await org.owner.patch(`/accounting/dimensions/${dept.type.id}`, {
      isRequired: true,
      scope,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return dept;
  }

  it('apply to in-scope accounts only, and block submission and posting when missing', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await requiredDepartment(org, {
      accountTypes: ['REVENUE', 'EXPENSE'],
      accountSubtypes: [],
    });
    // Drafts may be incomplete.
    const missing = await draft(
      org,
      saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')),
    );

    const submit = await org.owner.post(`/accounting/journals/${missing.id}/submit`);
    expect(submit.status).toBe(400);
    expect(submit.body.error.details.issues).toEqual([
      { path: 'lines.1.dimensions', message: 'Department is required for this account.' },
    ]);
    const post = await org.owner.post(`/accounting/journals/${missing.id}/post`);
    expect(post.status).toBe(400);
    expect(post.body.error.details.issues[0].path).toBe('lines.1.dimensions');

    // No guessing: the failed attempts assigned nothing (Department has two values, but the
    // outcome would be the same with one).
    const after = (await org.owner.get(`/accounting/journals/${missing.id}`)).body.data;
    expect(after.status).toBe('DRAFT');
    expect(after.lines.every((l: { dimensions: unknown[] }) => l.dimensions.length === 0)).toBe(
      true,
    );

    // The cash line (ASSET, out of scope) needs nothing; tagging the revenue line suffices.
    const complete = await org.owner.patch(`/accounting/journals/${missing.id}`, {
      lines: [
        line(org.accounts['1110']!, 'debit', '100.00'),
        tagged(org.accounts['4100']!, 'credit', '100.00', [[dept.type.id, dept.sales]]),
      ],
    });
    expect(complete.status).toBe(200);
    expect((await org.owner.post(`/accounting/journals/${missing.id}/post`)).status).toBe(200);
  });

  it('can be scoped by Decision 53 subtype', async () => {
    const org = await setUpAccountingOrg(ctx);
    await requiredDepartment(org, { accountTypes: [], accountSubtypes: ['OPERATING_EXPENSE'] });
    const rentDraft = await draft(org, {
      entryDate: '2026-03-15',
      description: 'Rent',
      currency: 'MVR',
      lines: [
        line(org.accounts['5300']!, 'debit', '5.00'),
        line(org.accounts['1110']!, 'credit', '5.00'),
      ],
    });
    expect((await org.owner.post(`/accounting/journals/${rentDraft.id}/post`)).status).toBe(400);
    // Other Income (4900) is outside the scope.
    await postJournal(org, {
      entryDate: '2026-03-15',
      description: 'Other income',
      currency: 'MVR',
      lines: [
        line(org.accounts['1110']!, 'debit', '5.00'),
        line(org.accounts['4900']!, 'credit', '5.00'),
      ],
    } as never);
  });

  it('enforce nothing when the scope is empty or the type is optional or archived', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await requiredDepartment(org, { accountTypes: [], accountSubtypes: [] });
    await postJournal(org, saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')) as never);

    await org.owner.patch(`/accounting/dimensions/${dept.type.id}`, {
      isRequired: false,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    await postJournal(org, saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')) as never);

    await org.owner.patch(`/accounting/dimensions/${dept.type.id}`, { isRequired: true });
    await org.owner.post(`/accounting/dimensions/${dept.type.id}/archive`);
    await postJournal(org, saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')) as never);
  });

  it('revalidate at posting when the requirement changes after submission (Decision 86)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const journal = await draft(
      org,
      saleBody(org, line(org.accounts['4100']!, 'credit', '100.00')),
    );
    const submitted = await org.owner.post(`/accounting/journals/${journal.id}/submit`);
    expect(submitted.body.data.status).toBe('PENDING_APPROVAL');

    await org.owner.patch(`/accounting/dimensions/${dept.type.id}`, {
      isRequired: true,
      scope: { accountTypes: ['REVENUE'], accountSubtypes: [] },
    });
    const blocked = await org.owner.post(`/accounting/journals/${journal.id}/post`);
    expect(blocked.status).toBe(400);
    const pending = (await org.owner.get(`/accounting/journals/${journal.id}`)).body.data;
    expect(pending.status).toBe('PENDING_APPROVAL');
    expect(pending.lines[1].dimensions).toEqual([]);

    // The user withdraws, edits and resubmits.
    expect((await org.owner.post(`/accounting/journals/${journal.id}/withdraw`)).status).toBe(200);
    await org.owner.patch(`/accounting/journals/${journal.id}`, {
      lines: [
        line(org.accounts['1110']!, 'debit', '100.00'),
        tagged(org.accounts['4100']!, 'credit', '100.00', [[dept.type.id, dept.ops]]),
      ],
    });
    expect((await org.owner.post(`/accounting/journals/${journal.id}/submit`)).status).toBe(200);
    expect((await org.owner.post(`/accounting/journals/${journal.id}/post`)).status).toBe(200);
  });

  it('are enforced by the database guard for manual journals', async () => {
    const org = await setUpAccountingOrg(ctx);
    await requiredDepartment(org, { accountTypes: ['REVENUE'], accountSubtypes: [] });
    await asApp(org.organizationId, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO accounting_journal_entries (organization_id, entry_date, currency)
         VALUES ($1, '2026-03-15', 'MVR') RETURNING id`,
        [org.organizationId],
      );
      const id = rows[0].id;
      for (const [n, account, side] of [
        [1, org.accounts['1110'], 'debit'],
        [2, org.accounts['4100'], 'credit'],
      ] as const) {
        await db.query(
          `INSERT INTO accounting_journal_lines
             (organization_id, journal_id, line_number, account_id, ${side}, base_${side})
           VALUES ($1, $2, $3, $4, 1, 1)`,
          [org.organizationId, id, n, account],
        );
      }
      await expect(
        db.query(
          `UPDATE accounting_journal_entries SET status = 'POSTED', journal_number = $2,
             posted_at = now(), period_id = $3, exchange_rate = 1, base_currency = 'MVR',
             total_debit = 1, total_credit = 1, total_base_debit = 1, total_base_credit = 1
           WHERE id = $1`,
          [id, randomInt(1_000_000, 2_000_000_000), org.periods[2]!.id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('required dimension'),
      });
    });
  });

  it('follow the originating module rules for event and system journals (Decision 78)', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await requiredDepartment(org, { accountTypes: ['REVENUE'], accountSubtypes: [] });

    // A module applying a document-level dimension to its revenue and AR lines.
    const eventType = `test_dims_${randomInt(1e9)}.issued`;
    ctx.services.journals.registerEventHandler(eventType, ({ payload }) => ({
      entryDate: '2026-05-10',
      description: 'Invoice',
      reference: String(payload.id),
      currency: 'MVR',
      exchangeRate: null,
      lines: [
        tagged(org.accounts['1130']!, 'debit', '25.00', [[dept.type.id, String(payload.dept)]]),
        tagged(org.accounts['4100']!, 'credit', '25.00', [[dept.type.id, String(payload.dept)]]),
      ],
    }));
    const result = await inTransaction(
      ctx.database.db,
      { organizationId: org.organizationId },
      async (tx) => {
        await setDbContext(tx, { organizationId: org.organizationId });
        return ctx.services.journals.receiveEventInTransaction(tx, {
          organizationId: org.organizationId,
          sourceModule: 'test-sales',
          eventType,
          eventKey: randomUUID(),
          payload: { id: 'INV-1', dept: dept.sales },
          occurredAt: new Date(),
          origin,
        });
      },
    );
    const journal = (await org.owner.get(`/accounting/journals/${result.journalId}`)).body.data;
    expect(journal.status).toBe('POSTED');
    expect(
      journal.lines.map((l: { dimensions: { valueCode: string }[] }) => l.dimensions[0]?.valueCode),
    ).toEqual(['SALES', 'SALES']);

    // A system journal whose module rules assign no dimension is not subject to manual enforcement.
    const system = await inTransaction(
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
                accountId: org.accounts['4100']!,
                description: '',
                kind: 'normal',
                debit: '1.00',
                credit: null,
                baseDebit: null,
                baseCredit: null,
              },
              {
                accountId: org.accounts['3900']!,
                description: '',
                kind: 'normal',
                debit: null,
                credit: '1.00',
                baseDebit: null,
                baseCredit: null,
              },
            ],
          },
          origin,
        );
      },
    );
    expect(system.status).toBe('POSTED');
  });
});

describe('reporting filters (Decision 16)', () => {
  it('filter the ledger by dimension and flag tagged activity only', async () => {
    const org = await setUpAccountingOrg(ctx);
    const dept = await department(org);
    const project = await createType(org.owner, { code: 'PROJ', name: 'Project' });
    const alpha = await createValue(org.owner, project.id, 'ALPHA');
    await postJournal(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '30.00', [
          [dept.type.id, dept.sales],
          [project.id, alpha],
        ]),
        '30.00',
      ) as never,
    );
    await postJournal(
      org,
      saleBody(
        org,
        tagged(org.accounts['4100']!, 'credit', '20.00', [[dept.type.id, dept.ops]]),
        '20.00',
      ) as never,
    );
    await postJournal(
      org,
      saleBody(org, line(org.accounts['4100']!, 'credit', '5.00'), '5.00') as never,
    );

    const all = (await org.owner.get(`/accounting/ledger?accountId=${org.accounts['4100']}`)).body
      .data;
    expect(all).toMatchObject({ taggedActivityOnly: false, dimensionFilter: [] });
    expect(all.totals.baseCredit).toBe('55.0000');

    const sales = (
      await org.owner.get(
        `/accounting/ledger?accountId=${org.accounts['4100']}&dimensionValueIds=${dept.sales}`,
      )
    ).body.data;
    expect(sales.taggedActivityOnly).toBe(true);
    expect(sales.dimensionFilter).toEqual([
      expect.objectContaining({ typeName: 'Department', valueName: 'Sales' }),
    ]);
    expect(sales.totals.baseCredit).toBe('30.0000');
    expect(sales.rows).toHaveLength(1);

    const both = (
      await org.owner.get(`/accounting/ledger?dimensionValueIds=${dept.sales},${alpha}`)
    ).body.data;
    expect(both.rows).toHaveLength(1);

    expect(
      (await org.owner.get(`/accounting/ledger?dimensionValueIds=${dept.sales},${dept.ops}`))
        .status,
    ).toBe(400);
  });
});

describe('tenant isolation', () => {
  it('rejects cross-tenant dimension access and assignment', async () => {
    const a = await setUpAccountingOrg(ctx);
    const b = await setUpAccountingOrg(ctx);
    const bDept = await department(b);

    expect(
      (await a.owner.patch(`/accounting/dimensions/${bDept.type.id}`, { name: 'X' })).status,
    ).toBe(404);
    expect(
      (
        await a.owner.post(`/accounting/dimensions/${bDept.type.id}/values`, {
          code: 'X',
          name: 'X',
        })
      ).status,
    ).toBe(404);
    expect(
      (await a.owner.post(`/accounting/dimensions/${bDept.type.id}/values/${bDept.sales}/archive`))
        .status,
    ).toBe(404);
    expect((await a.owner.get('/accounting/dimensions')).body.data).toEqual([]);

    const crossJournal = await a.owner.post(
      '/accounting/journals',
      saleBody(a, tagged(a.accounts['4100']!, 'credit', '100.00', [[bDept.type.id, bDept.sales]])),
    );
    expect(crossJournal.status).toBe(400);
    expect((await a.owner.get(`/accounting/ledger?dimensionValueIds=${bDept.sales}`)).status).toBe(
      400,
    );

    const aJournal = await draft(a, saleBody(a, line(a.accounts['4100']!, 'credit', '100.00')));
    await asApp(a.organizationId, async (db) => {
      for (const table of [
        'accounting_dimension_types',
        'accounting_dimension_values',
        'accounting_journal_line_dimensions',
      ]) {
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE organization_id = $1`,
          [b.organizationId],
        );
        expect(rows[0].n, table).toBe(0);
      }
      const { rows } = await db.query(
        `SELECT id FROM accounting_journal_lines WHERE journal_id = $1 AND line_number = 2`,
        [aJournal.id],
      );
      await db.query('SAVEPOINT a');
      // B's value under A's organization id: the composite key finds no such value.
      await expect(
        db.query(
          `INSERT INTO accounting_journal_line_dimensions
             (organization_id, journal_line_id, dimension_type_id, dimension_value_id)
           VALUES ($1, $2, $3, $4)`,
          [a.organizationId, rows[0].id, bDept.type.id, bDept.sales],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      await db.query('ROLLBACK TO SAVEPOINT a');
      // Rows for another organization are refused by row-level security.
      await expect(
        db.query(
          `INSERT INTO accounting_dimension_types (organization_id, code, name, created_by_user_id)
           SELECT $1, 'HACK', 'Hack', created_by_user_id FROM accounting_dimension_types LIMIT 1`,
          [b.organizationId],
        ),
      ).resolves.toMatchObject({ rowCount: 0 });
      await expect(
        db.query(
          `INSERT INTO accounting_dimension_types (organization_id, code, name, created_by_user_id)
           VALUES ($1, 'HACK', 'Hack', $2)`,
          [b.organizationId, randomUUID()],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });
});
