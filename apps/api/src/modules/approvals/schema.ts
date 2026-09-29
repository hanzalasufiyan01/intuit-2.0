import {
  char,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamptz } from '../../database/column-types.js';

export const approvalPolicies = pgTable('approval_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  actionKey: text('action_key').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

export const approvalPolicySteps = pgTable('approval_policy_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  policyId: uuid('policy_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  name: text('name').notNull(),
  requiredApprovals: integer('required_approvals').notNull(),
  // S10 (Decisions 22, 56, 77): optional conditions; none set = the step always applies.
  minBaseAmount: numeric('min_base_amount', { precision: 28, scale: 4 }),
  maxBaseAmount: numeric('max_base_amount', { precision: 28, scale: 4 }),
  transactionTypes: text('transaction_types').array(),
  thresholdCurrency: char('threshold_currency', { length: 3 }),
});

export const approvalStepEligibleRoles = pgTable(
  'approval_step_eligible_roles',
  {
    stepId: uuid('step_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    roleId: uuid('role_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stepId, t.roleId] })],
);

export const approvalStepEligibleMembers = pgTable(
  'approval_step_eligible_members',
  {
    stepId: uuid('step_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    membershipId: uuid('membership_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stepId, t.membershipId] })],
);

/**
 * Step conditions (S10-01). Amounts are decimal strings in `thresholdCurrency` (the base currency
 * when the policy was saved): `minBaseAmount` inclusive, `maxBaseAmount` exclusive. Null means the
 * condition is not set.
 */
export interface StepConditions {
  minBaseAmount: string | null;
  maxBaseAmount: string | null;
  transactionTypes: string[] | null;
  thresholdCurrency: string | null;
}

export interface PolicySnapshotStep {
  order: number;
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
  /** Absent on requests created before S10 (their steps were unconditional). */
  conditions?: StepConditions;
}

/** Facts of the subject, derived on the server by the registering module (S10-02, S10-03). */
export interface ApprovalFacts {
  transactionType: string;
  /** Base-currency equivalent at the document rate (Decision 56); null when not applicable. */
  baseAmount: string | null;
  baseCurrency: string | null;
}

export interface PolicySnapshot {
  /** The matching steps only (Decision 77, S10-04), with their policy step numbers. */
  steps: PolicySnapshotStep[];
  /** S10: the facts the steps were matched against, and when. */
  facts?: ApprovalFacts;
  evaluatedAt?: string;
  policyUpdatedAt?: string;
}

export const approvalRequestStatuses = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type ApprovalRequestStatus = (typeof approvalRequestStatuses)[number];

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  actionKey: text('action_key').notNull(),
  subjectType: text('subject_type').notNull(),
  subjectId: uuid('subject_id').notNull(),
  policySnapshot: jsonb('policy_snapshot').$type<PolicySnapshot>().notNull(),
  status: text('status', { enum: approvalRequestStatuses }).notNull().default('pending'),
  requestedByUserId: uuid('requested_by_user_id').notNull(),
  excludedUserIds: uuid('excluded_user_ids').array().notNull().default([]),
  reason: text('reason'),
  createdAt: timestamptz('created_at').notNull(),
  resolvedAt: timestamptz('resolved_at'),
});

export const approvalDecisions = pgTable('approval_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  requestId: uuid('request_id').notNull(),
  stepOrder: integer('step_order').notNull(),
  approverMembershipId: uuid('approver_membership_id').notNull(),
  approverUserId: uuid('approver_user_id').notNull(),
  decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
  comment: text('comment'),
  decidedAt: timestamptz('decided_at').notNull(),
});
