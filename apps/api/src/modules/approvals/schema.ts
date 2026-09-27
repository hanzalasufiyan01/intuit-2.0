import { integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
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

export interface PolicySnapshotStep {
  order: number;
  name: string;
  requiredApprovals: number;
  roleIds: string[];
  membershipIds: string[];
}
export interface PolicySnapshot {
  steps: PolicySnapshotStep[];
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
