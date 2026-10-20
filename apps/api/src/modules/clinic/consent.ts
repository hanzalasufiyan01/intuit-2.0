import { and, asc, eq, sql } from 'drizzle-orm';
import { date, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../database/client.js';
import { timestamptz } from '../../database/column-types.js';

/**
 * Consent register and retention setting (migration 0086, ADR 0013 addendum). The wording is the
 * organization's own; the register is append-only and holds no personal data.
 */

export const clinicConsentEvents = pgTable('clinic_consent_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  purpose: text('purpose').notNull(),
  wording: text('wording').notNull().default(''),
  action: text('action', { enum: ['granted', 'withdrawn'] }).notNull(),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  recordedByUserId: uuid('recorded_by_user_id').notNull(),
  recordedAt: timestamptz('recorded_at').notNull(),
});

export const clinicSettings = pgTable('clinic_settings', {
  organizationId: uuid('organization_id').primaryKey(),
  retentionYears: integer('retention_years'),
  version: integer('version').notNull().default(1),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export type ConsentEvent = typeof clinicConsentEvents.$inferSelect;

export async function listConsentEvents(
  tx: Transaction,
  organizationId: string,
  patientId: string,
) {
  return tx
    .select()
    .from(clinicConsentEvents)
    .where(
      and(
        eq(clinicConsentEvents.organizationId, organizationId),
        eq(clinicConsentEvents.patientId, patientId),
      ),
    )
    .orderBy(asc(clinicConsentEvents.recordedAt), asc(clinicConsentEvents.id));
}

export async function insertConsentEvent(
  tx: Transaction,
  values: typeof clinicConsentEvents.$inferInsert,
) {
  const [row] = await tx.insert(clinicConsentEvents).values(values).returning();
  return row!;
}

export async function getClinicSettings(tx: Transaction, organizationId: string) {
  const [row] = await tx
    .select()
    .from(clinicSettings)
    .where(eq(clinicSettings.organizationId, organizationId));
  return row;
}

/** Creates or updates the settings row; returns undefined on a version conflict. */
export async function saveClinicSettings(
  tx: Transaction,
  input: {
    organizationId: string;
    retentionYears: number | null;
    version: number;
    userId: string;
    at: Date;
  },
) {
  const existing = await getClinicSettings(tx, input.organizationId);
  if (!existing) {
    if (input.version !== 0) return undefined;
    const [row] = await tx
      .insert(clinicSettings)
      .values({
        organizationId: input.organizationId,
        retentionYears: input.retentionYears,
        updatedByUserId: input.userId,
        updatedAt: input.at,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  }
  const [row] = await tx
    .update(clinicSettings)
    .set({
      retentionYears: input.retentionYears,
      version: sql`${clinicSettings.version} + 1`,
      updatedByUserId: input.userId,
      updatedAt: input.at,
    })
    .where(
      and(
        eq(clinicSettings.organizationId, input.organizationId),
        eq(clinicSettings.version, input.version),
      ),
    )
    .returning();
  return row;
}

/**
 * Active patients with no activity (last change, or the end of their latest appointment) before
 * the cutoff. Oldest first. Only identifiers the reviewer needs.
 */
export async function listPatientsPastRetention(
  tx: Transaction,
  organizationId: string,
  cutoff: Date,
  limit: number,
) {
  const result = await tx.execute(sql`
    SELECT p.id, p.number, p.display_name AS "displayName",
           GREATEST(p.updated_at, COALESCE(MAX(a.ends_at), p.updated_at)) AS "lastActivity"
      FROM clinic_patients p
      LEFT JOIN clinic_appointments a
        ON a.patient_id = p.id AND a.organization_id = p.organization_id
     WHERE p.organization_id = ${organizationId} AND p.status = 'ACTIVE'
     GROUP BY p.id
    HAVING GREATEST(p.updated_at, COALESCE(MAX(a.ends_at), p.updated_at)) < ${cutoff.toISOString()}::timestamptz
     ORDER BY "lastActivity" ASC, p.id ASC
     LIMIT ${limit}`);
  return (
    result.rows as {
      id: string;
      number: string;
      displayName: string;
      lastActivity: Date | string;
    }[]
  ).map((r) => ({
    id: r.id,
    number: r.number,
    displayName: r.displayName,
    lastActivity: new Date(r.lastActivity).toISOString(),
  }));
}
