import {
  ConflictError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type ValidationIssue,
} from '../domain/errors.js';
import { decimal } from '../domain/money.js';
import type { Transaction } from '../database/client.js';
import { recordAuditEvent, type EventOrigin } from '../modules/audit/index.js';
import {
  appointmentCounts,
  ClinicPermissions,
  getAppointment,
  getClinicService,
  getPatient,
  getPractitioner,
  insertAppointment,
  insertClinicService,
  insertPatient,
  insertPractitioner,
  listAppointments,
  listClinicServices,
  listPatients,
  listPractitioners,
  lockPractitioner,
  overlappingAppointment,
  serviceRevenue,
  takeNextClinicNumber,
  updateAppointment,
  updateClinicService,
  updatePatient,
  updatePractitioner,
  type Appointment,
  type AppointmentStatus,
  type ClinicService as ClinicServiceRow,
  type Patient,
  type Practitioner,
} from '../modules/clinic/index.js';
import { getCustomer } from '../modules/customers/index.js';
import { getItem, SalesPermissions } from '../modules/sales/index.js';
import { requireAccountingSettings } from './accounting-service.js';
import { hasPermission, type AuthorizationContext, type Principal } from './authorization.js';
import type { AppDependencies } from './dependencies.js';
import type { InvoiceService } from './invoice-service.js';
import { withOrganization } from './organization-service.js';

/**
 * Clinic extension v1 (FP-27, ADR 0013; migration 0069). Administrative and billing data only:
 * patients, services, practitioners, appointments, and billing of completed appointments into
 * ONE draft sales invoice each. Every patient record view is audited; the national id is masked
 * everywhere; a patient is anonymized, never deleted. The module must be enabled per organization.
 */

const MODULE = 'clinic' as const;
const versionConflict = (noun: string) =>
  new ConflictError('VERSION_CONFLICT', `The ${noun} changed; reload it and try again.`);
const invalidState = (message: string) => new ConflictError('INVALID_STATE_TRANSITION', message);
const mask = (value: string | null) =>
  value === null ? null : `${'•'.repeat(Math.max(0, value.length - 3))}${value.slice(-3)}`;

export interface PatientInput {
  displayName: string;
  dateOfBirth?: string | null | undefined;
  sex?: 'female' | 'male' | 'other' | 'undisclosed' | null | undefined;
  phone?: string | null | undefined;
  email?: string | null | undefined;
  nationalId?: string | null | undefined;
  billingCustomerId?: string | null | undefined;
}

const isDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export class ClinicService {
  constructor(
    private readonly deps: AppDependencies,
    private readonly invoices: InvoiceService,
  ) {}

  private get now() {
    return this.deps.clock.now();
  }

  private audit(
    tx: Transaction,
    ctx: Pick<AuthorizationContext, 'organizationId' | 'userId'>,
    action: string,
    resourceType: string,
    resourceId: string,
    origin: EventOrigin,
    metadata: Record<string, unknown> = {},
  ) {
    // Metadata never carries names, contact details or national ids (ADR 0013).
    return recordAuditEvent(tx, {
      occurredAt: this.now,
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      origin,
    });
  }

  private run<T>(
    principal: Principal,
    permission: string,
    work: (tx: Transaction, ctx: AuthorizationContext) => Promise<T>,
    options: { readOnly?: boolean } = {},
  ) {
    return withOrganization(
      this.deps,
      principal,
      {
        permission,
        module: MODULE,
        ...(options.readOnly ? { readOnlySnapshot: true } : {}),
      },
      work,
    );
  }

  // ---------------------------------------------------------------------------
  // Patients
  // ---------------------------------------------------------------------------

  private patientView(p: Patient) {
    return {
      id: p.id,
      number: p.number,
      displayName: p.displayName,
      dateOfBirth: p.dateOfBirth,
      sex: p.sex,
      phone: p.phone,
      email: p.email,
      nationalId: mask(p.nationalId),
      billingCustomerId: p.billingCustomerId,
      status: p.status,
      version: p.version,
    };
  }

  /** Listing is audited as one event with the number of records returned. */
  listPatients(
    principal: Principal,
    filter: { search?: string | undefined; limit: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsView, async (tx, ctx) => {
      const rows = await listPatients(tx, ctx.organizationId, filter);
      await this.audit(
        tx,
        ctx,
        'clinic.patients_listed',
        'clinic_patient',
        ctx.organizationId,
        origin,
        {
          returned: rows.length,
          searched: Boolean(filter.search),
        },
      );
      return rows.map((p) => this.patientView(p));
    });
  }

  /** Opening a record is audited (ADR 0013). */
  getPatient(principal: Principal, id: string, origin: EventOrigin) {
    return this.run(principal, ClinicPermissions.PatientsView, async (tx, ctx) => {
      const patient = await getPatient(tx, ctx.organizationId, id);
      if (!patient) throw new NotFoundError('Patient not found.');
      await this.audit(tx, ctx, 'clinic.patient_viewed', 'clinic_patient', id, origin, {
        number: patient.number,
      });
      return this.patientView(patient);
    });
  }

  private async validatePatient(tx: Transaction, ctx: AuthorizationContext, input: PatientInput) {
    const issues: ValidationIssue[] = [];
    if (!input.displayName.trim()) issues.push({ path: 'displayName', message: 'Enter a name.' });
    if (input.dateOfBirth) {
      if (!isDate(input.dateOfBirth)) {
        issues.push({ path: 'dateOfBirth', message: 'Enter a valid date (YYYY-MM-DD).' });
      } else if (input.dateOfBirth > this.now.toISOString().slice(0, 10)) {
        issues.push({ path: 'dateOfBirth', message: 'The date of birth is in the future.' });
      }
    }
    if (
      input.billingCustomerId &&
      !(await getCustomer(tx, ctx.organizationId, input.billingCustomerId))
    ) {
      issues.push({
        path: 'billingCustomerId',
        message: 'Choose a customer of this organization.',
      });
    }
    if (issues.length) throw new ValidationError(issues);
  }

  createPatient(principal: Principal, input: PatientInput, origin: EventOrigin) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      await requireAccountingSettings(tx, ctx.organizationId);
      await this.validatePatient(tx, ctx, input);
      const now = this.now;
      const patient = await insertPatient(tx, {
        organizationId: ctx.organizationId,
        number: await takeNextClinicNumber(tx, ctx.organizationId, 'patient'),
        displayName: input.displayName.trim(),
        dateOfBirth: input.dateOfBirth || null,
        sex: input.sex ?? null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        nationalId: input.nationalId?.trim() || null,
        billingCustomerId: input.billingCustomerId ?? null,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(tx, ctx, 'clinic.patient_created', 'clinic_patient', patient.id, origin, {
        number: patient.number,
      });
      return this.patientView(patient);
    });
  }

  updatePatient(
    principal: Principal,
    id: string,
    input: PatientInput & { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      const existing = await getPatient(tx, ctx.organizationId, id);
      if (!existing) throw new NotFoundError('Patient not found.');
      if (existing.status === 'ANONYMIZED')
        throw invalidState('An anonymized patient cannot be edited.');
      await this.validatePatient(tx, ctx, input);
      const updated = await updatePatient(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          displayName: input.displayName.trim(),
          dateOfBirth: input.dateOfBirth || null,
          sex: input.sex ?? null,
          phone: input.phone?.trim() || null,
          email: input.email?.trim() || null,
          // Omitted keeps the stored id; an empty string clears it.
          ...(input.nationalId === undefined
            ? {}
            : { nationalId: input.nationalId?.trim() || null }),
          billingCustomerId: input.billingCustomerId ?? null,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('patient');
      await this.audit(tx, ctx, 'clinic.patient_updated', 'clinic_patient', id, origin, {
        number: updated.number,
      });
      return this.patientView(updated);
    });
  }

  /** Clears the personal fields for good; the row, appointments and invoices stay. */
  anonymizePatient(
    principal: Principal,
    id: string,
    input: { version: number },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      const existing = await getPatient(tx, ctx.organizationId, id);
      if (!existing) throw new NotFoundError('Patient not found.');
      if (existing.status === 'ANONYMIZED')
        throw invalidState('The patient is already anonymized.');
      const open = await listAppointments(tx, ctx.organizationId, {
        patientId: id,
        limit: 500,
      });
      if (open.some((a) => a.status === 'BOOKED' || a.status === 'CHECKED_IN')) {
        throw invalidState('Cancel or complete the patient’s open appointments first.');
      }
      const now = this.now;
      const updated = await updatePatient(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          displayName: `Anonymized patient ${existing.number}`,
          dateOfBirth: null,
          sex: null,
          phone: null,
          email: null,
          nationalId: null,
          billingCustomerId: null,
          status: 'ANONYMIZED',
          anonymizedAt: now,
          anonymizedByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
          updatedAt: now,
        },
      });
      if (!updated) throw versionConflict('patient');
      await this.audit(tx, ctx, 'clinic.patient_anonymized', 'clinic_patient', id, origin, {
        number: updated.number,
      });
      return this.patientView(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Services and practitioners
  // ---------------------------------------------------------------------------

  private serviceView(s: ClinicServiceRow) {
    return {
      id: s.id,
      name: s.name,
      salesItemId: s.salesItemId,
      price: decimal(s.price).toFixed(),
      durationMinutes: s.durationMinutes,
      isActive: s.isActive,
      version: s.version,
    };
  }

  listServices(principal: Principal) {
    return this.run(
      principal,
      ClinicPermissions.AppointmentsManage,
      async (tx, ctx) =>
        (await listClinicServices(tx, ctx.organizationId)).map((s) => this.serviceView(s)),
      { readOnly: true },
    );
  }

  private async validateService(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: {
      name: string;
      price: string;
      durationMinutes: number;
      salesItemId?: string | null | undefined;
    },
  ) {
    const issues: ValidationIssue[] = [];
    if (!input.name.trim()) issues.push({ path: 'name', message: 'Enter a name.' });
    if (decimal(input.price).lt(0)) issues.push({ path: 'price', message: 'Enter zero or more.' });
    if (input.salesItemId && !(await getItem(tx, ctx.organizationId, input.salesItemId))) {
      issues.push({ path: 'salesItemId', message: 'Choose an item of this organization.' });
    }
    if (issues.length) throw new ValidationError(issues);
  }

  createService(
    principal: Principal,
    input: {
      name: string;
      price: string;
      durationMinutes: number;
      salesItemId?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      await this.validateService(tx, ctx, input);
      const now = this.now;
      const row = await insertClinicService(tx, {
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        salesItemId: input.salesItemId ?? null,
        price: decimal(input.price).toFixed(4),
        durationMinutes: input.durationMinutes,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(tx, ctx, 'clinic.service_created', 'clinic_service', row.id, origin, {
        price: row.price,
      });
      return this.serviceView(row);
    });
  }

  updateService(
    principal: Principal,
    id: string,
    input: {
      version: number;
      name: string;
      price: string;
      durationMinutes: number;
      isActive: boolean;
      salesItemId?: string | null | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      if (!(await getClinicService(tx, ctx.organizationId, id))) {
        throw new NotFoundError('Service not found.');
      }
      await this.validateService(tx, ctx, input);
      const row = await updateClinicService(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          name: input.name.trim(),
          salesItemId: input.salesItemId ?? null,
          price: decimal(input.price).toFixed(4),
          durationMinutes: input.durationMinutes,
          isActive: input.isActive,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!row) throw versionConflict('service');
      await this.audit(tx, ctx, 'clinic.service_updated', 'clinic_service', id, origin, {
        price: row.price,
        isActive: row.isActive,
      });
      return this.serviceView(row);
    });
  }

  private practitionerView(p: Practitioner) {
    return {
      id: p.id,
      displayName: p.displayName,
      specialty: p.specialty,
      linked: p.userId !== null,
      isActive: p.isActive,
      version: p.version,
    };
  }

  listPractitioners(principal: Principal) {
    return this.run(
      principal,
      ClinicPermissions.AppointmentsManage,
      async (tx, ctx) =>
        (await listPractitioners(tx, ctx.organizationId)).map((p) => this.practitionerView(p)),
      { readOnly: true },
    );
  }

  createPractitioner(
    principal: Principal,
    input: { displayName: string; specialty?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      if (!input.displayName.trim()) {
        throw new ValidationError([{ path: 'displayName', message: 'Enter a name.' }]);
      }
      const now = this.now;
      const row = await insertPractitioner(tx, {
        organizationId: ctx.organizationId,
        displayName: input.displayName.trim(),
        specialty: (input.specialty ?? '').trim(),
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(
        tx,
        ctx,
        'clinic.practitioner_created',
        'clinic_practitioner',
        row.id,
        origin,
      );
      return this.practitionerView(row);
    });
  }

  updatePractitioner(
    principal: Principal,
    id: string,
    input: {
      version: number;
      displayName: string;
      specialty?: string | undefined;
      isActive: boolean;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.PatientsManage, async (tx, ctx) => {
      if (!(await getPractitioner(tx, ctx.organizationId, id))) {
        throw new NotFoundError('Practitioner not found.');
      }
      const row = await updatePractitioner(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          displayName: input.displayName.trim(),
          specialty: (input.specialty ?? '').trim(),
          isActive: input.isActive,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!row) throw versionConflict('practitioner');
      await this.audit(tx, ctx, 'clinic.practitioner_updated', 'clinic_practitioner', id, origin, {
        isActive: row.isActive,
      });
      return this.practitionerView(row);
    });
  }

  // ---------------------------------------------------------------------------
  // Appointments
  // ---------------------------------------------------------------------------

  private appointmentView(a: Appointment) {
    return {
      id: a.id,
      number: a.number,
      patientId: a.patientId,
      practitionerId: a.practitionerId,
      serviceId: a.serviceId,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      status: a.status,
      note: a.note,
      price: decimal(a.price).toFixed(),
      cancelReason: a.cancelReason,
      invoiceId: a.invoiceId,
      version: a.version,
    };
  }

  listAppointments(
    principal: Principal,
    filter: {
      from?: string | undefined;
      to?: string | undefined;
      practitionerId?: string | undefined;
      patientId?: string | undefined;
      status?: AppointmentStatus | undefined;
      limit: number;
    },
  ) {
    return this.run(
      principal,
      ClinicPermissions.AppointmentsManage,
      async (tx, ctx) =>
        (await listAppointments(tx, ctx.organizationId, filter)).map((a) =>
          this.appointmentView(a),
        ),
      { readOnly: true },
    );
  }

  private async slot(
    tx: Transaction,
    ctx: AuthorizationContext,
    input: { practitionerId: string; serviceId: string; startsAt: string },
    excludeId?: string,
  ) {
    const issues: ValidationIssue[] = [];
    const start = new Date(input.startsAt);
    if (Number.isNaN(start.getTime())) {
      issues.push({ path: 'startsAt', message: 'Enter a valid date and time.' });
    }
    const practitioner = await lockPractitioner(tx, ctx.organizationId, input.practitionerId);
    if (!practitioner) issues.push({ path: 'practitionerId', message: 'Choose a practitioner.' });
    else if (!practitioner.isActive)
      issues.push({ path: 'practitionerId', message: 'The practitioner is inactive.' });
    const service = await getClinicService(tx, ctx.organizationId, input.serviceId);
    if (!service) issues.push({ path: 'serviceId', message: 'Choose a service.' });
    else if (!service.isActive)
      issues.push({ path: 'serviceId', message: 'The service is inactive.' });
    if (issues.length) throw new ValidationError(issues);
    const end = new Date(start.getTime() + service!.durationMinutes * 60_000);
    const clash = await overlappingAppointment(tx, {
      organizationId: ctx.organizationId,
      practitionerId: input.practitionerId,
      startsAt: start,
      endsAt: end,
      excludeId,
    });
    if (clash) {
      throw new ConflictError('CONFLICT', 'The practitioner is already booked at that time.');
    }
    return { start, end, service: service! };
  }

  bookAppointment(
    principal: Principal,
    input: {
      patientId: string;
      practitionerId: string;
      serviceId: string;
      startsAt: string;
      note?: string | undefined;
    },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.AppointmentsManage, async (tx, ctx) => {
      const patient = await getPatient(tx, ctx.organizationId, input.patientId);
      if (!patient)
        throw new ValidationError([{ path: 'patientId', message: 'Choose a patient.' }]);
      if (patient.status !== 'ACTIVE') {
        throw new ValidationError([{ path: 'patientId', message: 'The patient is anonymized.' }]);
      }
      const { start, end, service } = await this.slot(tx, ctx, input);
      const now = this.now;
      const row = await insertAppointment(tx, {
        organizationId: ctx.organizationId,
        number: await takeNextClinicNumber(tx, ctx.organizationId, 'appointment'),
        patientId: input.patientId,
        practitionerId: input.practitionerId,
        serviceId: input.serviceId,
        startsAt: start,
        endsAt: end,
        note: (input.note ?? '').trim(),
        price: service.price,
        createdByUserId: ctx.userId,
        createdAt: now,
        updatedAt: now,
      });
      await this.audit(tx, ctx, 'clinic.appointment_booked', 'clinic_appointment', row.id, origin, {
        number: row.number,
        startsAt: row.startsAt.toISOString(),
      });
      return this.appointmentView(row);
    });
  }

  private async transition(
    principal: Principal,
    id: string,
    input: { version: number; reason?: string | undefined },
    to: 'CHECKED_IN' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW',
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.AppointmentsManage, async (tx, ctx) => {
      const a = await getAppointment(tx, ctx.organizationId, id, { forUpdate: true });
      if (!a) throw new NotFoundError('Appointment not found.');
      if (a.version !== input.version) throw versionConflict('appointment');
      const allowed: Record<typeof to, AppointmentStatus[]> = {
        CHECKED_IN: ['BOOKED'],
        COMPLETED: ['CHECKED_IN'],
        CANCELLED: ['BOOKED', 'CHECKED_IN'],
        NO_SHOW: ['BOOKED'],
      };
      if (!allowed[to].includes(a.status)) {
        throw invalidState(
          `A ${a.status.toLowerCase().replace('_', ' ')} appointment cannot become ${to.toLowerCase().replace('_', ' ')}.`,
        );
      }
      const reason = input.reason?.trim();
      if (to === 'CANCELLED' && !reason) {
        throw new ValidationError([{ path: 'reason', message: 'Give a reason.' }]);
      }
      const updated = await updateAppointment(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          status: to,
          ...(to === 'CANCELLED' ? { cancelReason: reason! } : {}),
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('appointment');
      await this.audit(
        tx,
        ctx,
        `clinic.appointment_${to.toLowerCase()}`,
        'clinic_appointment',
        id,
        origin,
        {
          number: a.number,
        },
      );
      return this.appointmentView(updated);
    });
  }

  checkIn(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.transition(principal, id, input, 'CHECKED_IN', origin);
  }
  complete(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.transition(principal, id, input, 'COMPLETED', origin);
  }
  cancel(
    principal: Principal,
    id: string,
    input: { version: number; reason: string },
    origin: EventOrigin,
  ) {
    return this.transition(principal, id, input, 'CANCELLED', origin);
  }
  noShow(principal: Principal, id: string, input: { version: number }, origin: EventOrigin) {
    return this.transition(principal, id, input, 'NO_SHOW', origin);
  }

  reschedule(
    principal: Principal,
    id: string,
    input: { version: number; startsAt: string; practitionerId?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.AppointmentsManage, async (tx, ctx) => {
      const a = await getAppointment(tx, ctx.organizationId, id, { forUpdate: true });
      if (!a) throw new NotFoundError('Appointment not found.');
      if (a.version !== input.version) throw versionConflict('appointment');
      if (a.status !== 'BOOKED') throw invalidState('Only a booked appointment can be moved.');
      const { start, end } = await this.slot(
        tx,
        ctx,
        {
          practitionerId: input.practitionerId ?? a.practitionerId,
          serviceId: a.serviceId,
          startsAt: input.startsAt,
        },
        id,
      );
      const updated = await updateAppointment(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: {
          practitionerId: input.practitionerId ?? a.practitionerId,
          startsAt: start,
          endsAt: end,
          updatedByUserId: ctx.userId,
          updatedAt: this.now,
        },
      });
      if (!updated) throw versionConflict('appointment');
      await this.audit(tx, ctx, 'clinic.appointment_moved', 'clinic_appointment', id, origin, {
        number: a.number,
        startsAt: start.toISOString(),
      });
      return this.appointmentView(updated);
    });
  }

  /**
   * Bills a COMPLETED appointment into ONE draft sales invoice (the service name and price; no
   * patient name on the invoice). Needs `clinic.billing.create` and `invoices.create`. Repeating
   * the request returns a conflict; the unique invoice link makes a double bill impossible.
   */
  bill(
    principal: Principal,
    id: string,
    input: { version: number; customerId?: string | undefined; invoiceDate?: string | undefined },
    origin: EventOrigin,
  ) {
    return this.run(principal, ClinicPermissions.BillingCreate, async (tx, ctx) => {
      if (!hasPermission(ctx, SalesPermissions.InvoicesCreate)) throw new PermissionDeniedError();
      const a = await getAppointment(tx, ctx.organizationId, id, { forUpdate: true });
      if (!a) throw new NotFoundError('Appointment not found.');
      if (a.version !== input.version) throw versionConflict('appointment');
      if (a.invoiceId) throw invalidState('The appointment was already billed.');
      if (a.status !== 'COMPLETED')
        throw invalidState('Only a completed appointment can be billed.');
      const patient = await getPatient(tx, ctx.organizationId, a.patientId);
      const customerId = input.customerId ?? patient?.billingCustomerId ?? undefined;
      if (!customerId) {
        throw new ValidationError([
          {
            path: 'customerId',
            message: 'Choose who is billed: the patient has no billing customer.',
          },
        ]);
      }
      const service = await getClinicService(tx, ctx.organizationId, a.serviceId);
      const invoiceDate = input.invoiceDate ?? this.now.toISOString().slice(0, 10);
      const invoice = await this.invoices.createDraftInTransaction(
        tx,
        ctx,
        {
          customerId,
          invoiceDate,
          reference: a.number,
          lines: [
            {
              ...(service?.salesItemId ? { itemId: service.salesItemId } : {}),
              description: service?.name ?? 'Clinic service',
              quantity: '1',
              unitPrice: decimal(a.price).toFixed(),
            },
          ],
        },
        origin,
      );
      const now = this.now;
      const updated = await updateAppointment(tx, {
        organizationId: ctx.organizationId,
        id,
        version: input.version,
        set: { invoiceId: invoice.id, billedAt: now, updatedByUserId: ctx.userId, updatedAt: now },
      });
      if (!updated) throw versionConflict('appointment');
      await this.audit(tx, ctx, 'clinic.appointment_billed', 'clinic_appointment', id, origin, {
        number: a.number,
        invoiceId: invoice.id,
      });
      return { appointment: this.appointmentView(updated), invoiceId: invoice.id };
    });
  }

  // ---------------------------------------------------------------------------
  // Reports (no personal data)
  // ---------------------------------------------------------------------------

  reports(principal: Principal, input: { from: string; to: string }) {
    if (!isDate(input.from) || !isDate(input.to) || input.from > input.to) {
      throw new ValidationError([{ path: 'from', message: 'Enter a valid period.' }]);
    }
    const from = `${input.from}T00:00:00Z`;
    const to = new Date(Date.parse(`${input.to}T00:00:00Z`) + 86_400_000).toISOString();
    return this.run(
      principal,
      ClinicPermissions.ReportsView,
      async (tx, ctx) => {
        const [counts, revenue, practitioners, services, unbilled] = await Promise.all([
          appointmentCounts(tx, ctx.organizationId, from, to),
          serviceRevenue(tx, ctx.organizationId, from, to),
          listPractitioners(tx, ctx.organizationId),
          listClinicServices(tx, ctx.organizationId),
          listAppointments(tx, ctx.organizationId, { status: 'COMPLETED', from, to, limit: 1000 }),
        ]);
        const total = (status: AppointmentStatus) =>
          counts.filter((c) => c.status === status).reduce((s, c) => s + c.n, 0);
        const noShow = total('NO_SHOW');
        const closed = total('COMPLETED') + noShow;
        return {
          from: input.from,
          to: input.to,
          totals: {
            booked: total('BOOKED'),
            checkedIn: total('CHECKED_IN'),
            completed: total('COMPLETED'),
            cancelled: total('CANCELLED'),
            noShow,
            noShowRate: closed === 0 ? null : ((noShow / closed) * 100).toFixed(1),
          },
          byPractitionerAndDay: counts.map((c) => ({
            practitionerId: c.practitioner_id,
            practitionerName:
              practitioners.find((p) => p.id === c.practitioner_id)?.displayName ?? null,
            day: c.day,
            status: c.status,
            count: c.n,
          })),
          byService: revenue.map((r) => ({
            serviceId: r.service_id,
            serviceName: services.find((s) => s.id === r.service_id)?.name ?? null,
            completed: r.completed,
            billed: r.billed,
            value: decimal(r.value).toFixed(),
            billedValue: decimal(r.billed_value).toFixed(),
          })),
          unbilledCompleted: unbilled.filter((a) => !a.invoiceId).length,
        };
      },
      { readOnly: true },
    );
  }
}
