import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinWithRole, setUpAccountingOrg, type AccountingOrg } from './fixtures.js';
import { connectAs, createTestContext, type TestContext } from './helpers.js';

/**
 * Clinic extension v1 (FP-27, ADR 0013): the module switch, patients (masked ids, audited reads,
 * anonymization), services and practitioners, double-booking protection, the appointment
 * lifecycle, billing into one draft invoice, reports without personal data, permissions and
 * tenant isolation. Real PostgreSQL.
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

interface ClinicOrg extends AccountingOrg {
  customerId: string;
  itemId: string;
  practitionerId: string;
  serviceId: string;
}

async function clinicOrg(options: { enable?: boolean } = {}): Promise<ClinicOrg> {
  const org = await setUpAccountingOrg(ctx);
  if (options.enable !== false) {
    const on = await org.owner.put('/organizations/current/modules/clinic', { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  const sales = await org.owner.put('/sales/settings', {
    version: 0,
    arAccountId: org.accounts['1130'],
    defaultRevenueAccountId: org.accounts['4100'],
    defaultDepositAccountId: org.accounts['1120'],
    defaultTaxCodeId: null,
    defaultTaxTreatment: 'no_tax',
    defaultPaymentTermsDays: 0,
  });
  expect(sales.status, JSON.stringify(sales.body)).toBe(200);
  const customer = await org.owner.post('/customers', {
    party: { kind: 'individual', displayName: 'Payer' },
  });
  const item = await org.owner.post('/sales/items', {
    name: 'Consultation',
    itemType: 'service',
    unitPrice: '300',
    revenueAccountId: org.accounts['4200'],
  });
  const base = {
    ...org,
    customerId: customer.body.data.id as string,
    itemId: item.body.data.id as string,
    practitionerId: '',
    serviceId: '',
  };
  if (options.enable === false) return base;
  const practitioner = await org.owner.post('/clinic/practitioners', {
    displayName: 'Dr. Hassan',
    specialty: 'General practice',
  });
  expect(practitioner.status, JSON.stringify(practitioner.body)).toBe(201);
  const service = await org.owner.post('/clinic/services', {
    name: 'General consultation',
    price: '300',
    durationMinutes: 30,
    salesItemId: base.itemId,
  });
  expect(service.status, JSON.stringify(service.body)).toBe(201);
  return { ...base, practitionerId: practitioner.body.data.id, serviceId: service.body.data.id };
}

const patient = (o: ClinicOrg, extra: object = {}) =>
  o.owner.post('/clinic/patients', {
    displayName: 'Aisha Mohamed',
    dateOfBirth: '1990-04-02',
    sex: 'female',
    phone: '7771234',
    email: 'aisha@example.test',
    nationalId: 'A1234567',
    billingCustomerId: o.customerId,
    ...extra,
  });

async function newPatient(o: ClinicOrg, extra: object = {}) {
  const res = await patient(o, extra);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

const book = (o: ClinicOrg, patientId: string, startsAt: string, extra: object = {}) =>
  o.owner.post('/clinic/appointments', {
    patientId,
    practitionerId: o.practitionerId,
    serviceId: o.serviceId,
    startsAt,
    ...extra,
  });

async function completed(o: ClinicOrg, patientId: string, startsAt = '2026-03-10T09:00:00Z') {
  const booked = await book(o, patientId, startsAt);
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const checked = await o.owner.post(`/clinic/appointments/${booked.body.data.id}/check-in`, {
    version: booked.body.data.version,
  });
  const done = await o.owner.post(`/clinic/appointments/${booked.body.data.id}/complete`, {
    version: checked.body.data.version,
  });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return done.body.data;
}

describe('module switch and patients', () => {
  it('is off until enabled', async () => {
    const o = await clinicOrg({ enable: false });
    const res = await o.owner.get('/clinic/patients');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MODULE_DISABLED');
  });

  it('numbers patients, masks the national id, and audits every view without personal data', async () => {
    const o = await clinicOrg();
    const first = await newPatient(o);
    const second = await newPatient(o, { displayName: 'Ahmed Ali', nationalId: 'B7654321' });
    expect([first.number, second.number]).toEqual(['PAT-00001', 'PAT-00002']);
    expect(first.nationalId).toBe('•••••567');
    const opened = await o.owner.get(`/clinic/patients/${first.id}`);
    expect(opened.body.data.nationalId).toBe('•••••567');
    expect(JSON.stringify((await o.owner.get('/clinic/patients')).body)).not.toContain('A1234567');
    const found = (await o.owner.get('/clinic/patients?search=ahmed')).body.data;
    expect(found.map((p: { number: string }) => p.number)).toEqual(['PAT-00002']);
    const { rows } = await db.query(
      `SELECT action, metadata::text AS metadata FROM audit_events
        WHERE organization_id = $1 AND action LIKE 'clinic.%' ORDER BY occurred_at, id`,
      [o.organizationId],
    );
    expect(rows.map((r: { action: string }) => r.action)).toEqual(
      expect.arrayContaining([
        'clinic.patient_created',
        'clinic.patient_viewed',
        'clinic.patients_listed',
      ]),
    );
    const all = rows.map((r: { metadata: string }) => r.metadata).join(' ');
    for (const secret of ['Aisha', 'A1234567', '7771234', 'aisha@example.test', '1990-04-02']) {
      expect(all).not.toContain(secret);
    }
  });

  it('validates, versions edits, and keeps the stored id when omitted', async () => {
    const o = await clinicOrg();
    expect((await patient(o, { dateOfBirth: '2999-01-01' })).status).toBe(400);
    expect((await patient(o, { billingCustomerId: o.itemId })).status).toBe(400);
    expect((await patient(o, { clinicalNotes: 'x' })).status).toBe(400); // no clinical content fields exist
    const p = await newPatient(o);
    const edited = await o.owner.put(`/clinic/patients/${p.id}`, {
      version: p.version,
      displayName: 'Aisha M.',
      billingCustomerId: o.customerId,
    });
    expect(edited.body.data.displayName).toBe('Aisha M.');
    expect(edited.body.data.nationalId).toBe('•••••567');
    expect(
      (await o.owner.put(`/clinic/patients/${p.id}`, { version: p.version, displayName: 'x' }))
        .status,
    ).toBe(409);
  });

  it('anonymizes for good: personal fields cleared, appointments and invoices stay, database refuses changes', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o);
    const appointment = await book(o, p.id, '2026-03-12T09:00:00Z');
    // Open appointments block anonymization.
    expect(
      (await o.owner.post(`/clinic/patients/${p.id}/anonymize`, { version: p.version })).status,
    ).toBe(409);
    await o.owner.post(`/clinic/appointments/${appointment.body.data.id}/cancel`, {
      version: appointment.body.data.version,
      reason: 'Patient moved away',
    });
    const done = await o.owner.post(`/clinic/patients/${p.id}/anonymize`, { version: p.version });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'ANONYMIZED',
      displayName: 'Anonymized patient PAT-00001',
      dateOfBirth: null,
      phone: null,
      email: null,
      nationalId: null,
      billingCustomerId: null,
    });
    expect(
      (
        await o.owner.put(`/clinic/patients/${p.id}`, {
          version: done.body.data.version,
          displayName: 'x',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.post(`/clinic/patients/${p.id}/anonymize`, {
          version: done.body.data.version,
        })
      ).status,
    ).toBe(409);
    expect((await book(o, p.id, '2026-03-13T09:00:00Z')).status).toBe(400);
    expect((await o.owner.get('/clinic/appointments')).body.data).toHaveLength(1);
    await expect(
      db.query(`UPDATE clinic_patients SET display_name = 'x' WHERE id = $1`, [p.id]),
    ).rejects.toThrow(/final/);
    await expect(db.query(`DELETE FROM clinic_patients WHERE id = $1`, [p.id])).rejects.toThrow(
      /never deleted/,
    );
    const stored = await db.query(
      `SELECT phone, email, national_id FROM clinic_patients WHERE id = $1`,
      [p.id],
    );
    expect(stored.rows[0]).toEqual({ phone: null, email: null, national_id: null });
  });
});

describe('appointments', () => {
  it('prevents double booking, even when two requests race', async () => {
    const o = await clinicOrg();
    const a = await newPatient(o);
    const b = await newPatient(o, { displayName: 'Ahmed Ali' });
    const first = await book(o, a.id, '2026-03-10T09:00:00Z');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.data.endsAt).toBe('2026-03-10T09:30:00.000Z');
    expect(first.body.data.price).toBe('300');
    expect((await book(o, b.id, '2026-03-10T09:15:00Z')).status).toBe(409); // overlaps
    expect((await book(o, b.id, '2026-03-10T08:45:00Z')).status).toBe(409); // overlaps the start
    expect((await book(o, b.id, '2026-03-10T09:30:00Z')).status).toBe(201); // back to back is fine
    const race = await Promise.all([
      book(o, a.id, '2026-03-11T09:00:00Z'),
      book(o, b.id, '2026-03-11T09:10:00Z'),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    // The database refuses it as well.
    await expect(
      db.query(
        `INSERT INTO clinic_appointments (organization_id, number, patient_id, practitioner_id, service_id,
           starts_at, ends_at, price, created_by_user_id, created_at, updated_at)
         SELECT organization_id, 'X-1', patient_id, practitioner_id, service_id,
                starts_at + interval '5 minutes', ends_at, price, created_by_user_id, now(), now()
           FROM clinic_appointments WHERE id = $1`,
        [first.body.data.id],
      ),
    ).rejects.toThrow(/already booked/);
    // A cancelled slot is free again.
    const c = await book(o, a.id, '2026-03-12T10:00:00Z');
    await o.owner.post(`/clinic/appointments/${c.body.data.id}/cancel`, {
      version: c.body.data.version,
      reason: 'Sick',
    });
    expect((await book(o, b.id, '2026-03-12T10:00:00Z')).status).toBe(201);
  });

  it('walks booked, checked in, completed; moves and cancels; refuses illegal steps', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o);
    const booked = (await book(o, p.id, '2026-03-10T09:00:00Z', { note: 'Bring old reports' })).body
      .data;
    expect(booked).toMatchObject({
      number: 'APT-00001',
      status: 'BOOKED',
      note: 'Bring old reports',
    });
    expect(
      (
        await o.owner.post(`/clinic/appointments/${booked.id}/complete`, {
          version: booked.version,
        })
      ).status,
    ).toBe(409);
    const moved = await o.owner.post(`/clinic/appointments/${booked.id}/reschedule`, {
      version: booked.version,
      startsAt: '2026-03-10T11:00:00Z',
    });
    expect(moved.body.data.startsAt).toBe('2026-03-10T11:00:00.000Z');
    const checked = await o.owner.post(`/clinic/appointments/${booked.id}/check-in`, {
      version: moved.body.data.version,
    });
    expect(checked.body.data.status).toBe('CHECKED_IN');
    expect(
      (
        await o.owner.post(`/clinic/appointments/${booked.id}/reschedule`, {
          version: checked.body.data.version,
          startsAt: '2026-03-10T12:00:00Z',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await o.owner.post(`/clinic/appointments/${booked.id}/cancel`, {
          version: checked.body.data.version,
          reason: ' ',
        })
      ).status,
    ).toBe(400);
    const done = await o.owner.post(`/clinic/appointments/${booked.id}/complete`, {
      version: checked.body.data.version,
    });
    expect(done.body.data.status).toBe('COMPLETED');
    expect(
      (
        await o.owner.post(`/clinic/appointments/${booked.id}/cancel`, {
          version: done.body.data.version,
          reason: 'x',
        })
      ).status,
    ).toBe(409);
    const missed = (await book(o, p.id, '2026-03-14T09:00:00Z')).body.data;
    const noShow = await o.owner.post(`/clinic/appointments/${missed.id}/no-show`, {
      version: missed.version,
    });
    expect(noShow.body.data.status).toBe('NO_SHOW');
    await expect(
      db.query(`DELETE FROM clinic_appointments WHERE id = $1`, [missed.id]),
    ).rejects.toThrow(/never deleted/);
    // Inactive services and practitioners cannot be booked.
    await o.owner.put(`/clinic/services/${o.serviceId}`, {
      version: 1,
      isActive: false,
      name: 'General consultation',
      price: '300',
      durationMinutes: 30,
    });
    expect((await book(o, p.id, '2026-03-20T09:00:00Z')).status).toBe(400);
  });
});

describe('billing', () => {
  it('bills a completed appointment into exactly one draft invoice without the patient name', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o);
    const booked = (await book(o, p.id, '2026-03-10T09:00:00Z')).body.data;
    expect(
      (await o.owner.post(`/clinic/appointments/${booked.id}/bill`, { version: booked.version }))
        .status,
    ).toBe(409); // not completed
    const done = await completed(o, p.id, '2026-03-11T09:00:00Z');
    const bills = await Promise.all([
      o.owner.post(`/clinic/appointments/${done.id}/bill`, { version: done.version }),
      o.owner.post(`/clinic/appointments/${done.id}/bill`, { version: done.version }),
    ]);
    expect(bills.map((r) => r.status).sort()).toEqual([200, 409]);
    const billed = bills.find((r) => r.status === 200)!.body.data;
    const invoice = (await o.owner.get(`/sales/invoices/${billed.invoiceId}`)).body.data;
    expect(invoice).toMatchObject({ status: 'DRAFT', total: '300.00', reference: done.number });
    expect(JSON.stringify(invoice)).not.toContain('Aisha');
    expect(invoice.lines[0].description).toBe('General consultation');
    const count = await db.query(
      `SELECT count(*)::int AS n FROM sales_invoices WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(count.rows[0].n).toBe(1);
    const journals = await db.query(
      `SELECT count(*)::int AS n FROM accounting_journal_entries WHERE organization_id = $1`,
      [o.organizationId],
    );
    expect(journals.rows[0].n).toBe(0);
    expect(
      (
        await o.owner.post(`/clinic/appointments/${done.id}/bill`, {
          version: billed.appointment?.version ?? 99,
        })
      ).status,
    ).toBe(409);
  });

  it('needs a billing customer, and needs invoices.create as well as clinic.billing.create', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o, { billingCustomerId: null });
    const done = await completed(o, p.id);
    const none = await o.owner.post(`/clinic/appointments/${done.id}/bill`, {
      version: done.version,
    });
    expect(none.status).toBe(400);
    expect(none.body.error.details.issues[0].path).toBe('customerId');
    await o.owner.post('/organizations/current/roles', {
      name: 'Clinic biller',
      permissionKeys: ['clinic.billing.create'],
    });
    const biller = await joinWithRole(ctx, o.owner, 'Clinic biller');
    const denied = await biller.client.post(`/clinic/appointments/${done.id}/bill`, {
      version: done.version,
      customerId: o.customerId,
    });
    expect(denied.status).toBe(403);
    const ok = await o.owner.post(`/clinic/appointments/${done.id}/bill`, {
      version: done.version,
      customerId: o.customerId,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('reports, permissions and isolation', () => {
  it('reports counts, no-show rate and revenue without any personal data', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o);
    const done = await completed(o, p.id, '2026-03-10T09:00:00Z');
    await o.owner.post(`/clinic/appointments/${done.id}/bill`, { version: done.version });
    await completed(o, p.id, '2026-03-11T09:00:00Z');
    const missed = (await book(o, p.id, '2026-03-12T09:00:00Z')).body.data;
    await o.owner.post(`/clinic/appointments/${missed.id}/no-show`, { version: missed.version });
    const report = (await o.owner.get('/clinic/reports?from=2026-03-01&to=2026-03-31')).body.data;
    expect(report.totals).toMatchObject({ completed: 2, noShow: 1, noShowRate: '33.3' });
    expect(report.unbilledCompleted).toBe(1);
    expect(report.byService).toEqual([
      expect.objectContaining({
        serviceName: 'General consultation',
        completed: 2,
        billed: 1,
        value: '600',
        billedValue: '300',
      }),
    ]);
    expect(report.byPractitionerAndDay[0].practitionerName).toBe('Dr. Hassan');
    expect(JSON.stringify(report)).not.toMatch(/Aisha|A1234567|7771234/);
    expect((await o.owner.get('/clinic/reports?from=2026-03-31&to=2026-03-01')).status).toBe(400);
  });

  it('gives members and view-only roles nothing, and isolates tenants', async () => {
    const o = await clinicOrg();
    const p = await newPatient(o);
    const a = (await book(o, p.id, '2026-03-10T09:00:00Z')).body.data;
    const member = await joinWithRole(ctx, o.owner, 'Member');
    for (const path of [
      '/clinic/patients',
      `/clinic/patients/${p.id}`,
      '/clinic/appointments',
      '/clinic/services',
      '/clinic/practitioners',
      '/clinic/reports?from=2026-03-01&to=2026-03-31',
    ]) {
      expect((await member.client.get(path)).status, path).toBe(403);
    }
    await o.owner.post('/organizations/current/roles', {
      name: 'Reception',
      permissionKeys: ['clinic.appointments.manage'],
    });
    const reception = await joinWithRole(ctx, o.owner, 'Reception');
    expect((await reception.client.get('/clinic/appointments')).status).toBe(200);
    expect((await reception.client.get('/clinic/patients')).status).toBe(403); // no patients.view
    expect((await reception.client.post('/clinic/patients', { displayName: 'x' })).status).toBe(
      403,
    );
    expect(
      (await reception.client.post(`/clinic/patients/${p.id}/anonymize`, { version: p.version }))
        .status,
    ).toBe(403);
    // Another organization cannot see or use any of it.
    const other = await clinicOrg();
    expect((await other.owner.get('/clinic/patients')).body.data).toEqual([]);
    expect((await other.owner.get(`/clinic/patients/${p.id}`)).status).toBe(404);
    expect(
      (await other.owner.post(`/clinic/appointments/${a.id}/check-in`, { version: a.version }))
        .status,
    ).toBe(404);
    expect(
      (
        await other.owner.post('/clinic/appointments', {
          patientId: p.id,
          practitionerId: other.practitionerId,
          serviceId: other.serviceId,
          startsAt: '2026-03-10T09:00:00Z',
        })
      ).status,
    ).toBe(400);
    // Switching the module off hides everything again, and the data survives.
    await o.owner.put('/organizations/current/modules/clinic', { enabled: false });
    expect((await o.owner.get('/clinic/patients')).body.error.code).toBe('MODULE_DISABLED');
    await o.owner.put('/organizations/current/modules/clinic', { enabled: true });
    expect((await o.owner.get('/clinic/patients')).body.data).toHaveLength(1);
  });
});
