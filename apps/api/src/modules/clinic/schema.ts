import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Clinic tables (migration 0069, FP-27, ADR 0013): administrative and billing data only. */

export const appointmentStatuses = [
  'BOOKED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED',
  'NO_SHOW',
] as const;
export type AppointmentStatus = (typeof appointmentStatuses)[number];
export const sexValues = ['female', 'male', 'other', 'undisclosed'] as const;

export const clinicNumberSequences = pgTable('clinic_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['patient', 'appointment'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const clinicPatients = pgTable('clinic_patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  displayName: text('display_name').notNull(),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  sex: text('sex', { enum: sexValues }),
  phone: text('phone'),
  email: text('email'),
  nationalId: text('national_id'),
  billingCustomerId: uuid('billing_customer_id'),
  status: text('status', { enum: ['ACTIVE', 'ANONYMIZED'] })
    .notNull()
    .default('ACTIVE'),
  anonymizedAt: timestamptz('anonymized_at'),
  anonymizedByUserId: uuid('anonymized_by_user_id'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const clinicServices = pgTable('clinic_services', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  salesItemId: uuid('sales_item_id'),
  price: numeric('price', { precision: 28, scale: 4 }).notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const clinicPractitioners = pgTable('clinic_practitioners', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  displayName: text('display_name').notNull(),
  specialty: text('specialty').notNull().default(''),
  userId: uuid('user_id'),
  isActive: boolean('is_active').notNull().default(true),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const clinicAppointments = pgTable('clinic_appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  patientId: uuid('patient_id').notNull(),
  practitionerId: uuid('practitioner_id').notNull(),
  serviceId: uuid('service_id').notNull(),
  startsAt: timestamptz('starts_at').notNull(),
  endsAt: timestamptz('ends_at').notNull(),
  status: text('status', { enum: appointmentStatuses }).notNull().default('BOOKED'),
  note: text('note').notNull().default(''),
  price: numeric('price', { precision: 28, scale: 4 }).notNull(),
  cancelReason: text('cancel_reason'),
  invoiceId: uuid('invoice_id'),
  billedAt: timestamptz('billed_at'),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});
