import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../../database/client.js';
import {
  clinicAppointments,
  clinicNumberSequences,
  clinicPatients,
  clinicPractitioners,
  clinicServices,
  type AppointmentStatus,
} from './schema.js';

export type Patient = typeof clinicPatients.$inferSelect;
export type ClinicService = typeof clinicServices.$inferSelect;
export type Practitioner = typeof clinicPractitioners.$inferSelect;
export type Appointment = typeof clinicAppointments.$inferSelect;

export async function takeNextClinicNumber(
  tx: Transaction,
  organizationId: string,
  documentType: 'patient' | 'appointment',
) {
  await tx
    .insert(clinicNumberSequences)
    .values({ organizationId, documentType, prefix: documentType === 'patient' ? 'PAT-' : 'APT-' })
    .onConflictDoNothing();
  const [row] = await tx
    .update(clinicNumberSequences)
    .set({ nextNumber: sql`${clinicNumberSequences.nextNumber} + 1` })
    .where(
      and(
        eq(clinicNumberSequences.organizationId, organizationId),
        eq(clinicNumberSequences.documentType, documentType),
      ),
    )
    .returning();
  const value = BigInt(row!.nextNumber) - 1n;
  return `${row!.prefix}${value.toString().padStart(row!.minDigits, '0')}`;
}

// Patients -----------------------------------------------------------------

export async function insertPatient(tx: Transaction, values: typeof clinicPatients.$inferInsert) {
  const [row] = await tx.insert(clinicPatients).values(values).returning();
  return row!;
}

export async function getPatient(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(clinicPatients)
    .where(and(eq(clinicPatients.organizationId, organizationId), eq(clinicPatients.id, id)));
  return row;
}

export async function listPatients(
  tx: Transaction,
  organizationId: string,
  filter: { search?: string | undefined; limit: number },
) {
  return tx
    .select()
    .from(clinicPatients)
    .where(
      and(
        eq(clinicPatients.organizationId, organizationId),
        filter.search
          ? sql`(lower(${clinicPatients.displayName}) LIKE ${`%${filter.search.toLowerCase().replace(/[%_\\]/g, '\\$&')}%`} OR ${clinicPatients.number} = ${filter.search.toUpperCase()})`
          : sql`true`,
      ),
    )
    .orderBy(asc(clinicPatients.displayName), asc(clinicPatients.id))
    .limit(filter.limit);
}

export async function updatePatient(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof clinicPatients.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(clinicPatients)
    .set({ ...input.set, version: sql`${clinicPatients.version} + 1` })
    .where(
      and(
        eq(clinicPatients.organizationId, input.organizationId),
        eq(clinicPatients.id, input.id),
        eq(clinicPatients.version, input.version),
      ),
    )
    .returning();
  return row;
}

// Services -------------------------------------------------------------------

export async function insertClinicService(
  tx: Transaction,
  values: typeof clinicServices.$inferInsert,
) {
  const [row] = await tx.insert(clinicServices).values(values).returning();
  return row!;
}

export async function getClinicService(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(clinicServices)
    .where(and(eq(clinicServices.organizationId, organizationId), eq(clinicServices.id, id)));
  return row;
}

export async function listClinicServices(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(clinicServices)
    .where(eq(clinicServices.organizationId, organizationId))
    .orderBy(asc(clinicServices.name), asc(clinicServices.id));
}

export async function updateClinicService(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof clinicServices.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(clinicServices)
    .set({ ...input.set, version: sql`${clinicServices.version} + 1` })
    .where(
      and(
        eq(clinicServices.organizationId, input.organizationId),
        eq(clinicServices.id, input.id),
        eq(clinicServices.version, input.version),
      ),
    )
    .returning();
  return row;
}

// Practitioners ---------------------------------------------------------------

export async function insertPractitioner(
  tx: Transaction,
  values: typeof clinicPractitioners.$inferInsert,
) {
  const [row] = await tx.insert(clinicPractitioners).values(values).returning();
  return row!;
}

export async function getPractitioner(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(clinicPractitioners)
    .where(
      and(eq(clinicPractitioners.organizationId, organizationId), eq(clinicPractitioners.id, id)),
    );
  return row;
}

export async function listPractitioners(tx: Transaction, organizationId: string) {
  return tx
    .select()
    .from(clinicPractitioners)
    .where(eq(clinicPractitioners.organizationId, organizationId))
    .orderBy(asc(clinicPractitioners.displayName), asc(clinicPractitioners.id));
}

export async function updatePractitioner(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof clinicPractitioners.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(clinicPractitioners)
    .set({ ...input.set, version: sql`${clinicPractitioners.version} + 1` })
    .where(
      and(
        eq(clinicPractitioners.organizationId, input.organizationId),
        eq(clinicPractitioners.id, input.id),
        eq(clinicPractitioners.version, input.version),
      ),
    )
    .returning();
  return row;
}

// Appointments ------------------------------------------------------------------

