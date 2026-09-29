import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;
export type JobStatus = (typeof jobStatuses)[number];

/** Background jobs (Decision 76; S5-14..S5-19). Migration 0013. */
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  type: text('type').notNull(),
  jobKey: text('job_key'),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<JobStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedBy: text('locked_by'),
  progress: integer('progress').notNull().default(0),
  progressMessage: text('progress_message'),
  result: jsonb('result').$type<Record<string, unknown>>(),
  lastError: text('last_error'),
  requiredPermission: text('required_permission'),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
});
