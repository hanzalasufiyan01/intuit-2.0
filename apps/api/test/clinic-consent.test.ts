import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Clinic consent register and retention review (migration 0086, ADR 0013 addendum): the
 * organization's own wording, append-only history, a retention period the organization sets (no
 * default), a review list that never removes anything, audit, permissions, tenant isolation.
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

async function clinicOrg(): Promise<AccountingOrg & { patientId: string }> {
  const org = await setUpAccountingOrg(ctx);
  const on = await org.owner.put('/organizations/current/modules/clinic', { enabled: true });
  expect(on.status, JSON.stringify(on.body)).toBe(200);
  const patient = await org.owner.post('/clinic/patients', { displayName: 'Aisha Test' });
  expect(patient.status, JSON.stringify(patient.body)).toBe(201);
  return { ...org, patientId: patient.body.data.id };
}

const consent = (o: AccountingOrg & { patientId: string }, body: object) =>
  o.owner.post(`/clinic/patients/${o.patientId}/consents`, body);

describe('consent register', () => {
  it('records grants and withdrawals with the organization wording and keeps the history', async () => {
    const o = await clinicOrg();
    expect(
      (await o.owner.get(`/clinic/patients/${o.patientId}/consents`)).body.data.current,
    ).toEqual([]);
    const granted = await consent(o, {
      purpose: 'Appointment reminders',
      wording: 'Version 1: you agree to be contacted about appointments.',
      action: 'granted',
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    expect(granted.body.data.current).toMatchObject([
      { purpose: 'Appointment reminders', status: 'granted' },
    ]);
    // The same wording again is refused; new wording is a new version.
    expect(
      (
        await consent(o, {
          purpose: 'Appointment reminders',
          wording: 'Version 1: you agree to be contacted about appointments.',
          action: 'granted',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await consent(o, {
          purpose: 'Appointment reminders',
          wording: 'Version 2: wording changed.',
          action: 'granted',
        })
      ).status,
    ).toBe(201);
    const withdrawn = await consent(o, { purpose: 'Appointment reminders', action: 'withdrawn' });
    expect(withdrawn.status).toBe(201);
    expect(withdrawn.body.data.current[0]).toMatchObject({ status: 'withdrawn', wording: '' });
    expect(withdrawn.body.data.history.map((h: { action: string }) => h.action)).toEqual([
      'granted',
      'granted',
      'withdrawn',
    ]);
    // Nothing to withdraw for an unknown purpose; granting needs wording; no future dates.
    expect((await consent(o, { purpose: 'Other', action: 'withdrawn' })).status).toBe(409);
    expect((await consent(o, { purpose: 'Other', action: 'granted' })).status).toBe(400);
    expect(
      (
        await consent(o, {
          purpose: 'Other',
          wording: 'x',
          action: 'granted',
          effectiveDate: '2999-01-01',
        })
      ).status,
    ).toBe(400);
  });

  it('is append-only in the database, audited without names or wording, and survives anonymization', async () => {
    const o = await clinicOrg();
    await consent(o, {
      purpose: 'Data sharing',
      wording: 'SECRET-WORDING-TEXT',
      action: 'granted',
    });
    await expect(
      db.query(`UPDATE clinic_consent_events SET purpose = 'x' WHERE patient_id = $1`, [
        o.patientId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM clinic_consent_events WHERE patient_id = $1`, [o.patientId]),
    ).rejects.toThrow(/append-only/);
    await o.owner.get(`/clinic/patients/${o.patientId}/consents`);
    const audit = await db.query(
      `SELECT action, metadata::text AS metadata FROM audit_events
        WHERE organization_id = $1 AND action LIKE 'clinic.consent_%' ORDER BY occurred_at`,
      [o.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'clinic.consent_recorded',
      'clinic.consent_viewed',
    ]);
    const text = JSON.stringify(audit.rows);
    expect(text).not.toContain('SECRET-WORDING-TEXT');
    expect(text).not.toContain('Aisha');

    const detail = await o.owner.get(`/clinic/patients/${o.patientId}`);
    const anon = await o.owner.post(`/clinic/patients/${o.patientId}/anonymize`, {
      version: detail.body.data.version,
    });
    expect(anon.status, JSON.stringify(anon.body)).toBe(200);
    const after = await o.owner.get(`/clinic/patients/${o.patientId}/consents`);
    expect(after.body.data.history).toHaveLength(1);
    expect((await consent(o, { purpose: 'New', wording: 'w', action: 'granted' })).status).toBe(
      409,
    );
  });
});

describe('retention review', () => {
  it('has no default period, lists only patients past the period the organization set, and removes nothing', async () => {
    const o = await clinicOrg();
    const empty = await o.owner.get('/clinic/retention-review');
    expect(empty.body.data).toEqual({ retentionYears: null, cutoff: null, items: [] });
    expect((await o.owner.get('/clinic/settings')).body.data).toEqual({
      retentionYears: null,
      version: 0,
    });
    const set = await o.owner.put('/clinic/settings', { retentionYears: 7, version: 0 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body.data).toEqual({ retentionYears: 7, version: 1 });
    expect((await o.owner.put('/clinic/settings', { retentionYears: 8, version: 0 })).status).toBe(
      409,
    );
    expect((await o.owner.put('/clinic/settings', { retentionYears: 0, version: 1 })).status).toBe(
      400,
    );
    // A fresh patient is not past retention.
    expect((await o.owner.get('/clinic/retention-review')).body.data.items).toEqual([]);
    // An old patient is listed, nothing is changed.
    const old = await o.owner.post('/clinic/patients', { displayName: 'Old Patient' });
    await db.query(
      `UPDATE clinic_patients SET updated_at = now() - interval '9 years' WHERE id = $1`,
      [old.body.data.id],
    );
    const review = await o.owner.get('/clinic/retention-review');
    expect(review.body.data.items.map((i: { id: string }) => i.id)).toEqual([old.body.data.id]);
    const stillThere = await o.owner.get(`/clinic/patients/${old.body.data.id}`);
    expect(stillThere.body.data.status).toBe('ACTIVE');
    const audit = await db.query(
      `SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'clinic.retention_%'`,
      [o.organizationId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['clinic.retention_set', 'clinic.retention_reviewed']),
    );
  });
});

describe('permissions and tenancy', () => {
  it('needs clinic permissions, the module and the right tenant', async () => {
    const o = await clinicOrg();
    const member = await joinWithRole(ctx, o.owner, 'Member');
    for (const path of [
      `/clinic/patients/${o.patientId}/consents`,
      '/clinic/settings',
      '/clinic/retention-review',
    ]) {
      expect((await member.client.get(path)).status, path).toBe(403);
    }
    expect(
      (await member.client.put('/clinic/settings', { retentionYears: 5, version: 0 })).status,
    ).toBe(403);
    const other = await clinicOrg();
    expect((await other.owner.get(`/clinic/patients/${o.patientId}/consents`)).status).toBe(404);
    expect(
      (
        await other.owner.post(`/clinic/patients/${o.patientId}/consents`, {
          purpose: 'x',
          wording: 'w',
          action: 'granted',
        })
      ).status,
    ).toBe(404);
    // Module off: refused even for the owner.
    const off = await setUpAccountingOrg(ctx);
    expect((await off.owner.get('/clinic/settings')).status).toBe(403);
  });
});
