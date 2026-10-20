import { boolean, date, integer, numeric, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

/** Project tables (migration 0067, FP-26). */

const money = (name: string) => numeric(name, { precision: 28, scale: 4 });

export const projectStatuses = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'] as const;
export type ProjectStatus = (typeof projectStatuses)[number];
export const billingMethods = ['fixed', 'time_and_materials', 'non_billable'] as const;
export type BillingMethod = (typeof billingMethods)[number];
export const timeEntryStatuses = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'BILLED'] as const;
export type TimeEntryStatus = (typeof timeEntryStatuses)[number];

export const projectNumberSequences = pgTable('project_number_sequences', {
  organizationId: uuid('organization_id').notNull(),
  documentType: text('document_type', { enum: ['project'] }).notNull(),
  prefix: text('prefix').notNull().default(''),
  minDigits: integer('min_digits').notNull().default(5),
  nextNumber: numeric('next_number', { precision: 20, scale: 0 }).notNull().default('1'),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  number: text('number').notNull(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  customerId: uuid('customer_id'),
  status: text('status', { enum: projectStatuses }).notNull().default('ACTIVE'),
  billingMethod: text('billing_method', { enum: billingMethods })
    .notNull()
    .default('time_and_materials'),
  startDate: date('start_date', { mode: 'string' }),
  endDate: date('end_date', { mode: 'string' }),
  budgetAmount: money('budget_amount'),
  budgetHours: numeric('budget_hours', { precision: 12, scale: 2 }),
  defaultBillRate: money('default_bill_rate').notNull().default('0'),
  dimensionValueId: uuid('dimension_value_id').notNull(),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const projectMembers = pgTable('project_members', {
  organizationId: uuid('organization_id').notNull(),
  projectId: uuid('project_id').notNull(),
  userId: uuid('user_id').notNull(),
  billRate: money('bill_rate'),
  costRate: money('cost_rate').notNull().default('0'),
});

export const projectTasks = pgTable('project_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  projectId: uuid('project_id').notNull(),
  name: text('name').notNull(),
  status: text('status', { enum: ['OPEN', 'DONE'] })
    .notNull()
    .default('OPEN'),
  budgetHours: numeric('budget_hours', { precision: 12, scale: 2 }),
  version: integer('version').notNull().default(1),
  createdByUserId: uuid('created_by_user_id').notNull(),
  createdAt: timestamptz('created_at').notNull(),
  updatedByUserId: uuid('updated_by_user_id'),
  updatedAt: timestamptz('updated_at').notNull(),
});

export const projectTimeEntries = pgTable('project_time_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id'),
  userId: uuid('user_id').notNull(),
  workDate: date('work_date', { mode: 'string' }).notNull(),
  hours: numeric('hours', { precision: 6, scale: 2 }).notNull(),
  description: text('description').notNull(),
  billable: boolean('billable').notNull(),
  billRate: money('bill_rate').notNull(),
  costRate: money('cost_rate').notNull(),
  status: text('status', { enum: timeEntryStatuses }).notNull().default('DRAFT'),
  submittedAt: timestamptz('submitted_at'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamptz('decided_at'),
  rejectReason: text('reject_reason'),
  invoiceId: uuid('invoice_id'),
  billedAt: timestamptz('billed_at'),
  version: integer('version').notNull().default(1),
  createdAt: timestamptz('created_at').notNull(),
  updatedAt: timestamptz('updated_at').notNull(),
});
