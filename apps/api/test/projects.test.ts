import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestClient, type TestContext } from './helpers.js';

/**
 * Projects, time tracking and billing (FP-26): the module switch, projects and their PROJECT
 * dimension value, the time workflow, billing approved time exactly once into a draft invoice,
 * release of time whose invoice was deleted, the project's ledger result, permissions, tenant
 * isolation and the database guards. Real PostgreSQL.
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

interface ProjectOrg extends AccountingOrg {
  customerId: string;
  itemId: string;
  staff: { client: TestClient; userId: string };
  staff2: { client: TestClient; userId: string };
}

async function projectOrg(options: { enable?: boolean } = {}): Promise<ProjectOrg> {
  const org = await setUpAccountingOrg(ctx);
  if (options.enable !== false) {
    const on = await org.owner.put('/organizations/current/modules/projects', { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 30,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'organization', displayName: 'Sun Island Resort' },
  });
  const item = await org.owner.post('/sales/items', {
    name: 'Consulting hour',
    itemType: 'service',
    unitPrice: '100',
    revenueAccountId: org.accounts['4200'],
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  const role = await org.owner.post('/organizations/current/roles', {
    name: 'Staff',
    permissionKeys: ['projects.time.log'],
  });
  expect(role.status, JSON.stringify(role.body)).toBe(201);
  const staff = await joinWithRole(ctx, org.owner, 'Staff');
  const staff2 = await joinWithRole(ctx, org.owner, 'Staff');
  return {
    ...org,
    customerId: customer.body.data.id,
    itemId: item.body.data.id,
    staff: { client: staff.client, userId: staff.userId },
    staff2: { client: staff2.client, userId: staff2.userId },
  };
}

async function newProject(o: ProjectOrg, extra: object = {}) {
  const res = await o.owner.post('/projects', {
    name: 'Resort audit',
    customerId: o.customerId,
    billingMethod: 'time_and_materials',
    defaultBillRate: '100',
    members: [
      { userId: o.staff.userId, billRate: '150', costRate: '60' },
      { userId: o.staff2.userId, costRate: '40' },
    ],
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const log = (client: TestClient, projectId: string, extra: object = {}) =>
  client.post('/projects/time/entries', {
    projectId,
    workDate: '2026-03-10',
    hours: '4',
    description: 'On-site review',
    ...extra,
  });

/** Logs, submits and approves one entry. */
async function approvedTime(
  o: ProjectOrg,
  client: TestClient,
  projectId: string,
  extra: object = {},
) {
  const entry = await log(client, projectId, extra);
  expect(entry.status, JSON.stringify(entry.body)).toBe(201);
  const submitted = await client.post(`/projects/time/entries/${entry.body.data.id}/submit`, {
    version: entry.body.data.version,
  });
  expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
  const approved = await o.owner.post(`/projects/time/entries/${entry.body.data.id}/approve`, {
    version: submitted.body.data.version,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return approved.body.data;
}

describe('module switch and projects', () => {
  it('is off until enabled', async () => {
    const o = await projectOrg({ enable: false });
    const res = await o.owner.get('/projects');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('creates projects numbered PRJ-, each with its own PROJECT dimension value', async () => {
    const o = await projectOrg();
    const first = await newProject(o);
    const second = await newProject(o, { name: 'Second job' });
    expect([first.number, second.number]).toEqual(['PRJ-00001', 'PRJ-00002']);
    expect(first.members).toHaveLength(2);
    const types = (await o.owner.get('/accounting/dimensions')).body.data as {
      code: string;
      values?: { id: string; code: string; name: string }[];
    }[];
    const type = types.find((t) => t.code === 'PROJECT');
    expect(type).toBeDefined();
    const { rows } = await db.query(
      `SELECT code, name FROM accounting_dimension_values WHERE organization_id = $1 AND id = $2`,
      [o.organizationId, first.dimensionValueId],
    );
    expect(rows[0]).toEqual({ code: 'PRJ-00001', name: 'PRJ-00001 Resort audit' });
    expect(first.dimensionValueId).not.toBe(second.dimensionValueId);
    // Rename follows to the dimension value.
    const renamed = await o.owner.put(`/projects/${first.id}`, {
      version: first.version,
      name: 'Resort audit 2026',
      customerId: o.customerId,
      billingMethod: 'time_and_materials',
      defaultBillRate: '100',
      members: first.members.map(
        (m: { userId: string; billRate: string | null; costRate: string }) => ({
          userId: m.userId,
          billRate: m.billRate,
          costRate: m.costRate,
        }),
      ),
    });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const after = await db.query(`SELECT name FROM accounting_dimension_values WHERE id = $1`, [
      first.dimensionValueId,
    ]);
    expect(after.rows[0].name).toBe('PRJ-00001 Resort audit 2026');
  });

  it('validates customers, members, dates and versions', async () => {
    const o = await projectOrg();
    const base = {
      name: 'X',
      billingMethod: 'time_and_materials',
      defaultBillRate: '1',
      members: [],
    };
    expect((await o.owner.post('/projects', { ...base, customerId: o.staff.userId })).status).toBe(
      400,
    );
    expect(
      (
        await o.owner.post('/projects', {
          ...base,
          members: [{ userId: o.customerId, costRate: '1' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await o.owner.post('/projects', { ...base, startDate: '2026-05-01', endDate: '2026-04-01' }))
        .status,
    ).toBe(400);
    expect((await o.owner.post('/projects', { ...base, extra: true })).status).toBe(400);
    const project = await newProject(o);
    const stale = await o.owner.put(`/projects/${project.id}`, {
      ...base,
      version: 99,
      members: [],
    });
    expect(stale.status).toBe(409);
    // Completed projects cannot be reopened.
    const done = await o.owner.put(`/projects/${project.id}`, {
      ...base,
      version: project.version,
      status: 'COMPLETED',
      members: [],
    });
    expect(done.status).toBe(200);
    const reopen = await o.owner.put(`/projects/${project.id}`, {
      ...base,
      version: done.body.data.version,
      status: 'ACTIVE',
      members: [],
    });
    expect(reopen.status).toBe(409);
  });
});

describe('time workflow', () => {
  it('logs, submits, approves and rejects, with rates frozen and rules enforced', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    const entry = await log(o.staff.client, project.id, { hours: '4.5' });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    expect(entry.body.data).toMatchObject({
      status: 'DRAFT',
      hours: '4.5',
      billRate: '150',
      costRate: '60',
      billable: true,
    });
    // The default bill rate applies to a member without their own.
    const second = await log(o.staff2.client, project.id);
    expect(second.body.data).toMatchObject({ billRate: '100', costRate: '40' });
    // Changing the member's rate later does not change a saved entry.
    await o.owner.put(`/projects/${project.id}`, {
      version: project.version,
      name: 'Resort audit',
      customerId: o.customerId,
      billingMethod: 'time_and_materials',
      defaultBillRate: '100',
      members: [
        { userId: o.staff.userId, billRate: '999', costRate: '60' },
        { userId: o.staff2.userId, costRate: '40' },
      ],
    });
    const list = await o.staff.client.get('/projects/time/entries');
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].billRate).toBe('150');
    // Rules.
    expect((await log(o.staff.client, project.id, { hours: '0' })).status).toBe(400);
    expect((await log(o.staff.client, project.id, { hours: '25' })).status).toBe(400);
    expect((await log(o.staff.client, project.id, { hours: '1.234' })).status).toBe(400);
    expect((await log(o.staff.client, project.id, { workDate: '2999-01-01' })).status).toBe(400);
    expect((await log(o.staff.client, project.id, { hours: '20' })).status).toBe(400); // 4.5 + 20 > 24
    expect((await log(o.staff.client, project.id, { description: '  ' })).status).toBe(400);
    const stranger = await newProject(o, { name: 'Other', members: [] });
    expect((await log(o.staff.client, stranger.id)).status).toBe(400); // not a member
    // Submit, then it is frozen.
    const submitted = await o.staff.client.post(
      `/projects/time/entries/${entry.body.data.id}/submit`,
      { version: 1 },
    );
    expect(submitted.status).toBe(200);
    expect(
      (
        await o.staff.client.put(`/projects/time/entries/${entry.body.data.id}`, {
          version: submitted.body.data.version,
          projectId: project.id,
          workDate: '2026-03-10',
          hours: '1',
          description: 'x',
        })
      ).status,
    ).toBe(409);
    expect(
      (await o.staff.client.delete(`/projects/time/entries/${entry.body.data.id}`)).status,
    ).toBe(409);
    // A staff member cannot approve; a manager rejects with a reason, and the entry can be fixed.
    expect(
      (
        await o.staff.client.post(`/projects/time/entries/${entry.body.data.id}/approve`, {
          version: submitted.body.data.version,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await o.owner.post(`/projects/time/entries/${entry.body.data.id}/reject`, {
          version: submitted.body.data.version,
          reason: ' ',
        })
      ).status,
    ).toBe(400);
    const rejected = await o.owner.post(`/projects/time/entries/${entry.body.data.id}/reject`, {
      version: submitted.body.data.version,
      reason: 'Wrong day',
    });
    expect(rejected.body.data).toMatchObject({ status: 'REJECTED', rejectReason: 'Wrong day' });
    const fixed = await o.staff.client.put(`/projects/time/entries/${entry.body.data.id}`, {
      version: rejected.body.data.version,
      projectId: project.id,
      workDate: '2026-03-11',
      hours: '4',
      description: 'On-site review',
    });
    expect(fixed.body.data).toMatchObject({
      status: 'DRAFT',
      workDate: '2026-03-11',
      rejectReason: null,
    });
    // Other people's entries look missing.
    expect(
      (
        await o.staff2.client.post(`/projects/time/entries/${entry.body.data.id}/submit`, {
          version: fixed.body.data.version,
        })
      ).status,
    ).toBe(404);
    expect((await o.staff2.client.get('/projects/time/entries')).body.data).toHaveLength(1);
    // Draft entries can be deleted.
    expect(
      (await o.staff.client.delete(`/projects/time/entries/${entry.body.data.id}`)).status,
    ).toBe(200);
  });

  it('forces time on a non-billable project to be non-billable, and refuses time on inactive projects', async () => {
    const o = await projectOrg();
    const free = await newProject(o, { billingMethod: 'non_billable' });
    const entry = await log(o.staff.client, free.id, { billable: true });
    expect(entry.body.data.billable).toBe(false);
    const hold = await newProject(o, { name: 'Paused', status: 'ON_HOLD' });
    expect((await log(o.staff.client, hold.id)).status).toBe(400);
  });
});

describe('billing', () => {
  it('bills approved billable time once into a draft invoice tagged with the project', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    await approvedTime(o, o.staff.client, project.id, { hours: '4' }); // 4 x 150 = 600
    await approvedTime(o, o.staff.client, project.id, { workDate: '2026-03-11', hours: '2' }); // 300
    await approvedTime(o, o.staff2.client, project.id, { hours: '3' }); // 3 x 100 = 300
    const notBillable = await approvedTime(o, o.staff2.client, project.id, {
      workDate: '2026-03-12',
      hours: '1',
      billable: false,
    });
    expect(notBillable.billable).toBe(false);
    const summaryBefore = (await o.owner.get('/projects/summary')).body.data.projects[0];
    expect(summaryBefore.hours).toMatchObject({ approved: '10.00', billed: '0.00' });
    expect(summaryBefore.unbilledBillableAmount).toBe('1200.00');

    const billed = await o.owner.post(`/projects/${project.id}/bill`, {
      invoiceDate: '2026-03-31',
      upTo: '2026-03-31',
      itemId: o.itemId,
    });
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    expect(billed.body.data).toMatchObject({ entries: 3, hours: '9.00', amount: '1200.00' });
    const invoice = (await o.owner.get(`/sales/invoices/${billed.body.data.invoiceId}`)).body.data;
    expect(invoice.status).toBe('DRAFT');
    expect(invoice.lines).toHaveLength(2); // one per person and rate
    expect(
      invoice.lines.every((l: { dimensionValueIds?: string[]; dimensions?: unknown[] }) =>
        JSON.stringify(l).includes(project.dimensionValueId),
      ),
    ).toBe(true);
    expect(invoice.total).toBe('1200.00');

    // The same hours cannot be billed twice; the non-billable hour stays out.
    const again = await o.owner.post(`/projects/${project.id}/bill`, {
      invoiceDate: '2026-03-31',
      upTo: '2026-03-31',
    });
    expect(again.status).toBe(400);
    const entries = (
      await o.owner.get(`/projects/time/entries?projectId=${project.id}&status=BILLED`)
    ).body.data;
    expect(entries).toHaveLength(3);
    expect(
      entries.every((e: { invoiceId: string }) => e.invoiceId === billed.body.data.invoiceId),
    ).toBe(true);
    // A billed entry is final in the database.
    await expect(
      db.query(`UPDATE project_time_entries SET hours = 1 WHERE id = $1`, [entries[0].id]),
    ).rejects.toThrow(/immutable|frozen/);
    await expect(
      db.query(`DELETE FROM project_time_entries WHERE id = $1`, [entries[0].id]),
    ).rejects.toThrow(/cannot be deleted/);

    // Issuing the invoice puts revenue on the books under the project; the summary shows it.
    const issued = await o.owner.post(`/sales/invoices/${billed.body.data.invoiceId}/issue`, {
      version: invoice.version,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const summary = (await o.owner.get(`/projects/summary?projectId=${project.id}`)).body.data
      .projects[0];
    expect(summary.hours).toMatchObject({ billed: '9.00', approved: '1.00' });
    expect(summary.billedAmount).toBe('1200.00');
    expect(summary.ledger).toEqual({ revenue: '1200.00', cost: '0.00', profit: '1200.00' });
    expect(summary.timeCost).toBe('520.00'); // 6h x 60 + 3h x 40 + the non-billable hour x 40
  });

  it('refuses to bill what cannot be billed, and needs the right permissions', async () => {
    const o = await projectOrg();
    const noCustomer = await newProject(o, { customerId: null });
    await approvedTime(o, o.staff.client, noCustomer.id);
    expect(
      (
        await o.owner.post(`/projects/${noCustomer.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-31',
        })
      ).status,
    ).toBe(400);
    const fixed = await newProject(o, { billingMethod: 'fixed', name: 'Fixed price' });
    expect(
      (
        await o.owner.post(`/projects/${fixed.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-31',
        })
      ).status,
    ).toBe(409);
    const project = await newProject(o, { name: 'Future work' });
    await approvedTime(o, o.staff.client, project.id);
    // Up to a date before the work: nothing to bill.
    expect(
      (
        await o.owner.post(`/projects/${project.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-01',
        })
      ).status,
    ).toBe(400);
    // Staff cannot bill; a billing role without invoices.create cannot either.
    expect(
      (
        await o.staff.client.post(`/projects/${project.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-31',
        })
      ).status,
    ).toBe(403);
    await o.owner.post('/organizations/current/roles', {
      name: 'Biller',
      permissionKeys: ['projects.view', 'projects.bill'],
    });
    const biller = await joinWithRole(ctx, o.owner, 'Biller');
    expect(
      (
        await biller.client.post(`/projects/${project.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-31',
        })
      ).status,
    ).toBe(403);
  });

  it('releases time whose draft invoice was deleted, but never time on a live invoice', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    await approvedTime(o, o.staff.client, project.id, { hours: '2' });
    const billed = await o.owner.post(`/projects/${project.id}/bill`, {
      invoiceDate: '2026-03-31',
      upTo: '2026-03-31',
    });
    expect(billed.status, JSON.stringify(billed.body)).toBe(200);
    // The invoice still exists: nothing is released.
    expect(
      (await o.owner.post(`/projects/${project.id}/release-time`, {})).body.data.released,
    ).toBe(0);
    const invoice = (await o.owner.get(`/sales/invoices/${billed.body.data.invoiceId}`)).body.data;
    const deleted = await o.owner.delete(
      `/sales/invoices/${invoice.id}?version=${invoice.version}`,
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    const released = await o.owner.post(`/projects/${project.id}/release-time`, {});
    expect(released.body.data.released).toBe(1);
    const rebilled = await o.owner.post(`/projects/${project.id}/bill`, {
      invoiceDate: '2026-04-01',
      upTo: '2026-03-31',
    });
    expect(rebilled.status, JSON.stringify(rebilled.body)).toBe(200);
  });
});

describe('access control and isolation', () => {
  it('shows staff only their own time, keeps projects private to viewers and isolates tenants', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    await approvedTime(o, o.staff.client, project.id);
    await approvedTime(o, o.staff2.client, project.id);
    // Staff have no projects.view: no project list, only their own time.
    expect((await o.staff.client.get('/projects')).status).toBe(403);
    expect((await o.staff.client.get('/projects/summary')).status).toBe(403);
    expect((await o.staff.client.get('/projects/time/entries')).body.data).toHaveLength(1);
    expect(
      (
        await o.staff.client.get(`/projects/time/entries?userId=${o.staff2.userId}`)
      ).body.data.every((e: { userId: string }) => e.userId === o.staff.userId),
    ).toBe(true);
    expect((await o.owner.get('/projects/time/entries')).body.data).toHaveLength(2);
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get('/projects/time/entries')).status).toBe(403);
    // Another organization sees nothing and cannot touch this project's time.
    const other = await projectOrg();
    expect((await other.owner.get('/projects')).body.data).toEqual([]);
    expect((await other.owner.get(`/projects/${project.id}`)).status).toBe(404);
    expect(
      (
        await other.owner.post(`/projects/${project.id}/bill`, {
          invoiceDate: '2026-03-31',
          upTo: '2026-03-31',
        })
      ).status,
    ).toBe(404);
    const entry = (await o.owner.get('/projects/time/entries')).body.data[0];
    expect(
      (
        await other.owner.post(`/projects/time/entries/${entry.id}/approve`, {
          version: entry.version,
        })
      ).status,
    ).toBe(404);
    // The ledger part of the summary needs accounting reports.
    await o.owner.post('/organizations/current/roles', {
      name: 'PM',
      permissionKeys: ['projects.view'],
    });
    const pm = await joinWithRole(ctx, o.owner, 'PM');
    expect((await pm.client.get('/projects/summary')).body.data.projects[0].ledger).toBeNull();
  });
});

describe('concurrent billing and audit', () => {
  it('bills the same approved time only once when two requests race', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    await approvedTime(o, o.staff.client, project.id, { hours: '4' });
    const body = { invoiceDate: '2026-03-31', upTo: '2026-03-31' };
    const results = await Promise.all([
      o.owner.post(`/projects/${project.id}/bill`, body),
      o.owner.post(`/projects/${project.id}/bill`, body),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const entries = (
      await o.owner.get(`/projects/time/entries?projectId=${project.id}&status=BILLED`)
    ).body.data;
    expect(entries).toHaveLength(1);
    const invoices = await db.query(
      `SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(invoices.rows[0].n).toBe(1);
  });

  it('audits every project and time action, and turns everything off with the module', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    await approvedTime(o, o.staff.client, project.id);
    await o.owner.post(`/projects/${project.id}/bill`, {
      invoiceDate: '2026-03-31',
      upTo: '2026-03-31',
    });
    const { rows } = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'project.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'project.created',
      'project.time_logged',
      'project.time_submitted',
      'project.time_approved',
      'project.time_billed',
    ]);
    const off = await o.owner.put('/organizations/current/modules/projects', { enabled: false });
    expect(off.status).toBe(200);
    for (const path of ['/projects', '/projects/summary', '/projects/time/entries']) {
      const res = await o.staff.client.get(path);
      expect(res.status, path).toBe(403);
    }
    expect((await o.owner.get('/projects')).body.error.code).toBe('MODULE_DISABLED');
    // The data is kept: switching it back on shows the same project.
    await o.owner.put('/organizations/current/modules/projects', { enabled: true });
    expect((await o.owner.get('/projects')).body.data).toHaveLength(1);
  });
});

describe('tasks and hour budgets', () => {
  it('creates tasks, logs time against them, flags overruns and refuses foreign or finished tasks', async () => {
    const o = await projectOrg();
    const project = await newProject(o);
    const other = await newProject(o, { name: 'Other job' });
    const task = await o.owner.post(`/projects/${project.id}/tasks`, {
      name: 'Fieldwork',
      budgetHours: '5',
    });
    expect(task.status, JSON.stringify(task.body)).toBe(201);
    expect(task.body.data).toMatchObject({
      name: 'Fieldwork',
      status: 'OPEN',
      budgetHours: '5.00',
      hours: '0.00',
      overBudget: false,
    });
    const foreign = (await o.owner.post(`/projects/${other.id}/tasks`, { name: 'Elsewhere' })).body
      .data;
    // Names are unique within a project, validated, and budgets cannot be negative.
    expect(
      (await o.owner.post(`/projects/${project.id}/tasks`, { name: 'fieldwork' })).status,
    ).toBe(400);
    expect((await o.owner.post(`/projects/${project.id}/tasks`, { name: ' ' })).status).toBe(400);
    expect(
      (await o.owner.post(`/projects/${project.id}/tasks`, { name: 'Neg', budgetHours: '-1' }))
        .status,
    ).toBe(400);
    // Time against the task; a task of another project, or an unknown one, is refused.
    const entry = await log(o.staff.client, project.id, { taskId: task.body.data.id, hours: '4' });
    expect(entry.status, JSON.stringify(entry.body)).toBe(201);
    expect(entry.body.data.taskId).toBe(task.body.data.id);
    expect(
      (await log(o.staff.client, project.id, { taskId: foreign.id, workDate: '2026-03-11' }))
        .status,
    ).toBe(400);
    expect(
      (await log(o.staff.client, project.id, { taskId: randomUUID(), workDate: '2026-03-11' }))
        .status,
    ).toBe(400);
    // Approved hours count against the budget; 4 + 2 > 5 flags the task and the project summary.
    await approvedTime(o, o.staff.client, project.id, {
      taskId: task.body.data.id,
      hours: '4',
      workDate: '2026-03-12',
    });
    await approvedTime(o, o.staff2.client, project.id, {
      taskId: task.body.data.id,
      hours: '2',
      workDate: '2026-03-13',
    });
    const tasks = (await o.owner.get(`/projects/${project.id}/tasks`)).body.data;
    expect(tasks[0]).toMatchObject({ hours: '6.00', overBudget: true });
    // Finished tasks take no more time; reopening works; the version is checked.
    const done = await o.owner.put(`/projects/tasks/${task.body.data.id}`, {
      version: task.body.data.version,
      name: 'Fieldwork',
      status: 'DONE',
      budgetHours: '5',
    });
    expect(done.body.data.status).toBe('DONE');
    expect(
      (await log(o.staff.client, project.id, { taskId: task.body.data.id, workDate: '2026-03-14' }))
        .status,
    ).toBe(400);
    expect(
      (
        await o.owner.put(`/projects/tasks/${task.body.data.id}`, {
          version: 1,
          name: 'Fieldwork',
          status: 'OPEN',
        })
      ).status,
    ).toBe(409);
    // The database refuses a task of a different project even when the API is bypassed.
    await expect(
      db.query(`UPDATE project_time_entries SET task_id = $1 WHERE id = $2`, [
        foreign.id,
        entry.body.data.id,
      ]),
    ).rejects.toThrow();
    // The task is frozen with the rest of a submitted entry.
    const submitted = await o.staff.client.post(
      `/projects/time/entries/${entry.body.data.id}/submit`,
      { version: entry.body.data.version },
    );
    expect(submitted.status).toBe(200);
    await expect(
      db.query(`UPDATE project_time_entries SET task_id = NULL WHERE id = $1`, [
        entry.body.data.id,
      ]),
    ).rejects.toThrow(/frozen/);
  });

  it('flags a project over its hour budget, needs the right permissions, and isolates tenants', async () => {
    const o = await projectOrg();
    const project = await newProject(o, { budgetHours: '3' });
    await approvedTime(o, o.staff.client, project.id, { hours: '4' });
    const summary = (await o.owner.get(`/projects/summary?projectId=${project.id}`)).body.data
      .projects[0];
    expect(summary).toMatchObject({ budgetHours: '3.00', overBudgetHours: true });
    expect(
      (await o.staff.client.post(`/projects/${project.id}/tasks`, { name: 'Sneaky' })).status,
    ).toBe(403);
    expect((await o.staff.client.get(`/projects/${project.id}/tasks`)).status).toBe(200); // staff choose a task to log against
    const member = await joinWithRole(ctx, o.owner, 'Member');
    expect((await member.client.get(`/projects/${project.id}/tasks`)).status).toBe(403);
    const other = await projectOrg();
    expect((await other.owner.get(`/projects/${project.id}/tasks`)).status).toBe(404);
    expect((await other.owner.post(`/projects/${project.id}/tasks`, { name: 'x' })).status).toBe(
      404,
    );
    const t = (await o.owner.post(`/projects/${project.id}/tasks`, { name: 'Mine' })).body.data;
    expect(
      (await other.owner.put(`/projects/tasks/${t.id}`, { version: 1, name: 'x', status: 'OPEN' }))
        .status,
    ).toBe(404);
  });
});