export async function insertAppointment(
  tx: Transaction,
  values: typeof clinicAppointments.$inferInsert,
) {
  const [row] = await tx.insert(clinicAppointments).values(values).returning();
  return row!;
}

export async function getAppointment(
  tx: Transaction,
  organizationId: string,
  id: string,
  options: { forUpdate?: boolean } = {},
) {
  const query = tx
    .select()
    .from(clinicAppointments)
    .where(
      and(eq(clinicAppointments.organizationId, organizationId), eq(clinicAppointments.id, id)),
    );
  const [row] = options.forUpdate ? await query.for('update') : await query;
  return row;
}

export async function listAppointments(
  tx: Transaction,
  organizationId: string,
  filter: {
    from?: string | undefined;
    to?: string | undefined;
    practitionerId?: string | undefined;
    patientId?: string | undefined;
    status?: AppointmentStatus | undefined;
    limit: number;
  },
) {
  return tx
    .select()
    .from(clinicAppointments)
    .where(
      and(
        eq(clinicAppointments.organizationId, organizationId),
        filter.from
          ? sql`${clinicAppointments.startsAt} >= ${filter.from}::timestamptz`
          : sql`true`,
        filter.to ? sql`${clinicAppointments.startsAt} < ${filter.to}::timestamptz` : sql`true`,
        filter.practitionerId
          ? eq(clinicAppointments.practitionerId, filter.practitionerId)
          : sql`true`,
        filter.patientId ? eq(clinicAppointments.patientId, filter.patientId) : sql`true`,
        filter.status ? eq(clinicAppointments.status, filter.status) : sql`true`,
      ),
    )
    .orderBy(asc(clinicAppointments.startsAt), desc(clinicAppointments.id))
    .limit(filter.limit);
}

export async function updateAppointment(
  tx: Transaction,
  input: {
    organizationId: string;
    id: string;
    version: number;
    set: Partial<typeof clinicAppointments.$inferInsert>;
  },
) {
  const [row] = await tx
    .update(clinicAppointments)
    .set({ ...input.set, version: sql`${clinicAppointments.version} + 1` })
    .where(
      and(
        eq(clinicAppointments.organizationId, input.organizationId),
        eq(clinicAppointments.id, input.id),
        eq(clinicAppointments.version, input.version),
      ),
    )
    .returning();
  return row;
}

/** Counts by status and practitioner for a period (no personal data). */
export async function appointmentCounts(
  tx: Transaction,
  organizationId: string,
  from: string,
  to: string,
) {
  const result = await tx.execute<{
    practitioner_id: string;
    day: string;
    status: AppointmentStatus;
    n: number;
  }>(sql`
    SELECT practitioner_id, to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, status,
           count(*)::int AS n
      FROM clinic_appointments
     WHERE organization_id = ${organizationId}
       AND starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
     GROUP BY 1, 2, 3
     ORDER BY 2, 1, 3`);
  return result.rows;
}

export async function serviceRevenue(
  tx: Transaction,
  organizationId: string,
  from: string,
  to: string,
) {
  const result = await tx.execute<{
    service_id: string;
    completed: number;
    billed: number;
    value: string;
    billed_value: string;
  }>(sql`
    SELECT service_id, count(*)::int AS completed,
           count(invoice_id)::int AS billed, sum(price)::text AS value,
           coalesce(sum(price) FILTER (WHERE invoice_id IS NOT NULL), 0)::text AS billed_value
      FROM clinic_appointments
     WHERE organization_id = ${organizationId} AND status = 'COMPLETED'
       AND starts_at >= ${from}::timestamptz AND starts_at < ${to}::timestamptz
     GROUP BY service_id`);
  return result.rows;
}

/** Locks the practitioner row, serializing bookings for that practitioner. */
export async function lockPractitioner(tx: Transaction, organizationId: string, id: string) {
  const [row] = await tx
    .select()
    .from(clinicPractitioners)
    .where(
      and(eq(clinicPractitioners.organizationId, organizationId), eq(clinicPractitioners.id, id)),
    )
    .for('update');
  return row;
}

/** Another live appointment of the practitioner overlapping [startsAt, endsAt). */
export async function overlappingAppointment(
  tx: Transaction,
  input: {
    organizationId: string;
    practitionerId: string;
    startsAt: Date;
    endsAt: Date;
    excludeId?: string | undefined;
  },
) {
  const [row] = await tx
    .select({ id: clinicAppointments.id })
    .from(clinicAppointments)
    .where(
      and(
        eq(clinicAppointments.organizationId, input.organizationId),
        eq(clinicAppointments.practitionerId, input.practitionerId),
        sql`${clinicAppointments.status} IN ('BOOKED', 'CHECKED_IN')`,
        sql`${clinicAppointments.startsAt} < ${input.endsAt.toISOString()}::timestamptz`,
        sql`${clinicAppointments.endsAt} > ${input.startsAt.toISOString()}::timestamptz`,
        input.excludeId ? sql`${clinicAppointments.id} <> ${input.excludeId}` : sql`true`,
      ),
    )
    .limit(1);
  return row;
}
